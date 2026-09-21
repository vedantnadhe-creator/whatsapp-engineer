import { useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Play, Square, RefreshCw, ArrowLeft, CheckCircle2, XCircle, MinusCircle, Loader2, MessageSquare, ExternalLink, Camera } from 'lucide-react';
import { apiFetch, apiUrl } from '../hooks/useApi';

// Testing tab — Jev browser-test runs. A run is started from a chat session (`~/jev-qa/bin/start.sh`), from the
// UAT-deploy prompt, or from the Run button here; every step lands in events.jsonl with a screenshot, and this view
// polls while the run is live. Runs are grouped by the session that started them.

const ago = (ms) => {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
};
const dur = (a, b) => (a && b ? `${((b - a) / 1000).toFixed(1)} s` : '');

function ResultBadge({ status, result }) {
  const live = status === 'running';
  const color = live ? 'var(--c-accent)' : result === 'PASS' ? 'var(--c-success, #22c55e)' : result === 'FAIL' ? 'var(--c-danger, #ef4444)' : result === 'ABORTED' ? 'var(--c-warning, #f59e0b)' : 'var(--c-text-muted)';
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded" style={{ color, border: `1px solid ${color}` }}>
      {live ? <Loader2 size={11} className="animate-spin" /> : result === 'PASS' ? <CheckCircle2 size={11} /> : result === 'FAIL' ? <XCircle size={11} /> : <MinusCircle size={11} />}
      {live ? 'RUNNING' : result || status}
    </span>
  );
}

function StepIcon({ status }) {
  if (status === 'pass') return <CheckCircle2 size={14} style={{ color: 'var(--c-success, #22c55e)' }} />;
  if (status === 'FAIL') return <XCircle size={14} style={{ color: 'var(--c-danger, #ef4444)' }} />;
  return <MinusCircle size={14} style={{ color: 'var(--c-text-muted)' }} />;
}

const stepLabel = (e) => Array.isArray(e.step) ? e.step.join(' · ') : String(e.step ?? '');

// Stop a live run: kills the worker (bin/stop.sh), the run is finalised as ABORTED and the browser released.
function StopButton({ runId, small = false, onStopped }) {
  const [busy, setBusy] = useState(false);
  const stop = async (e) => {
    e.stopPropagation(); if (!window.confirm('Stop this test run?')) return;
    setBusy(true); try { await apiFetch(`/api/tests/${runId}/stop`, { method: 'POST' }); onStopped?.(); } catch (err) { alert(err.message); } finally { setBusy(false); }
  };
  return (
    <button onClick={stop} disabled={busy} title="Stop this run" className={`flex items-center gap-1 rounded cursor-pointer disabled:opacity-50 ${small ? 'p-1' : 'px-2.5 py-1 text-xs font-medium'}`} style={{ color: 'var(--c-danger, #ef4444)', border: '1px solid var(--c-danger, #ef4444)' }}>
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}{!small && ' Stop'}
    </button>
  );
}

