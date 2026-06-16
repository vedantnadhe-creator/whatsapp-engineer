// ============================================================
// sprint_sheet.js — Build a sprint's data into spreadsheet grids,
// parse an uploaded workbook back into records, and upsert those
// records into the store (deterministic, idempotent by ID column).
//
// Used by the Open-in-Sheet / Template / Upload endpoints. The actual
// Google API calls live in sheets_service.js; this module is pure data
// + store access so it is testable without any credentials.
// ============================================================

import XLSX from 'xlsx';
import {
    TABS,
    COLUMNS,
    headersFor,
    recordsFromGrid,
    detectTab,
    normalizeType,
    normalizeDevStatus,
    normalizeQaStatus,
    normalizeSeverity,
    normalizeBugStatus,
    normalizeTcStatus,
    normalizeDate,
} from './sheet_schema.js';

// ── User resolution ───────────────────────────────────────────────────
// Build lookups so "Dev"/"QA Owner"/"Feature" cells can be a name, email or id.
const buildUserIndex = (store) => {
    const users = store.getAllUsers ? store.getAllUsers() : [];
    const byId = new Map();
    const byName = new Map();
    const byEmail = new Map();
    for (const u of users) {
        byId.set(u.id, u);
        if (u.display_name) byName.set(String(u.display_name).trim().toLowerCase(), u);
        if (u.email) byEmail.set(String(u.email).trim().toLowerCase(), u);
    }
    return { byId, byName, byEmail };
};

const resolveUserId = (idx, raw) => {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (idx.byId.has(s)) return s;
    const lower = s.toLowerCase();
    return idx.byEmail.get(lower)?.id || idx.byName.get(lower)?.id || null;
};

const userLabel = (idx, id) => {
    if (!id) return '';
    const u = idx.byId.get(id);
    return u ? (u.display_name || u.email || id) : '';
};

// ── Export: sprint → grids ────────────────────────────────────────────
// Returns { [tabName]: arrayOfArrays } with a header row + one row per record.
export const buildSprintGrids = (store, sprintId) => {
    const idx = buildUserIndex(store);
    const all = store.getIssuesBySprint(sprintId) || [];
    const features = all.filter((i) => i.category !== 'chat' && !i.parent_issue_id && !i.is_backlog);

    const featureRows = [];
    const subtaskRows = [];
    const bugRows = [];
    const tcRows = [];

    for (const f of features) {
        const tcs = store.getTestCasesByIssue(f.id) || [];
        const tcDone = tcs.filter((t) => t.status === 'pass').length;
        featureRows.push({
            id: f.id,
            platform: f.platform || '',
            title: f.title || '',
            description: f.description || '',
            type: f.type || 'feature',
            dev: userLabel(idx, f.assigned_to),
            qa_owner: userLabel(idx, f.qa_owner),
            dev_status: f.dev_status || 'todo',
            qa_status: f.qa_status || '',
            deadline: f.deadline || '',
            qa_comments: f.qa_comments || '',
            open_bugs: f.open_bugs || 0,
            critical_bugs: f.critical_bugs || 0,
            tc_count: tcs.length,
            tc_done: tcDone,
            done_pct: store.featureCompletion ? store.featureCompletion(f) : 0,
        });

        for (const s of store.getSubtasks(f.id) || []) {
            subtaskRows.push({
                id: s.id,
                parent: f.title || f.id,
                title: s.title || '',
                description: s.description || '',
                type: s.type || 'task',
                dev: userLabel(idx, s.assigned_to),
                dev_status: s.dev_status || 'todo',
                deadline: s.deadline || '',
            });
        }
        for (const b of store.getBugsByIssue(f.id) || []) {
            bugRows.push({
                id: b.id,
                feature: f.title || f.id,
                title: b.title || '',
                description: b.description || '',
                severity: b.severity || 'normal',
                status: b.status || 'open',
            });
        }
        for (const t of tcs) {
            tcRows.push({
                id: t.id,
                feature: f.title || f.id,
                title: t.title || '',
                steps: t.steps || '',
                expected: t.expected || '',
                status: t.status || 'pending',
            });
        }
    }

    const toGrid = (tab, records) => {
        const cols = COLUMNS[tab];
        const grid = [headersFor(tab)];
        for (const rec of records) grid.push(cols.map((c) => rec[c.key] ?? ''));
        return grid;
    };

    return {
        [TABS.FEATURES]: toGrid(TABS.FEATURES, featureRows),
        [TABS.SUBTASKS]: toGrid(TABS.SUBTASKS, subtaskRows),
        [TABS.BUGS]: toGrid(TABS.BUGS, bugRows),
        [TABS.TEST_CASES]: toGrid(TABS.TEST_CASES, tcRows),
        [TABS.LEGEND]: buildLegendGrid(),
    };
};

