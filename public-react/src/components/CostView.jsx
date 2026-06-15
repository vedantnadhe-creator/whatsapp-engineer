import { useMemo } from 'react';
import { DollarSign, RefreshCw, TrendingUp, Layers, ArrowUpRight, Info } from 'lucide-react';

const MODEL_NAMES = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'fable': 'Fable 5',
  'opus': 'Opus 4.6',
  'sonnet': 'Sonnet 4.6',
  'haiku': 'Haiku 4.5',
  'unknown': 'Unknown',
};

const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money4 = (n) => {
  const v = Number(n || 0);
  return v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : money(v);
};

function StatCard({ label, value, sub, accent }) {
  return (
    <div
      className="flex-1 min-w-[140px] rounded-lg p-4"
      style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
    >
      <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--c-text-muted)' }}>{label}</div>
      <div className="font-mono text-2xl font-bold leading-none" style={{ color: accent || 'var(--c-text)' }}>
        {value}
      </div>
      {sub != null && (
        <div className="text-xs mt-1.5" style={{ color: 'var(--c-text-secondary)' }}>{sub}</div>
      )}
    </div>
  );
}

function DailyChart({ daily }) {
  const max = Math.max(0.0001, ...daily.map(d => d.cost));
  if (!daily.length) return null;
  return (
    <div
      className="rounded-lg p-4"
      style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
    >
      <div className="flex items-center gap-2 mb-3 text-xs font-medium" style={{ color: 'var(--c-text-secondary)' }}>
        <TrendingUp size={13} /> Daily spend — last 14 days
      </div>
      <div className="flex items-end gap-1.5" style={{ height: 120 }}>
        {daily.map((d) => (
          <div key={d.day} className="flex-1 flex flex-col items-center justify-end group relative" style={{ height: '100%' }}>
            <div
              className="w-full rounded-t transition-all"
              style={{
                height: `${Math.max(2, (d.cost / max) * 100)}%`,
                backgroundColor: 'var(--c-accent)',
                opacity: 0.85,
              }}
            />
            <div
              className="absolute -top-7 px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-10"
              style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            >
              {money(d.cost)} · {d.count}
            </div>
            <div className="text-[9px] mt-1 font-mono" style={{ color: 'var(--c-text-muted)' }}>
              {d.day.slice(5)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelBreakdown({ byModel, total }) {
  if (!byModel?.length) return null;
  return (
    <div
      className="rounded-lg p-4"
      style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
    >
      <div className="flex items-center gap-2 mb-3 text-xs font-medium" style={{ color: 'var(--c-text-secondary)' }}>
        <Layers size={13} /> By model (all-time)
      </div>
      <div className="flex flex-col gap-2.5">
        {byModel.map((m) => {
          const pct = total > 0 ? (m.cost / total) * 100 : 0;
          return (
            <div key={m.model}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span style={{ color: 'var(--c-text)' }}>{MODEL_NAMES[m.model] || m.model}</span>
                <span className="font-mono" style={{ color: 'var(--c-text-secondary)' }}>
                  {money(m.cost)} · {m.count} sess · {pct.toFixed(0)}%
                </span>
              </div>
              <div className="w-full rounded-full overflow-hidden" style={{ height: 6, backgroundColor: 'var(--c-surface-3)' }}>
                <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: 'var(--c-accent)' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CostView({ cost, loading, onRefresh, onGoToSession }) {
  const total = cost?.all?.cost || 0;
  const top = cost?.topSessions || [];
  const projected = useMemo(() => Number(cost?.last30?.cost || 0), [cost]);

  return (
    <div className="h-full overflow-y-auto" style={{ backgroundColor: 'var(--c-bg)' }}>
      <div className="max-w-5xl mx-auto p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <DollarSign size={20} style={{ color: 'var(--c-accent)' }} />
            <h1 className="text-lg font-bold" style={{ color: 'var(--c-text)' }}>Cost Meter</h1>
          </div>
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium cursor-pointer"
            style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {cost?.unavailable ? (
          <div className="rounded-lg p-6 text-center text-sm" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
            Cost data isn’t available for the active store.
          </div>
        ) : !cost && loading ? (
          <div className="text-sm" style={{ color: 'var(--c-text-muted)' }}>Loading…</div>
        ) : (
          <>
            {/* Stat cards */}
            <div className="flex flex-wrap gap-3 mb-3">
              <StatCard label="Today" value={money(cost?.today?.cost)} sub={`${cost?.today?.count || 0} sessions`} />
              <StatCard label="Last 7 days" value={money(cost?.last7?.cost)} sub={`${cost?.last7?.count || 0} sessions`} />
              <StatCard label="Last 30 days" value={money(cost?.last30?.cost)} sub={`${cost?.last30?.count || 0} sessions`} accent="var(--c-accent)" />
              <StatCard label="All-time" value={money(total)} sub={`${cost?.all?.count || 0} sessions · avg ${money4(cost?.avgPerSession)}`} />
            </div>

            {/* Billing context note */}
            <div
              className="flex items-start gap-2 rounded-lg p-3 mb-4 text-xs"
              style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', color: 'var(--c-text-secondary)' }}
            >
              <Info size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--c-accent)' }} />
              <span>
                These are API-equivalent costs reported per session by Claude Code. Since <strong>June 15, 2026</strong>,
                OliBot’s programmatic (<code>--print</code>) sessions bill from the separate Agent SDK credit at standard API rates.
                At the current pace, the rolling 30-day run-rate is <strong style={{ color: 'var(--c-text)' }}>{money(projected)}</strong>.
              </span>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
              <DailyChart daily={cost?.daily || []} />
              <ModelBreakdown byModel={cost?.byModel || []} total={total} />
            </div>

            {/* Top sessions */}
            <div
              className="rounded-lg overflow-hidden"
              style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
            >
              <div className="px-4 py-3 text-xs font-medium" style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}>
                Most expensive sessions
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: 'var(--c-text-muted)' }}>
                      <th className="text-left font-medium px-4 py-2">Session</th>
                      <th className="text-left font-medium px-3 py-2">Model</th>
                      <th className="text-left font-medium px-3 py-2">Owner</th>
                      <th className="text-left font-medium px-3 py-2">Date</th>
                      <th className="text-right font-medium px-4 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.map((s, i) => (
                      <tr
                        key={s.id}
                        className="cursor-pointer transition-colors"
                        style={{ borderTop: '1px solid var(--c-border)' }}
                        onClick={() => onGoToSession?.(s.id)}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <td className="px-4 py-2 max-w-[280px] truncate" style={{ color: 'var(--c-text)' }}>
                          <span className="inline-flex items-center gap-1">
                            {s.task || s.id}
                            <ArrowUpRight size={11} style={{ color: 'var(--c-text-muted)' }} />
                          </span>
                        </td>
                        <td className="px-3 py-2" style={{ color: 'var(--c-text-secondary)' }}>{MODEL_NAMES[s.model] || s.model || '—'}</td>
                        <td className="px-3 py-2" style={{ color: 'var(--c-text-secondary)' }}>{s.owner || '—'}</td>
                        <td className="px-3 py-2 font-mono" style={{ color: 'var(--c-text-muted)' }}>{(s.created_at || '').slice(0, 10)}</td>
                        <td className="px-4 py-2 text-right font-mono font-semibold" style={{ color: 'var(--c-text)' }}>{money(s.cost)}</td>
                      </tr>
                    ))}
                    {!top.length && (
                      <tr><td colSpan={5} className="px-4 py-6 text-center" style={{ color: 'var(--c-text-muted)' }}>No cost data yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
