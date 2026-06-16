import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const API_BASE = window.location.pathname.startsWith('/sessions') ? '/sessions' : '';

// Dedup: reject duplicate in-flight POST/PUT/DELETE requests to the same URL
const inflightMutations = new Map();

export async function apiFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const fullUrl = API_BASE + url;

  // For mutations, deduplicate — if identical request is in-flight, return its promise
  // Skip dedup for file uploads (each upload is unique)
  if (method !== 'GET' && !url.includes('/upload')) {
    const key = `${method}:${fullUrl}`;
    if (inflightMutations.has(key)) return inflightMutations.get(key);
    const promise = _doFetch(fullUrl, opts).finally(() => inflightMutations.delete(key));
    inflightMutations.set(key, promise);
    return promise;
  }

  return _doFetch(fullUrl, opts);
}

async function _doFetch(fullUrl, opts) {
  const res = await fetch(fullUrl, { credentials: 'include', ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.error || body.message || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function useGet(url, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const refresh = useCallback(() => {
    // Debounce rapid refresh calls (e.g. from polling)
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setError(null);
      apiFetch(url)
        .then(setData)
        .catch(setError)
        .finally(() => setLoading(false));
    }, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  useEffect(() => {
    // Initial load — no debounce
    setLoading(true);
    setError(null);
    apiFetch(url)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  return { data, loading, error, refresh };
}

// Hook for mutation actions — prevents double-click and exposes busy state
export function useAction(fn) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (...args) => {
    if (busy) return;
    setBusy(true);
    try {
      return await fn(...args);
    } finally {
      setBusy(false);
    }
  }, [fn, busy]);
  return [run, busy];
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

export function useStats() {
  const { data, loading, error, refresh } = useGet('/api/stats');
  return { stats: data, loading, error, refresh };
}

export function useCostStats() {
  const { data, loading, error, refresh } = useGet('/api/cost-stats');
  return { cost: data, loading, error, refresh };
}

// Parse + fetch a session's Claude transcript (terminal sessions: history view).
export async function getTranscript(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/transcript`);
}

// Pagination: `page` is the max page currently loaded. Lower pages stay in state
// so the list accumulates instead of being replaced on "Load more".
// When `q` (search query) changes, paging is reset and the list is re-fetched
// from page 1 with the query attached. q is debounced internally.
export function useSessions(page = 1, q = '') {
  const [pagesData, setPagesData] = useState({});
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, showAllSessions: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [debouncedQ, setDebouncedQ] = useState(q.trim());
  const pagesRef = useRef(pagesData);
  pagesRef.current = pagesData;
  const qRef = useRef(debouncedQ);
  qRef.current = debouncedQ;

  // Debounce q changes (250ms) so we don't fire a request on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const buildUrl = (p, query) => {
    const params = new URLSearchParams({ page: String(p) });
    if (query) params.set('q', query);
    return `/api/sessions?${params.toString()}`;
  };

  const fetchPage = useCallback(async (p, query) => {
    const data = await apiFetch(buildUrl(p, query));
    // Ignore stale responses if the query changed mid-flight
    if (query !== qRef.current) return data;
    setPagesData((prev) => ({ ...prev, [p]: data?.sessions ?? [] }));
    setMeta({
      total: data?.total ?? 0,
      totalPages: data?.totalPages ?? 1,
      showAllSessions: data?.showAllSessions ?? false,
    });
    return data;
  }, []);

  // When q changes, reset cached pages and reload from page 1
  useEffect(() => {
    setPagesData({});
    setLoading(true);
    fetchPage(1, debouncedQ)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [debouncedQ, fetchPage]);

  // When the requested max page grows, fetch only the newly requested page.
  useEffect(() => {
    if (page === 1) return;
    if (pagesRef.current[page]) return;
    setLoading(true);
    fetchPage(page, debouncedQ)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [page, debouncedQ, fetchPage]);

  // refresh() re-fetches all currently-loaded pages so polling updates status
  // without losing the user's scroll depth.
  const refresh = useCallback(async () => {
    const loaded = Object.keys(pagesRef.current).map(Number);
    const pages = loaded.length > 0 ? loaded : [1];
    try {
      await Promise.all(pages.map((p) => fetchPage(p, qRef.current)));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [fetchPage]);

  // Accumulated list: concat pages in order, dedupe by id (keep earliest occurrence).
  const sessions = useMemo(() => {
    const seen = new Set();
    const out = [];
    const pages = Object.keys(pagesData).map(Number).sort((a, b) => a - b);
    for (const p of pages) {
      for (const s of pagesData[p] || []) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
        }
      }
    }
    return out;
  }, [pagesData]);

  return {
    sessions,
    total: meta.total,
    totalPages: meta.totalPages,
    showAllSessions: meta.showAllSessions,
    loading,
    error,
    refresh,
  };
}

export function useSessionMessages(sessionId) {
  const { data, loading, error, refresh } = useGet(
    sessionId ? `/api/sessions/${sessionId}/messages` : null,
    [sessionId],
  );
  return { messages: data?.messages ?? data ?? [], loading, error, refresh };
}

export function useModels() {
  const { data, loading, error, refresh } = useGet('/api/models');
  return { models: data ?? [], loading, error, refresh };
}

export function usePhones() {
  const { data, loading, error, refresh } = useGet('/api/phones');

  const addPhone = useCallback(async (phone) => {
    const result = await apiFetch('/api/phones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(phone),
    });
    refresh();
    return result;
  }, [refresh]);

  const removePhone = useCallback(async (phoneId) => {
    await apiFetch(`/api/phones/${phoneId}`, { method: 'DELETE' });
    refresh();
  }, [refresh]);

  return { phones: data ?? [], loading, error, refresh, addPhone, removePhone };
}

export function useUsers() {
  const { data, loading, error, refresh } = useGet('/api/admin/users');

  const addUser = useCallback(async (userData) => {
    const result = await apiFetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    });
    refresh();
    return result;
  }, [refresh]);

  const deleteUser = useCallback(async (userId) => {
    await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    refresh();
  }, [refresh]);

  const resetPassword = useCallback(async (userId, newPassword) => {
    const result = await apiFetch(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    });
    return result;
  }, []);

  const updateUser = useCallback(async (userId, changes) => {
    const result = await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    refresh();
    return result;
  }, [refresh]);

  return { users: data ?? [], loading, error, refresh, addUser, deleteUser, resetPassword, updateUser };
}

export function useCron() {
  const { data, loading, error, refresh } = useGet('/api/cron');

  const saveJob = useCallback(async (job) => {
    const method = job.id ? 'PUT' : 'POST';
    const url = job.id ? `/api/cron/${job.id}` : '/api/cron';
    const result = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    refresh();
    return result;
  }, [refresh]);

  const deleteJob = useCallback(async (jobId) => {
    await apiFetch(`/api/cron/${jobId}`, { method: 'DELETE' });
    refresh();
  }, [refresh]);

  return { jobs: data ?? [], loading, error, refresh, saveJob, deleteJob };
}

export function useAccessRequests() {
  const { data, loading, error, refresh } = useGet('/api/admin/access-requests');

  const resolve = useCallback(async (requestId, approve) => {
    const result = await apiFetch(`/api/admin/access-requests/${requestId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }),
    });
    refresh();
    return result;
  }, [refresh]);

  return { requests: data ?? [], loading, error, refresh, resolve };
}