// ── One run: step list + screenshot ──────────────────────────────────────────
function RunView({ runId, onBack, onGoToSession }) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [selected, setSelected] = useState(null);   // index into step events; null = follow the latest
  const [error, setError] = useState(null);
  const seen = useRef(0);
  const haveMeta = useRef(false);

  useEffect(() => {
    let stop = false, timer;
    seen.current = 0; haveMeta.current = false; setEvents([]); setRun(null); setSelected(null);
    const tick = async () => {
      try {
        const r = await apiFetch(`/api/tests/${runId}/events?after=${seen.current}`);
        if (stop) return;
        if (r.events.length) { seen.current += r.events.length; setEvents((prev) => [...prev, ...r.events]); }
        setRun((prev) => ({ ...(prev || {}), ...r }));
        if (!haveMeta.current) { const d = await apiFetch(`/api/tests/${runId}`); haveMeta.current = true; if (!stop) setRun((prev) => ({ ...(prev || {}), ...d.run, status: r.status, result: r.result, summary: r.summary })); }
        if (r.status === 'running') timer = setTimeout(tick, 1500);
      } catch (e) { if (!stop) { setError(e.message); timer = setTimeout(tick, 4000); } }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const steps = useMemo(() => events.filter((e) => e.type === 'step'), [events]);
  const verify = useMemo(() => events.find((e) => e.type === 'verify'), [events]);
  const current = selected == null ? steps[steps.length - 1] : steps[selected];
  const live = run?.status === 'running';
  const listRef = useRef(null);
  useEffect(() => { if (selected == null && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [steps.length, selected]);

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--c-bg)' }}>
      <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <button onClick={onBack} className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-secondary)' }} title="All runs"><ArrowLeft size={16} /></button>
        <FlaskConical size={16} style={{ color: 'var(--c-accent)' }} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--c-text)' }}>{run?.title || runId}</div>
          <div className="text-[11px] font-mono" style={{ color: 'var(--c-text-muted)' }}>
            {run?.env?.toUpperCase()}{run?.device ? ` · ${run.device}${run.browser ? '/' + run.browser : ''}` : ''} · {run?.specs?.join(', ')} · started {ago(run?.startedAt)}{run?.endedAt ? ` · ${dur(run.startedAt, run.endedAt)}` : ''}
          </div>
        </div>
        {run?.session && (
          <button onClick={() => onGoToSession?.(run.session.id)} className="flex items-center gap-1 text-xs px-2 py-1 rounded cursor-pointer" style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} title="Open the session that started this run">
            <MessageSquare size={12} /> {run.session.name || 'session'}
          </button>
        )}
        {live && <StopButton runId={runId} onStopped={() => setRun((prev) => ({ ...(prev || {}), status: 'done', result: 'ABORTED' }))} />}
        <ResultBadge status={run?.status} result={run?.result} />
      </div>

      {error && <div className="px-4 py-2 text-xs" style={{ color: 'var(--c-danger, #ef4444)' }}>{error}</div>}

      <div className="flex-1 min-h-0 flex">
        {/* steps */}
        <div ref={listRef} className="w-[420px] shrink-0 overflow-y-auto" style={{ borderRight: '1px solid var(--c-border)' }}>
          {steps.length === 0 && (
            <div className="p-6 text-xs" style={{ color: 'var(--c-text-muted)' }}>{live ? 'Starting the browser…' : 'No steps recorded.'}</div>
          )}
          {steps.map((e, i) => {
            const prevSpec = i > 0 ? steps[i - 1].spec : null;
            const isSel = current === e;
            return (
              <div key={i}>
                {e.spec !== prevSpec && (
                  <div className="px-3 pt-3 pb-1 text-[10px] font-mono uppercase tracking-wide" style={{ color: 'var(--c-text-muted)' }}>{e.spec}</div>
                )}
                <button
                  onClick={() => setSelected(i === steps.length - 1 ? null : i)}
                  className="w-full text-left px-3 py-1.5 flex items-start gap-2 cursor-pointer"
                  style={{ backgroundColor: isSel ? 'var(--c-surface-2)' : 'transparent' }}
                >
                  <span className="mt-0.5"><StepIcon status={e.status} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs truncate" style={{ color: 'var(--c-text)' }}>
                      <span className="font-mono" style={{ color: 'var(--c-text-muted)' }}>{e.i}. </span>{stepLabel(e)}
                    </span>
                    <span className="block text-[11px] truncate font-mono" style={{ color: e.status === 'FAIL' ? 'var(--c-danger, #ef4444)' : 'var(--c-text-secondary)' }}>
                      {e.err || [e.el, e.conf != null ? `conf ${e.conf}` : null, e.state ? `→ ${e.state}` : null, e.asserts ? e.asserts.map((a) => `p=${a.p}`).join(' ') : null, e.ms?.total != null ? `${e.ms.total} ms` : null].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
          {verify && (
            <pre className="m-3 p-2 text-[10px] font-mono overflow-x-auto rounded" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>{verify.text}</pre>
          )}
          {run?.summary?.length > 0 && (
            <div className="m-3 text-[11px] font-mono" style={{ color: 'var(--c-text-secondary)' }}>
              {run.summary.map((s) => <div key={s.spec}>{s.result === 'PASS' ? '✓' : '✗'} {s.spec} {s.passed}/{s.planned} · {(s.wallMs / 1000).toFixed(1)} s · ${s.jevCostUsd}</div>)}
            </div>
          )}
        </div>

        {/* screenshot */}
        <div className="flex-1 min-w-0 flex flex-col items-center justify-start p-4 overflow-auto">
          {current?.shot ? (
            <>
              <div className="w-full text-[11px] font-mono mb-2 flex items-center gap-2" style={{ color: 'var(--c-text-muted)' }}>
                <Camera size={12} /> step {current.i} — {stepLabel(current)} {selected == null && live ? '(following live)' : ''}
              </div>
              <img src={apiUrl(`/api/tests/${runId}/shot/${current.shot}`)} alt={`step ${current.i}`} className="max-w-full rounded" style={{ border: '1px solid var(--c-border)' }} />
            </>
          ) : (
            <div className="text-xs mt-10" style={{ color: 'var(--c-text-muted)' }}>{live ? 'Waiting for the first step…' : 'Select a step to see its screenshot.'}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Run list + launcher ──────────────────────────────────────────────────────
export default function TestsView({ runId, onOpenRun, onBack, onGoToSession, sessionId }) {
  const [runs, setRuns] = useState(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [target, setTarget] = useState('suite');
  const [env, setEnv] = useState('dev');
  const [device, setDevice] = useState('pc');
  const [browser, setBrowser] = useState('chromium');
  const effBrowser = device === 'ios' ? 'webkit' : browser;   // iOS is Safari, always
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState(null);

  const refresh = async () => { try { const r = await apiFetch('/api/tests'); setRuns(r.runs); } catch (e) { setErr(e.message); } };
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);

  if (runId) return <RunView runId={runId} onBack={onBack} onGoToSession={onGoToSession} />;

  const shown = (runs || []).filter((r) => !onlyMine || (sessionId && r.sessionId === sessionId));
  const launch = async () => {
    setLaunching(true); setErr(null);
    try {
      const body = { ...(target.startsWith('chain:') ? { target: 'chain', type: target.slice(6) } : { target }), env, device, browser: effBrowser, sessionId };
      const r = await apiFetch('/api/tests/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await refresh(); if (r.id) onOpenRun?.(r.id);
    } catch (e) { setErr(e.message); } finally { setLaunching(false); }
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--c-bg)' }}>
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <FlaskConical size={16} style={{ color: 'var(--c-accent)' }} />
        <div className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>Testing</div>
        <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>Jev browser tests · DEV / UAT · every step recorded with a screenshot</div>
        <div className="flex-1" />
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}>
          <option value="suite">Regression suite</option>
          <option value="admin-login-smoke">Admin login smoke</option>
          <option value="admin-float-aptitude">Float Aptitude</option>
          <option value="admin-float-communication">Float Communication</option>
          <option value="chain:Aptitude">Aptitude end-to-end (float → take → verify)</option>
          <option value="chain:Communication">Communication end-to-end (float → take → verify)</option>
        </select>
        <select value={env} onChange={(e) => setEnv(e.target.value)} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}>
          <option value="dev">DEV</option>
          <option value="uat">UAT</option>
        </select>
        <select value={device} onChange={(e) => setDevice(e.target.value)} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} title="Device">
          <option value="pc">PC</option>
          <option value="android">Android</option>
          <option value="ios" disabled={target.startsWith('chain:')}>iOS (Safari)</option>
        </select>
        <select value={effBrowser} disabled={device === 'ios'} onChange={(e) => setBrowser(e.target.value)} className="text-xs px-2 py-1 rounded disabled:opacity-70" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} title={device === 'ios' ? 'iOS always runs on Safari (WebKit)' : 'Browser'}>
          <option value="chromium">Chrome / Edge</option>
          <option value="firefox">Firefox</option>
          <option value="webkit">Safari (WebKit)</option>
        </select>
        <button onClick={launch} disabled={launching} className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded cursor-pointer disabled:opacity-50" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>
          {launching ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run
        </button>
        <button onClick={refresh} className="p-1.5 rounded cursor-pointer" style={{ color: 'var(--c-text-secondary)' }} title="Refresh"><RefreshCw size={14} /></button>
      </div>
      {err && <div className="px-4 py-2 text-xs" style={{ color: 'var(--c-danger, #ef4444)' }}>{err}</div>}

      <div className="px-4 py-2 flex items-center gap-3 text-xs" style={{ color: 'var(--c-text-secondary)' }}>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} disabled={!sessionId} /> only this session
        </label>
        <span style={{ color: 'var(--c-text-muted)' }}>{shown.length} run{shown.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {runs === null && <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>Loading…</div>}
        {runs?.length === 0 && (
          <div className="text-xs mt-6" style={{ color: 'var(--c-text-muted)' }}>
            No runs yet. Start one above, or from any session: <code>~/jev-qa/bin/start.sh suite --env dev</code>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {shown.map((r) => (
            <div key={r.id} role="button" tabIndex={0} onClick={() => onOpenRun?.(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenRun?.(r.id); } }} className="text-left rounded px-3 py-2 flex items-center gap-3 cursor-pointer" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
              <ResultBadge status={r.status} result={r.result} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate" style={{ color: 'var(--c-text)' }}>{r.title}</div>
                <div className="text-[11px] font-mono truncate" style={{ color: 'var(--c-text-muted)' }}>
                  {r.env?.toUpperCase()}{r.device ? ` · ${r.device}${r.browser ? '/' + r.browser : ''}` : ''} · {r.specs?.join(', ')}{r.summary?.length ? ` · ${r.summary.map((s) => `${s.passed}/${s.planned}`).join(' ')}` : ''}
                </div>
              </div>
              {r.session && (
                <span onClick={(e) => { e.stopPropagation(); onGoToSession?.(r.session.id); }} className="flex items-center gap-1 text-[11px] truncate max-w-[200px]" style={{ color: 'var(--c-text-secondary)' }} title="Open session">
                  <MessageSquare size={11} /> {r.session.name || r.session.id}
                </span>
              )}
              <span className="text-[11px] font-mono whitespace-nowrap" style={{ color: 'var(--c-text-muted)' }}>{ago(r.startedAt)}{r.endedAt ? ` · ${dur(r.startedAt, r.endedAt)}` : ''}</span>
              {r.status === 'running' ? <StopButton runId={r.id} small onStopped={refresh} /> : <ExternalLink size={12} style={{ color: 'var(--c-text-muted)' }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
