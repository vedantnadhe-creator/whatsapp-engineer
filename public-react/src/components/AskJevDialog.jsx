import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2, X } from 'lucide-react';

// "Ask Jev to test" — the one dialog behind every Ask-Jev button (deploy banner, sprint rows). Collects the env,
// device/browser (iOS locks Safari) and free-text notes, then hands { env, device, browser, notes } to onStart.
export default function AskJevDialog({ subject, defaultEnv = 'dev', lockEnv = false, onStart, onClose }) {
  const [env, setEnv] = useState(defaultEnv);
  const [device, setDevice] = useState('pc');
  const [browser, setBrowser] = useState('chromium');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const effBrowser = device === 'ios' ? 'webkit' : browser;
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose?.(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const start = async () => {
    setBusy(true); setError(null);
    try { await onStart({ env, device, browser: effBrowser, notes }); }
    catch (e) { setError(e.message || String(e)); setBusy(false); }
  };
  const field = { backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text)', border: '1px solid var(--c-border)' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'var(--c-overlay, rgba(0,0,0,0.5))' }} onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="askjev-title">
      <div className="w-full max-w-lg rounded-lg p-4 flex flex-col gap-3" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <FlaskConical size={16} style={{ color: 'var(--c-accent)' }} />
          <div id="askjev-title" className="text-sm font-semibold flex-1 truncate" style={{ color: 'var(--c-text)' }}>Ask Jev to test</div>
          <button onClick={onClose} className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }} aria-label="Close"><X size={14} /></button>
        </div>
        {subject && <div className="text-xs truncate" style={{ color: 'var(--c-text-secondary)' }} title={subject}>{subject}</div>}

        <div className="flex items-center gap-2 flex-wrap text-xs">
          <label className="flex items-center gap-1" style={{ color: 'var(--c-text-secondary)' }}>Env
            <select value={env} disabled={lockEnv} onChange={(e) => setEnv(e.target.value)} className="px-1.5 py-1 rounded disabled:opacity-70" style={field}>
              <option value="dev">DEV</option>
              <option value="uat">UAT</option>
            </select>
          </label>
          <label className="flex items-center gap-1" style={{ color: 'var(--c-text-secondary)' }}>Device
            <select value={device} onChange={(e) => setDevice(e.target.value)} className="px-1.5 py-1 rounded" style={field}>
              <option value="pc">PC</option>
              <option value="android">Android</option>
              <option value="ios">iOS (Safari)</option>
            </select>
          </label>
          <label className="flex items-center gap-1" style={{ color: 'var(--c-text-secondary)' }}>Browser
            <select value={effBrowser} disabled={device === 'ios'} onChange={(e) => setBrowser(e.target.value)} className="px-1.5 py-1 rounded disabled:opacity-70" style={field} title={device === 'ios' ? 'iOS always runs on Safari (WebKit)' : undefined}>
              <option value="chromium">Chrome / Edge</option>
              <option value="firefox">Firefox</option>
              <option value="webkit">Safari (WebKit)</option>
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--c-text-secondary)' }}>
          Anything Jev should know or focus on <span style={{ color: 'var(--c-text-muted)' }}>(optional)</span>
          <textarea
            ref={ref}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start(); }}
            rows={4}
            placeholder="e.g. Only the Corporate tab changed — check the candidate count and the export button. Login as the Meesho recruiter."
            className="w-full text-xs px-2 py-1.5 rounded outline-none resize-y"
            style={{ ...field, color: 'var(--c-text)' }}
          />
        </label>

        {error && <div className="text-xs" style={{ color: 'var(--c-danger, #ef4444)' }}>{error}</div>}

        <div className="flex items-center justify-end gap-2">
          <span className="text-[11px] mr-auto" style={{ color: 'var(--c-text-muted)' }}>Starts a tester session (GPT-5.6 Sol) that writes the Jev specs and runs them — watch it in Testing.</span>
          <button onClick={onClose} className="px-3 py-1.5 rounded text-xs cursor-pointer" style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>Cancel</button>
          <button onClick={start} disabled={busy} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium cursor-pointer disabled:opacity-50" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} {busy ? 'Starting…' : 'Start test'}
          </button>
        </div>
      </div>
    </div>
  );
}