// Human-readable instructions tab so testers know the rules + allowed values.
export const buildLegendGrid = () => {
    const grid = [
        ['PluginLive — Sprint Board Sheet'],
        [''],
        ['How to use'],
        ['1. Fill rows under each tab. Leave the ID column blank to CREATE a new row.'],
        ['2. Keep the ID as-is to UPDATE an existing row when you re-upload.'],
        ['3. Removing a row here does NOT delete it in the app (delete from the board).'],
        ['4. Re-upload this sheet (File ▸ Download ▸ .xlsx) on the Sprint Board to apply.'],
        [''],
        ['Allowed values'],
        ['Type', COLUMNS[TABS.FEATURES].find((c) => c.key === 'type').options.join(' / ')],
        ['Dev Status', COLUMNS[TABS.FEATURES].find((c) => c.key === 'dev_status').options.join(' / ')],
        ['QA Status', '(blank) / testing / pass / fail'],
        ['Bug Severity', COLUMNS[TABS.BUGS].find((c) => c.key === 'severity').options.join(' / ')],
        ['Bug Status', COLUMNS[TABS.BUGS].find((c) => c.key === 'status').options.join(' / ')],
        ['Test Case Status', COLUMNS[TABS.TEST_CASES].find((c) => c.key === 'status').options.join(' / ')],
        ['Deadline', 'YYYY-MM-DD'],
        [''],
        ['Note', 'Open Bugs / Critical / TC Count / Done % are auto-computed and ignored on upload.'],
    ];
    return grid;
};

// Empty template grids (headers + Legend only) for a fresh start.
export const buildTemplateGrids = () => ({
    [TABS.FEATURES]: [headersFor(TABS.FEATURES)],
    [TABS.SUBTASKS]: [headersFor(TABS.SUBTASKS)],
    [TABS.BUGS]: [headersFor(TABS.BUGS)],
    [TABS.TEST_CASES]: [headersFor(TABS.TEST_CASES)],
    [TABS.LEGEND]: buildLegendGrid(),
});