// ---------------------------------------------------------------------------
// Standalone API helpers (not hooks)
// ---------------------------------------------------------------------------

export async function startSession(text, model, imageTokens = [], sprintId = null, type = null, labels = [], name = null, mode = 'developer') {
  return apiFetch('/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model, imageTokens, sprintId, type, labels, name, mode }),
  });
}

export function useAgents() {
  const { data, loading, error, refresh } = useGet('/api/agents');
  return { agents: data?.agents ?? [], loading, error, refresh };
}

export async function runAgent(agentId, note = '') {
  return apiFetch(`/api/agents/${agentId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

export async function deleteSession(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function renameSession(sessionId, name) {
  return apiFetch(`/api/sessions/${sessionId}/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function sendMessage(sessionId, text, imageTokens = [], model = null) {
  return apiFetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, imageTokens, model }),
  });
}

export async function stopSession(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
}

export async function createShareLink(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/share-links`, { method: 'POST' });
}

export async function listShareLinks(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/share-links`);
}

export async function revokeShareLink(sessionId, linkId) {
  return apiFetch(`/api/sessions/${sessionId}/share-links/${linkId}`, { method: 'DELETE' });
}

export async function redeemShareLink(token) {
  return apiFetch(`/api/share/${encodeURIComponent(token)}/redeem`, { method: 'POST' });
}

export async function toggleBookmark(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/bookmark`, { method: 'POST' });
}

export async function markSessionDone(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/mark-done`, { method: 'POST' });
}

