import { useState } from 'react';
import { Gauge, RefreshCw, AlertTriangle, BarChart3 } from 'lucide-react';
import { useUsage } from '../hooks/useApi';

// Series colours, validated for colour-blind separation on both themes.
const PROVIDERS = {
  claude: { label: 'Claude Code', color: '#ea580c' },
  codex: { label: 'Codex', color: '#2563eb' },
};

const RANGES = [
  { key: 'session', label: 'Current 5 h' },
  { key: 'week', label: 'This week' },
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

// "Tokens" = fresh input + cache writes + output. Cache reads are shown
// separately: they are huge in agent sessions and count far less against limits.
const tokens = (t) => (t ? t.input + t.cacheWrite + t.output : 0);

function fmt(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function resetsIn(iso) {
  const ms = Date.parse(iso || '') - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'resetting now';
  const h = Math.floor(ms / 36e5);
  const m = Math.round((ms % 36e5) / 6e4);
  if (h >= 24) return `resets in ${Math.floor(h / 24)} d ${h % 24} h`;
  return h ? `resets in ${h} h ${m} m` : `resets in ${m} m`;
}

const card = { backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' };

function Section({ icon: Icon, title, right, children }) {
  return (
    <section className="rounded-lg mb-3 overflow-hidden" style={card}>
      <header
        className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs font-medium"
        style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}
      >
        <span className="flex items-center gap-2"><Icon size={13} aria-hidden="true" /> {title}</span>
        {right}
      </header>
      {children}
    </section>
  );
}

function Meter({ window: w }) {
  const used = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  const level = used >= 90 ? { color: 'var(--c-danger)', text: 'Near limit' } : used >= 70 ? { color: 'var(--c-warning)', text: 'High' } : null;
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between text-xs mb-1.5 gap-2">
        <span style={{ color: 'var(--c-text)' }}>{w.label}</span>
        <span className="font-mono flex items-center gap-1.5" style={{ color: 'var(--c-text-secondary)' }}>
          {level && (
            <span className="flex items-center gap-1" style={{ color: level.color }}>
              <AlertTriangle size={11} aria-hidden="true" /> {level.text}
            </span>
          )}
          <strong style={{ color: 'var(--c-text)' }}>{w.usedPercent == null ? '—' : `${Math.round(used)}%`}</strong> used
        </span>
      </div>
      <div
        role="progressbar" aria-label={`${w.label} used`} aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100}
        className="w-full rounded-full overflow-hidden" style={{ height: 8, backgroundColor: 'var(--c-surface-3)' }}
      >
        <div className="h-full rounded-full" style={{ width: `${used}%`, backgroundColor: level?.color || 'var(--c-text-secondary)' }} />
      </div>
      <div className="text-[11px] mt-1" style={{ color: 'var(--c-text-muted)' }} title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : ''}>
        {resetsIn(w.resetsAt) || 'reset time unknown'}
      </div>
    </div>
  );
}

function LimitCard({ provider, data, total }) {
  const p = PROVIDERS[provider];
  return (
    <div className="rounded-lg p-4 flex-1 min-w-[260px]" style={card}>
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
          <span className="inline-block rounded-sm" style={{ width: 10, height: 10, backgroundColor: p.color }} aria-hidden="true" />
          {p.label}
        </span>
        {data?.plan && <span className="text-[11px] font-mono" style={{ color: 'var(--c-text-muted)' }}>{data.plan}</span>}
      </div>
      {data?.error ? (
        <p className="text-xs py-3" style={{ color: 'var(--c-danger)' }}>Limits unavailable: {data.error}</p>
      ) : !data ? (
        <p className="text-xs py-3" style={{ color: 'var(--c-text-muted)' }}>Loading…</p>
      ) : (
        <>
          {data.windows.map((w) => <Meter key={w.label} window={w} />)}
          {!data.windows.length && <p className="text-xs py-3" style={{ color: 'var(--c-text-muted)' }}>No limit windows reported.</p>}
          {data.limitReached && <p className="text-xs" style={{ color: 'var(--c-danger)' }}>Limit reached — sessions will fail until it resets.</p>}
        </>
      )}
      <div className="text-xs mt-2 pt-2 flex justify-between" style={{ color: 'var(--c-text-secondary)', borderTop: '1px solid var(--c-border)' }}>
        <span>Tokens in range</span>
        <span className="font-mono">{fmt(tokens(total))} · {fmt(total?.turns)} turns</span>
      </div>
    </div>
  );
}

