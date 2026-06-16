// ============================================================
// sheets_service.js — Google Sheets / Drive integration for the
// Sprint Board (Open in Sheet, Template, read uploaded Google Sheet).
//
// Auth: a Google Cloud service account (Sheets API + Drive API enabled).
// Credentials come from config (file path or inline JSON). When not
// configured, isConfigured() is false and callers fall back to .xlsx.
// ============================================================

import fs from 'fs';
import { google } from 'googleapis';
import config from './config.js';
import {
    TABS,
    COLUMNS,
    recordsFromGrid,
    detectTab,
} from './sheet_schema.js';

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
];

let cachedClients = null;

const loadCredentials = () => {
    if (config.GOOGLE_SERVICE_ACCOUNT_JSON) {
        return JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON);
    }
    if (config.GOOGLE_SERVICE_ACCOUNT_FILE && fs.existsSync(config.GOOGLE_SERVICE_ACCOUNT_FILE)) {
        return JSON.parse(fs.readFileSync(config.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
    }
    return null;
};

export const isConfigured = () => loadCredentials() !== null;

const getClients = async () => {
    if (cachedClients) return cachedClients;
    const creds = loadCredentials();
    if (!creds) throw new Error('Google Sheets is not configured. Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON.');
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
    const authClient = await auth.getClient();
    cachedClients = {
        sheets: google.sheets({ version: 'v4', auth: authClient }),
        drive: google.drive({ version: 'v3', auth: authClient }),
    };
    return cachedClients;
};

// Pull a spreadsheet id out of a full URL or accept a bare id.
export const extractSpreadsheetId = (urlOrId) => {
    const s = String(urlOrId || '').trim();
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : s;
};

// Make the new sheet reachable: optionally move into a Drive folder, share with a
// configured email, and grant anyone-with-link write access (internal tool).
const shareSheet = async (drive, spreadsheetId) => {
    try {
        if (config.GOOGLE_SHEETS_SHARE_WITH) {
            await drive.permissions.create({
                fileId: spreadsheetId,
                supportsAllDrives: true,
                sendNotificationEmail: false,
                requestBody: { type: 'user', role: 'writer', emailAddress: config.GOOGLE_SHEETS_SHARE_WITH },
            });
        }
        await drive.permissions.create({
            fileId: spreadsheetId,
            supportsAllDrives: true,
            requestBody: { type: 'anyone', role: 'writer' },
        });
    } catch (err) {
        // Non-fatal: the sheet still exists; the owner can adjust sharing.
        console.error('[sheets] share failed:', err?.message || err);
    }
};

// Header-row formatting: bold + frozen so the sheet reads like a real template.
const formatRequests = (sheetIdByTitle) =>
    Object.entries(sheetIdByTitle)
        .filter(([title]) => title !== TABS.LEGEND)
        .flatMap(([, sheetId]) => ([
            {
                repeatCell: {
                    range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                    cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.96 } } },
                    fields: 'userEnteredFormat(textFormat,backgroundColor)',
                },
            },
            { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        ]));

// Create a spreadsheet from { tabName: arrayOfArrays } and return { url, spreadsheetId }.
export const createSpreadsheetFromGrids = async (title, grids) => {
    const { sheets, drive } = await getClients();
    const tabNames = Object.keys(grids);

    const created = await sheets.spreadsheets.create({
        requestBody: {
            properties: { title },
            sheets: tabNames.map((name) => ({ properties: { title: name } })),
        },
        fields: 'spreadsheetId,spreadsheetUrl,sheets.properties(sheetId,title)',
    });
    const spreadsheetId = created.data.spreadsheetId;
    const url = created.data.spreadsheetUrl;
    const sheetIdByTitle = {};
    for (const s of created.data.sheets) sheetIdByTitle[s.properties.title] = s.properties.sheetId;

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'RAW',
            data: tabNames.map((name) => ({ range: `'${name}'!A1`, values: grids[name] })),
        },
    });

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: formatRequests(sheetIdByTitle) },
    });

    if (config.GOOGLE_DRIVE_FOLDER_ID) {
        try {
            await drive.files.update({ fileId: spreadsheetId, addParents: config.GOOGLE_DRIVE_FOLDER_ID, supportsAllDrives: true, fields: 'id' });
        } catch (err) {
            console.error('[sheets] move to folder failed:', err?.message || err);
        }
    }
    await shareSheet(drive, spreadsheetId);
    return { url, spreadsheetId };
};

// Refresh an existing spreadsheet's tabs in place (clear + rewrite) so the
// "Open in Sheet" link for a sprint always points to one live sheet. Adds any
// missing tabs. Returns the spreadsheet URL.
export const updateSpreadsheetFromGrids = async (spreadsheetId, grids) => {
    const { sheets } = await getClients();
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetUrl,sheets.properties(sheetId,title)' });
    const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
    const tabNames = Object.keys(grids);

    const addRequests = tabNames
        .filter((name) => !existing.has(name))
        .map((name) => ({ addSheet: { properties: { title: name } } }));
    if (addRequests.length) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: addRequests } });
    }

    await sheets.spreadsheets.values.batchClear({ spreadsheetId, requestBody: { ranges: tabNames.map((t) => `'${t}'`) } });
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'RAW',
            data: tabNames.map((name) => ({ range: `'${name}'!A1`, values: grids[name] })),
        },
    });
    return meta.data.spreadsheetUrl;
};

// Read a spreadsheet's tabs back into raw records keyed like the upload parser:
// { features, subtasks, bugs, testCases }.
export const readSpreadsheetRecords = async (spreadsheetId) => {
    const { sheets } = await getClients();
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
    const titles = meta.data.sheets.map((s) => s.properties.title);

    const out = { features: [], subtasks: [], bugs: [], testCases: [] };
    const tabToKey = {
        [TABS.FEATURES]: 'features',
        [TABS.SUBTASKS]: 'subtasks',
        [TABS.BUGS]: 'bugs',
        [TABS.TEST_CASES]: 'testCases',
    };
    const wanted = titles.filter((t) => Object.keys(COLUMNS).includes(t) || true);
    const resp = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: wanted.map((t) => `'${t}'`),
    });
    const valueRanges = resp.data.valueRanges || [];
    for (let i = 0; i < wanted.length; i++) {
        const grid = valueRanges[i]?.values || [];
        if (!grid.length) continue;
        const tab = detectTab(wanted[i], grid[0]);
        if (!tab || !tabToKey[tab]) continue;
        out[tabToKey[tab]].push(...recordsFromGrid(tab, grid));
    }
    return out;
};