export async function getSprintChangelog(sprintId) {
  return apiFetch(`/api/sprints/${sprintId}/changelog`);
}

export async function requestIssueSummary(issueId) {
  return apiFetch(`/api/issues/${issueId}/request-summary`, { method: 'POST' });
}

export async function getIssueLastResponse(issueId) {
  return apiFetch(`/api/issues/${issueId}/last-response`);
}

export async function generateSprintChangelog(sprintId, summaries) {
  return apiFetch(`/api/sprints/${sprintId}/generate-changelog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summaries }),
  });
}

// ---------------------------------------------------------------------------
// Sprint board: feature sessions, bugs, test cases, progress
// ---------------------------------------------------------------------------

export async function startFeatureSession(issueId, model, text = '', imageTokens = []) {
  return apiFetch(`/api/issues/${issueId}/start-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, text, imageTokens }),
  });
}

export async function getSprintProgress(sprintId) {
  return apiFetch(`/api/sprints/${sprintId}/progress`);
}

export async function getBugs(issueId) {
  return apiFetch(`/api/issues/${issueId}/bugs`);
}

export async function createBug(issueId, data) {
  return apiFetch(`/api/issues/${issueId}/bugs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateBug(bugId, data) {
  return apiFetch(`/api/bugs/${bugId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteBug(bugId) {
  return apiFetch(`/api/bugs/${bugId}`, { method: 'DELETE' });
}

// action: 'fork' (new session off the dev session) | 'send' (add to current dev session)
export async function forkBug(bugId, model, action = 'fork') {
  return apiFetch(`/api/bugs/${bugId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, action }),
  });
}

export async function getSessionFeature(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/feature`);
}

export async function setSessionFeatureStatus(sessionId, status) {
  return apiFetch(`/api/sessions/${sessionId}/feature-status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

export async function getTestCases(issueId) {
  return apiFetch(`/api/issues/${issueId}/test-cases`);
}

export async function createTestCase(issueId, data) {
  return apiFetch(`/api/issues/${issueId}/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function updateTestCase(tcId, data) {
  return apiFetch(`/api/test-cases/${tcId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteTestCase(tcId) {
  return apiFetch(`/api/test-cases/${tcId}`, { method: 'DELETE' });
}

export async function generateTestCases(issueId, model) {
  return apiFetch(`/api/issues/${issueId}/generate-test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
}

export async function updateSessionSprint(sessionId, sprintId) {
  return apiFetch(`/api/sessions/${sessionId}/sprint`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sprintId }),
  });
}

export async function forkSession(sessionId, text, model, imageTokens = []) {
  return apiFetch(`/api/sessions/${sessionId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model, imageTokens }),
  });
}

export async function getSubtasks(issueId) {
  return apiFetch(`/api/issues/${issueId}/subtasks`);
}

// Add an existing session to the sprint board (standalone feature, or subtask of parentIssueId).
export async function sessionToIssue(sessionId, { sprintId = null, parentIssueId = null } = {}) {
  return apiFetch(`/api/sessions/${sessionId}/to-issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sprintId, parentIssueId }),
  });
}

// Merge 2+ sessions into one new session (each parent is compacted + combined).
export async function mergeSessions(sessionIds, text, model) {
  return apiFetch('/api/sessions/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionIds, text, model }),
  });
}

// Tester "Test it" — forks a shared session into a tester-mode session.
export async function testForkSession(sessionId, text = null) {
  return apiFetch(`/api/sessions/${sessionId}/test-fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(text ? { text } : {}),
  });
}

export async function uploadFile(file) {
  return apiFetch('/api/upload-file', {
    method: 'POST',
    headers: {
      // Encode: arbitrary file names (docs/xlsx) often have spaces/unicode that
      // break raw HTTP headers. The server decodeURIComponent()s this back.
      'x-file-name': encodeURIComponent(file.name),
      'x-mime-type': file.type || 'application/octet-stream',
    },
    body: file,
  });
}

// ── Sprint Board ⇄ Spreadsheet ──────────────────────────────────────────
// Open in Sheet — returns { url, mode: 'gsheet' | 'xlsx' }.
export async function openSprintSheet(sprintId) {
  return apiFetch(`/api/sprints/${sprintId}/sheet`);
}

// Blank template — returns { url, mode }.
export async function getSprintTemplate(sprintId) {
  return apiFetch(`/api/sprints/${sprintId}/template`);
}

// Upload a filled .xlsx/.csv (File) or a Google Sheet link (string) to upsert
// into the sprint. Returns { summary, sessionId }.
export async function importSprintSheet(sprintId, fileOrUrl, { withAgent = true } = {}) {
  const q = withAgent ? '' : '?agent=0';
  if (typeof fileOrUrl === 'string') {
    return apiFetch(`/api/sprints/${sprintId}/import${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetUrl: fileOrUrl }),
    });
  }
  return apiFetch(`/api/sprints/${sprintId}/import${q}`, {
    method: 'POST',
    headers: { 'Content-Type': fileOrUrl.type || 'application/octet-stream' },
    body: fileOrUrl,
  });
}

