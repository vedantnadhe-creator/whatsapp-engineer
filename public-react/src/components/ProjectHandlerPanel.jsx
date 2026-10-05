import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X, Mail, Loader2, RefreshCw, Pause, Play } from 'lucide-react';
import { getProjectHandler, checkProjectHandler, setProjectHandlerPaused } from '../hooks/useApi';

// Mail automation for a project (project_handler.js): which inbox is watched, and each
// client email thread with the session handling it. Nothing here ever mails the client.

const colors = {
  bg: 'var(--c-bg)',
  surface: 'var(--c-surface)',
  border: 'var(--c-border)',
  text: 'var(--c-text)',
  textSecondary: 'var(--c-text-secondary)',
  textMuted: 'var(--c-text-muted)',
  accent: 'var(--c-accent)',
};

const STATUS = {
  waiting: { label: 'Mail received — starting soon', color: colors.textSecondary },
  running: { label: 'Working on it', color: '#f59e0b' },
  review: { label: 'Ready for review', color: '#22c55e' },
  needs_input: { label: 'Needs your input', color: '#ef4444' },
  no_action: { label: 'No action needed', color: colors.textMuted },
};

const POLL_MS = 15_000;

function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
}

function until(iso) {
  const min = Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000);
  return min > 0 ? `in about ${min} min` : 'at the next check';
}

export function ProjectHandlerModal({ projectId, projectName, initial, canManage, onClose }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'check' | 'pause' while a request is in flight

  useEffect(() => {
    let cancelled = false;
    const load = () => getProjectHandler(projectId)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err.message); });
    const timer = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectId]);

  const act = async (kind, fn) => {
    setBusy(kind);
    setError(null);
    try {
      const d = await fn();
      if (d?.threads) setData(d);
      else setTimeout(() => getProjectHandler(projectId).then(setData).catch(() => { }), 4000);
    } catch (err) {
      setError(err.message || 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ph-title"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl shadow-2xl"
        style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <div className="min-w-0">
            <h2 id="ph-title" className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: colors.text }}>
              <Mail size={15} /> Mail automation · {projectName}
            </h2>
            <p className="mt-1 text-[13px]" style={{ color: colors.textSecondary }}>
              Watching <span style={{ color: colors.text }}>{data.mailbox}</span> for mail from{' '}
              {data.clientDomains.map(d => `@${d}`).join(', ')}.
            </p>
            <p className="mt-0.5 text-[12px]" style={{ color: data.lastError ? '#ef4444' : colors.textMuted }}>
              {data.paused
                ? 'Paused — new mail is not being checked.'
                : data.lastError
                  ? `Last check failed: ${data.lastError}`
                  : `Checked ${ago(data.lastCheckedAt)} · every ${data.pollMinutes} min`}
            </p>
          </div>
          <button onClick={onClose} className="cursor-pointer p-1" style={{ color: colors.textSecondary }} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {data.threads.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px]" style={{ color: colors.textMuted }}>
              No client mail since automation started. The next email from the client starts a session here.
            </p>
          ) : (
            <ul>
              {data.threads.map((t) => {
                const s = STATUS[t.status] || STATUS.waiting;
                return (
                  <li key={t.id} className="px-5 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <div className="truncate text-[13px] font-medium" style={{ color: colors.text }} title={t.subject}>{t.subject}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                      <span style={{ color: s.color }}>{s.label}</span>
                      {t.status === 'waiting' && t.dueAt && (
                        <span style={{ color: colors.textMuted }}>
                          {t.pendingCount} new mail · {t.sessionId ? 'sent to its session' : 'session starts'} {until(t.dueAt)}
                        </span>
                      )}
                      <span style={{ color: colors.textMuted }}>last mail {ago(t.lastMailAt)}</span>
                      {t.sessionId && (
                        <Link to={`/s/${t.sessionId}`} onClick={onClose} className="font-mono" style={{ color: colors.accent }}>
                          {t.sessionId}
                        </Link>
                      )}
                    </div>
                    {t.note && <p className="mt-1 text-[12px]" style={{ color: colors.textSecondary }}>{t.note}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3" style={{ borderTop: `1px solid ${colors.border}` }}>
          <p className="flex-1 text-[12px]" style={{ color: colors.textMuted }}>
            Nothing is sent to the client. Finished work is flagged for review{data.reviewers.length ? ` and emailed to ${data.reviewers.join(', ')}` : ''}.
          </p>
          {error && <span className="text-[12px]" style={{ color: '#ef4444' }}>{error}</span>}
          {canManage && (
            <>
              <button
                onClick={() => act('check', () => checkProjectHandler(projectId))}
                disabled={!!busy || data.paused}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] disabled:opacity-40"
                style={{ border: `1px solid ${colors.border}`, color: colors.text }}
              >
                {busy === 'check' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check now
              </button>
              <button
                onClick={() => act('pause', () => setProjectHandlerPaused(projectId, !data.paused))}
                disabled={!!busy}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] disabled:opacity-40"
                style={{ border: `1px solid ${colors.border}`, color: colors.text }}
              >
                {data.paused ? <Play size={13} /> : <Pause size={13} />} {data.paused ? 'Resume' : 'Pause'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