function DailyChart({ daily }) {
  const [hover, setHover] = useState(null);
  if (!daily.length) return <p className="px-4 py-6 text-xs text-center" style={{ color: 'var(--c-text-muted)' }}>No usage in this range.</p>;
  const max = Math.max(1, ...daily.map((d) => d.claude + d.codex));
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-4 text-[11px] mb-2" style={{ color: 'var(--c-text-secondary)' }}>
        {Object.entries(PROVIDERS).map(([k, p]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block rounded-sm" style={{ width: 8, height: 8, backgroundColor: p.color }} aria-hidden="true" /> {p.label}
          </span>
        ))}
      </div>
      <div className="flex items-end gap-1" style={{ height: 140 }} onMouseLeave={() => setHover(null)}>
        {daily.map((d) => (
          <div
            key={d.day} className="flex-1 h-full flex flex-col justify-end relative cursor-default"
            onMouseEnter={() => setHover(d.day)}
            aria-label={`${d.day}: Claude ${fmt(d.claude)}, Codex ${fmt(d.codex)} tokens`}
          >
            {hover === d.day && (
              <div
                className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 px-2 py-1 rounded text-[11px] font-mono whitespace-nowrap z-10 pointer-events-none"
                style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
              >
                {d.day} · Claude {fmt(d.claude)} · Codex {fmt(d.codex)}
              </div>
            )}
            {['codex', 'claude'].map((k, i) => d[k] > 0 && (
              <div
                key={k}
                style={{
                  height: `${(d[k] / max) * 100}%`, minHeight: 2, backgroundColor: PROVIDERS[k].color,
                  borderRadius: i === 0 || !d.codex ? '4px 4px 0 0' : 0,
                  marginTop: i === 1 && d.codex ? 2 : 0, opacity: hover && hover !== d.day ? 0.5 : 1,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-1">
        {daily.map((d) => (
          <div key={d.day} className="flex-1 text-center text-[9px] font-mono" style={{ color: 'var(--c-text-muted)' }}>{d.day.slice(5)}</div>
        ))}
      </div>
    </div>
  );
}


export default function UsageView() {
  const [range, setRange] = useState('week');
  const { usage, loading, error, refresh } = useUsage(range);
  const totals = usage?.totals;
  const sinceLabel = usage?.since ? new Date(usage.since).toLocaleString() : '';

  return (
    <div className="h-full overflow-y-auto" style={{ backgroundColor: 'var(--c-bg)' }}>
      <div className="max-w-6xl mx-auto p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Gauge size={20} aria-hidden="true" style={{ color: 'var(--c-accent)' }} />
            <h1 className="text-lg font-bold" style={{ color: 'var(--c-text)' }}>Usage</h1>
          </div>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Time range" className="flex rounded overflow-hidden" style={{ border: '1px solid var(--c-border)' }}>
              {RANGES.map((r) => (
                <button
                  key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)}
                  className="px-2.5 py-1.5 text-xs font-medium cursor-pointer"
                  style={{
                    backgroundColor: range === r.key ? 'var(--c-surface-3)' : 'var(--c-surface)',
                    color: range === r.key ? 'var(--c-text)' : 'var(--c-text-secondary)',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              type="button" onClick={refresh}
              className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium cursor-pointer"
              style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
            >
              <RefreshCw size={13} aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div className="rounded-lg p-6 text-center text-sm" style={{ ...card, color: 'var(--c-danger)' }}>Couldn’t load usage: {error.message}</div>
        ) : !usage ? (
          <div className="text-sm" style={{ color: 'var(--c-text-muted)' }}>Reading Claude Code and Codex usage… (the first load after a restart takes about 30 s)</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 mb-3">
              <LimitCard provider="claude" data={usage.limits?.claude} total={totals.claude} />
              <LimitCard provider="codex" data={usage.limits?.codex} total={totals.codex} />
            </div>
            <p className="text-[11px] mb-3" style={{ color: 'var(--c-text-muted)' }}>
              Limits are live from each plan and shared by everyone on this dashboard. Token counts come from the CLI transcripts since {sinceLabel}
              {' '}(tokens = input + cache writes + output; cache reads listed separately). Transcripts are kept 30 days.
            </p>

            <Section icon={BarChart3} title="Tokens per day (UTC)"><DailyChart daily={usage.daily} /></Section>

          </>
        )}
      </div>
    </div>
  );
}