export async function requestAccess(sessionId, note) {
  return apiFetch(`/api/sessions/${sessionId}/request-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

export async function getClaudePrompt() {
  return apiFetch('/api/admin/claude-prompt');
}

export async function saveClaudePrompt(prompt) {
  return apiFetch('/api/admin/claude-prompt', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

export async function getLearnings() {
  return apiFetch('/api/admin/learnings');
}

export async function saveLearnings(content) {
  return apiFetch('/api/admin/learnings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export async function getAdminSettings() {
  return apiFetch('/api/admin/settings');
}

export async function saveAdminSetting(key, value) {
  return apiFetch('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}

export async function transcribeAudio(blob) {
  return apiFetch('/api/transcribe', {
    method: 'POST',
    body: blob,
  });
}

// ---------------------------------------------------------------------------
// Team members (for assignment dropdowns)
// ---------------------------------------------------------------------------

export function useTeamMembers() {
  const { data, loading, error, refresh } = useGet('/api/users');
  return { members: data ?? [], loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export function useSprints() {
  const { data, loading, error, refresh } = useGet('/api/sprints');

  const createSprint = useCallback(async (sprintData) => {
    const result = await apiFetch('/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sprintData),
    });
    refresh();
    return result;
  }, [refresh]);

  const updateSprint = useCallback(async (id, updates) => {
    const result = await apiFetch(`/api/sprints/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    refresh();
    return result;
  }, [refresh]);

  const deleteSprint = useCallback(async (id) => {
    await apiFetch(`/api/sprints/${id}`, { method: 'DELETE' });
    refresh();
  }, [refresh]);

  return { sprints: data ?? [], loading, error, refresh, createSprint, updateSprint, deleteSprint };
}

// ---------------------------------------------------------------------------
// Issues hooks & helpers
// ---------------------------------------------------------------------------

export function useIssues() {
  const { data, loading, error, refresh } = useGet('/api/issues');

  const createIssue = useCallback(async (issueData) => {
    const result = await apiFetch('/api/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(issueData),
    });
    refresh();
    return result;
  }, [refresh]);

  const updateIssue = useCallback(async (id, updates) => {
    const result = await apiFetch(`/api/issues/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    refresh();
    return result;
  }, [refresh]);

  const deleteIssue = useCallback(async (id) => {
    await apiFetch(`/api/issues/${id}`, { method: 'DELETE' });
    refresh();
  }, [refresh]);

  const getStagePrompt = useCallback(async (id, toStage) => {
    const q = toStage ? `?toStage=${encodeURIComponent(toStage)}` : '';
    return apiFetch(`/api/issues/${id}/stage-prompt${q}`);
  }, []);

  const advanceStage = useCallback(async (id, { toStage, customPrompt, model } = {}) => {
    const result = await apiFetch(`/api/issues/${id}/advance-stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStage, customPrompt, model }),
    });
    refresh();
    return result;
  }, [refresh]);

  return { issues: data ?? [], loading, error, refresh, createIssue, updateIssue, deleteIssue, getStagePrompt, advanceStage };
}

export function useAutonomous() {
  const { data, loading, error, refresh } = useGet('/api/autonomous/status');

  const start = useCallback(async (model, issueIds = null) => {
    const payload = { model };
    if (issueIds && issueIds.length > 0) payload.issueIds = issueIds;
    const result = await apiFetch('/api/autonomous/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    refresh();
    return result;
  }, [refresh]);

  const stop = useCallback(async () => {
    const result = await apiFetch('/api/autonomous/stop', { method: 'POST' });
    refresh();
    return result;
  }, [refresh]);

  const toggleSelfDecisions = useCallback(async (enabled) => {
    await apiFetch('/api/autonomous/self-decisions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }, [refresh]);

  return { status: data, loading, error, refresh, start, stop, toggleSelfDecisions };
}

