// ============================================================
// sheet_schema.js — Canonical column schema for the Sprint Board
// spreadsheet (Open in Sheet / Template / Upload).
//
// One place defines the tabs, their headers, the allowed values and the
// row<->record mapping, so the Google export, the .xlsx template and the
// upload parser all stay in sync. Pure module — no external deps.
// ============================================================

// Worksheet (tab) names.
export const TABS = {
    FEATURES: 'Features',
    SUBTASKS: 'Subtasks',
    BUGS: 'Bugs',
    TEST_CASES: 'Test Cases',
    LEGEND: 'Legend',
};

// Allowed values, mirrored from SprintBoard.jsx so the sheet matches the board.
export const DEV_STATUS = ['todo', 'in_progress', 'dev_completed', 'done'];
export const QA_STATUS = ['', 'testing', 'pass', 'fail'];
export const TYPES = ['feature', 'task', 'bug', 'improvement'];
export const BUG_SEVERITY = ['normal', 'critical'];
export const BUG_STATUS = ['open', 'in_progress', 'fixed', 'wont_fix'];
export const TC_STATUS = ['pending', 'pass', 'fail'];

// Column headers per tab. Order here IS the column order in the sheet.
// Columns flagged `derived` are shown for presentability but ignored on import
// (the app recomputes them from the child tabs / lifecycle).
export const COLUMNS = {
    [TABS.FEATURES]: [
        { key: 'id', header: 'ID', help: 'Leave blank to create a new feature. Keep as-is to update.' },
        { key: 'platform', header: 'Platform' },
        { key: 'title', header: 'Title', required: true },
        { key: 'description', header: 'Description' },
        { key: 'type', header: 'Type', options: TYPES },
        { key: 'dev', header: 'Dev', help: 'Developer name or email.' },
        { key: 'qa_owner', header: 'QA Owner', help: 'Tester name or email.' },
        { key: 'dev_status', header: 'Dev Status', options: DEV_STATUS },
        { key: 'qa_status', header: 'QA Status', options: QA_STATUS },
        { key: 'deadline', header: 'Deadline', help: 'YYYY-MM-DD' },
        { key: 'qa_comments', header: 'QA Comments' },
        { key: 'open_bugs', header: 'Open Bugs', derived: true },
        { key: 'critical_bugs', header: 'Critical Bugs', derived: true },
        { key: 'tc_count', header: 'TC Count', derived: true },
        { key: 'tc_done', header: 'TC Done', derived: true },
        { key: 'done_pct', header: 'Done %', derived: true },
    ],
    [TABS.SUBTASKS]: [
        { key: 'id', header: 'ID', help: 'Leave blank to create. Keep as-is to update.' },
        { key: 'parent', header: 'Parent Feature', required: true, help: 'Parent feature ID or exact title.' },
        { key: 'title', header: 'Title', required: true },
        { key: 'description', header: 'Description' },
        { key: 'type', header: 'Type', options: TYPES },
        { key: 'dev', header: 'Dev' },
        { key: 'dev_status', header: 'Dev Status', options: DEV_STATUS },
        { key: 'deadline', header: 'Deadline', help: 'YYYY-MM-DD' },
    ],
    [TABS.BUGS]: [
        { key: 'id', header: 'ID', help: 'Leave blank to create. Keep as-is to update.' },
        { key: 'feature', header: 'Feature', required: true, help: 'Feature ID or exact title.' },
        { key: 'title', header: 'Title', required: true },
        { key: 'description', header: 'Description' },
        { key: 'severity', header: 'Severity', options: BUG_SEVERITY },
        { key: 'status', header: 'Status', options: BUG_STATUS },
    ],
    [TABS.TEST_CASES]: [
        { key: 'id', header: 'ID', help: 'Leave blank to create. Keep as-is to update.' },
        { key: 'feature', header: 'Feature', required: true, help: 'Feature ID or exact title.' },
        { key: 'title', header: 'Title', required: true },
        { key: 'steps', header: 'Steps' },
        { key: 'expected', header: 'Expected' },
        { key: 'status', header: 'Status', options: TC_STATUS },
    ],
};

