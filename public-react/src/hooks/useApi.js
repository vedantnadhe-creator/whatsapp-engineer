import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const API_BASE = window.location.pathname.startsWith('/sessions') ? '/sessions' : '';

// Dedup: reject duplicate in-flight POST/PUT/DELETE requests to the same URL
const inflightMutations = new Map();

async function apiFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const fullUrl = API_BASE + url;

  // For mutations, deduplicate — if identical request is in-flight, return its promise
  if (method !== 'GET') {
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

export function useSessions(page = 1) {
  const { data, loading, error, refresh } = useGet(`/api/sessions?page=${page}`, [page]);
  return {
    sessions: data?.sessions ?? [],
    total: data?.total ?? 0,
    totalPages: data?.totalPages ?? 1,
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

  return { users: data ?? [], loading, error, refresh, addUser, deleteUser, resetPassword };
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

export async function startSession(text, model) {
  return apiFetch('/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model }),
  });
}

export async function sendMessage(sessionId, text) {
  return apiFetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export async function stopSession(sessionId) {
  return apiFetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
}

export async function uploadFile(file) {
  return apiFetch('/api/upload-file', {
    method: 'POST',
    headers: {
      'x-file-name': file.name,
      'x-mime-type': file.type,
    },
    body: file,
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

export async function transcribeAudio(blob) {
  return apiFetch('/api/transcribe', {
    method: 'POST',
    body: blob,
  });
}