// Render { tabName: grid } to an .xlsx Buffer (fallback when Google Sheets
// is not configured — the user still gets a real spreadsheet to open/edit).
export const gridsToXlsxBuffer = (grids) => {
    const wb = XLSX.utils.book_new();
    for (const [name, grid] of Object.entries(grids)) {
        const ws = XLSX.utils.aoa_to_sheet(grid);
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── Upload: workbook buffer → raw records ─────────────────────────────
// Returns { features, subtasks, bugs, testCases } as arrays of raw records.
export const parseWorkbookBuffer = (buffer) => {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const out = { features: [], subtasks: [], bugs: [], testCases: [] };
    const tabToKey = {
        [TABS.FEATURES]: 'features',
        [TABS.SUBTASKS]: 'subtasks',
        [TABS.BUGS]: 'bugs',
        [TABS.TEST_CASES]: 'testCases',
    };
    for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
        if (!grid.length) continue;
        const tab = detectTab(sheetName, grid[0]);
        if (!tab || !tabToKey[tab]) continue;
        out[tabToKey[tab]].push(...recordsFromGrid(tab, grid));
    }
    return out;
};

// ── Import: raw records → store (idempotent upsert by ID) ─────────────
export const importSprintData = (store, sprintId, parsed, userId) => {
    const idx = buildUserIndex(store);
    const summary = {
        features: { created: 0, updated: 0 },
        subtasks: { created: 0, updated: 0 },
        bugs: { created: 0, updated: 0 },
        testCases: { created: 0, updated: 0 },
        warnings: [],
    };

    // Resolve a feature reference (id or exact title) to an existing/just-created issue id.
    const featureKeyToId = new Map();
    const registerFeatureKey = (issue) => {
        featureKeyToId.set(issue.id, issue.id);
        if (issue.title) featureKeyToId.set(String(issue.title).trim().toLowerCase(), issue.id);
    };
    // Seed with all current top-level features in the sprint so cross-tab refs resolve.
    for (const i of store.getIssuesBySprint(sprintId) || []) {
        if (!i.parent_issue_id) registerFeatureKey(i);
    }
    const resolveFeatureId = (raw) => {
        const s = String(raw ?? '').trim();
        if (!s) return null;
        if (featureKeyToId.has(s)) return featureKeyToId.get(s);
        return featureKeyToId.get(s.toLowerCase()) || null;
    };

    // ── Features ──
    for (const rec of parsed.features || []) {
        const title = String(rec.title ?? '').trim();
        const id = String(rec.id ?? '').trim();
        if (!title && !id) continue;
        const fields = {
            platform: String(rec.platform ?? '').trim(),
            description: String(rec.description ?? '').trim(),
            type: normalizeType(rec.type),
            assigned_to: resolveUserId(idx, rec.dev),
            qa_owner: resolveUserId(idx, rec.qa_owner) || '',
            dev_status: normalizeDevStatus(rec.dev_status),
            qa_status: normalizeQaStatus(rec.qa_status),
            deadline: normalizeDate(rec.deadline) || null,
            qa_comments: String(rec.qa_comments ?? '').trim(),
        };
        const existing = id ? store.getIssue(id) : null;
        if (existing) {
            const upd = { ...fields, sprint_id: sprintId, is_backlog: 0 };
            if (title) upd.title = title;
            store.updateIssue(id, upd);
            registerFeatureKey(store.getIssue(id));
            summary.features.updated++;
        } else {
            if (!title) { summary.warnings.push(`Feature with ID "${id}" not found and no title to create.`); continue; }
            const issue = store.createIssue({
                title,
                description: fields.description,
                createdBy: userId,
                sprintId,
                type: fields.type,
                platform: fields.platform,
                qaOwner: fields.qa_owner,
                assignedTo: fields.assigned_to,
            });
            store.updateIssue(issue.id, {
                dev_status: fields.dev_status,
                qa_status: fields.qa_status,
                deadline: fields.deadline,
                qa_comments: fields.qa_comments,
            });
            registerFeatureKey(store.getIssue(issue.id));
            summary.features.created++;
        }
    }

    // ── Subtasks ──
    for (const rec of parsed.subtasks || []) {
        const title = String(rec.title ?? '').trim();
        const id = String(rec.id ?? '').trim();
        if (!title && !id) continue;
        const parentId = resolveFeatureId(rec.parent);
        const existing = id ? store.getIssue(id) : null;
        if (!parentId && !existing) {
            summary.warnings.push(`Subtask "${title || id}" skipped — parent "${rec.parent}" not found.`);
            continue;
        }
        const fields = {
            description: String(rec.description ?? '').trim(),
            type: normalizeType(rec.type),
            assigned_to: resolveUserId(idx, rec.dev),
            dev_status: normalizeDevStatus(rec.dev_status),
            deadline: normalizeDate(rec.deadline) || null,
        };
        if (existing) {
            const upd = { ...fields };
            if (title) upd.title = title;
            if (parentId) { upd.parent_issue_id = parentId; upd.sprint_id = sprintId; }
            store.updateIssue(id, upd);
            summary.subtasks.updated++;
        } else {
            const parent = store.getIssue(parentId);
            const sub = store.createIssue({
                title,
                description: fields.description,
                createdBy: userId,
                sprintId: parent?.sprint_id || sprintId,
                type: fields.type,
                platform: parent?.platform || '',
                assignedTo: fields.assigned_to,
                parentIssueId: parentId,
            });
            store.updateIssue(sub.id, { dev_status: fields.dev_status, deadline: fields.deadline });
            summary.subtasks.created++;
        }
    }

    // ── Bugs ──
    for (const rec of parsed.bugs || []) {
        const title = String(rec.title ?? '').trim();
        const id = String(rec.id ?? '').trim();
        if (!title && !id) continue;
        const existing = id && store.getBug ? store.getBug(id) : null;
        const featureId = resolveFeatureId(rec.feature) || existing?.issue_id || null;
        if (!featureId) {
            summary.warnings.push(`Bug "${title || id}" skipped — feature "${rec.feature}" not found.`);
            continue;
        }
        const fields = {
            title,
            description: String(rec.description ?? '').trim(),
            severity: normalizeSeverity(rec.severity),
            status: normalizeBugStatus(rec.status),
        };
        if (existing) {
            store.updateBug(id, fields);
            summary.bugs.updated++;
        } else {
            const bug = store.createBug({ issueId: featureId, title, description: fields.description, severity: fields.severity, createdBy: userId });
            if (fields.status !== 'open') store.updateBug(bug.id, { status: fields.status });
            summary.bugs.created++;
        }
    }

    // ── Test cases ──
    for (const rec of parsed.testCases || []) {
        const title = String(rec.title ?? '').trim();
        const id = String(rec.id ?? '').trim();
        if (!title && !id) continue;
        const existing = id && store.getTestCase ? store.getTestCase(id) : null;
        const featureId = resolveFeatureId(rec.feature) || existing?.issue_id || null;
        if (!featureId) {
            summary.warnings.push(`Test case "${title || id}" skipped — feature "${rec.feature}" not found.`);
            continue;
        }
        const fields = {
            title,
            steps: String(rec.steps ?? '').trim(),
            expected: String(rec.expected ?? '').trim(),
            status: normalizeTcStatus(rec.status),
        };
        if (existing) {
            store.updateTestCase(id, fields);
            summary.testCases.updated++;
        } else {
            store.createTestCase({ issueId: featureId, title, steps: fields.steps, expected: fields.expected, status: fields.status, source: 'sheet', createdBy: userId });
            summary.testCases.created++;
        }
    }

    return summary;
};