export const headersFor = (tab) => COLUMNS[tab].map((c) => c.header);

// Map a header string to its column key for a tab (case/space tolerant).
const normHeader = (h) => String(h || '').trim().toLowerCase();
export const headerKeyMap = (tab) => {
    const map = {};
    for (const col of COLUMNS[tab]) {
        map[normHeader(col.header)] = col.key;
    }
    return map;
};

// ── Value normalizers (forgiving — testers type loosely) ──────────────
const pick = (val, allowed, fallback) => {
    const v = String(val ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return allowed.includes(v) ? v : fallback;
};

export const normalizeType = (v) => pick(v, TYPES, 'feature');
export const normalizeDevStatus = (v) => {
    const raw = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const alias = { not_started: 'todo', to_do: 'todo', wip: 'in_progress', inprogress: 'in_progress', complete: 'done', completed: 'done', dev_complete: 'dev_completed' };
    return pick(alias[raw] || raw, DEV_STATUS, 'todo');
};
export const normalizeQaStatus = (v) => {
    const raw = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!raw) return '';
    const alias = { passed: 'pass', failed: 'fail', in_testing: 'testing', test: 'testing' };
    return pick(alias[raw] || raw, QA_STATUS.filter(Boolean), '');
};
export const normalizeSeverity = (v) => {
    const raw = String(v ?? '').trim().toLowerCase();
    return raw.startsWith('crit') ? 'critical' : 'normal';
};
export const normalizeBugStatus = (v) => {
    const raw = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['closed', 'fixed', 'resolved', 'done'].includes(raw)) return 'fixed';
    if (["wont_fix", 'wontfix', 'rejected'].includes(raw)) return 'wont_fix';
    if (['in_progress', 'wip', 'fixing'].includes(raw)) return 'in_progress';
    return 'open';
};
export const normalizeTcStatus = (v) => pick(v, TC_STATUS, 'pending');

// ── Grid <-> records ──────────────────────────────────────────────────
// grid: array-of-arrays where grid[0] is the header row. Returns raw
// records keyed by column key (unknown headers dropped, empty rows skipped).
export const recordsFromGrid = (tab, grid) => {
    if (!Array.isArray(grid) || grid.length < 2) return [];
    const keyMap = headerKeyMap(tab);
    const headerKeys = (grid[0] || []).map((h) => keyMap[normHeader(h)] || null);
    const records = [];
    for (let r = 1; r < grid.length; r++) {
        const row = grid[r] || [];
        const rec = {};
        let hasValue = false;
        for (let c = 0; c < headerKeys.length; c++) {
            const key = headerKeys[c];
            if (!key) continue;
            const cell = row[c];
            if (cell !== undefined && cell !== null && String(cell).trim() !== '') hasValue = true;
            rec[key] = cell;
        }
        if (hasValue) records.push(rec);
    }
    return records;
};

// Best-effort: which tab is this sheet? Match by name, else by header overlap.
export const detectTab = (sheetName, headerRow = []) => {
    const name = normHeader(sheetName);
    for (const tab of Object.values(TABS)) {
        if (normHeader(tab) === name) return tab;
    }
    const headers = new Set((headerRow || []).map(normHeader));
    let best = null;
    let bestScore = 0;
    for (const tab of [TABS.FEATURES, TABS.SUBTASKS, TABS.BUGS, TABS.TEST_CASES]) {
        const score = COLUMNS[tab].reduce((s, col) => s + (headers.has(normHeader(col.header)) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; best = tab; }
    }
    return bestScore >= 2 ? best : null;
};

// Accepts YYYY-MM-DD, common locale dates, or a JS/Excel Date; returns YYYY-MM-DD or ''.
export const normalizeDate = (v) => {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
};
