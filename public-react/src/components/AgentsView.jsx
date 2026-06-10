import { useState } from 'react';
import { Rocket, Bot, Play, Clock, AlertTriangle, BarChart3, Database } from 'lucide-react';

const ICON_MAP = { Rocket, Bot, BarChart3, Database };

function formatLastRun(iso) {
  if (!iso) return 'Never run';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function AgentsView({ agents = [], onRunAgent, loading = false }) {
  const [runningId, setRunningId] = useState(null);
  const [error, setError] = useState(null);
  const [confirmAgent, setConfirmAgent] = useState(null);
  const [note, setNote] = useState('');

  const handleRun = async (agent) => {
    if (!onRunAgent) return;
    setRunningId(agent.id);
    setError(null);
    try {
      await onRunAgent(agent.id, note.trim());
      setConfirmAgent(null);
      setNote('');
    } catch (e) {
      setError(e.message || 'Failed to start agent');
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--c-bg)' }}>
      <div
        className="px-4 md:px-6 py-3 flex items-center gap-3"
        style={{ borderBottom: '1px solid var(--c-border)' }}
      >
        <Bot size={18} style={{ color: 'var(--c-text-secondary)' }} />
        <div>
          <h1 className="text-base font-semibold" style={{ color: 'var(--c-text)' }}>
            Agents
          </h1>
          <p className="text-xs" style={{ color: 'var(--c-text-secondary)' }}>
            Predefined workflows. Pick one, it starts a session and walks through the steps.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {loading && (
          <div className="text-sm" style={{ color: 'var(--c-text-secondary)' }}>Loading agents…</div>
        )}
        {!loading && agents.length === 0 && (
          <div className="text-sm" style={{ color: 'var(--c-text-secondary)' }}>
            No agents configured yet.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-4xl">
          {agents.map((agent) => {
            const Icon = ICON_MAP[agent.icon] || Bot;
            return (
              <div
                key={agent.id}
                className="rounded-lg p-4 flex flex-col"
                style={{
                  backgroundColor: 'var(--c-surface)',
                  border: '1px solid var(--c-border)',
                }}
              >
                <div className="flex items-start gap-3 mb-2">
                  <div
                    className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
                    style={{ backgroundColor: 'var(--c-surface-2)' }}
                  >
                    <Icon size={18} style={{ color: 'var(--c-accent)' }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
                      {agent.name}
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--c-text-secondary)' }}>
                      {agent.description}
                    </p>
                  </div>
                </div>
                <div
                  className="flex items-center gap-1.5 text-[11px] font-mono mt-2"
                  style={{ color: 'var(--c-text-muted)' }}
                >
                  <Clock size={11} />
                  Last run: {formatLastRun(agent.lastRunAt)}
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => setConfirmAgent(agent)}
                    disabled={runningId === agent.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium text-white cursor-pointer disabled:opacity-50"
                    style={{ backgroundColor: 'var(--c-accent)' }}
                  >
                    <Play size={12} />
                    {runningId === agent.id ? 'Starting…' : 'Run agent'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {confirmAgent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--c-overlay, rgba(0,0,0,0.6))' }}
          onClick={() => { if (!runningId) setConfirmAgent(null); }}
        >
          <div
            className="rounded-lg w-full max-w-md p-5"
            style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-3">
              <AlertTriangle size={20} style={{ color: 'var(--c-accent)' }} />
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
                  Run “{confirmAgent.name}”?
                </h3>
                <p className="text-xs mt-1" style={{ color: 'var(--c-text-secondary)' }}>
                  This starts a new session that follows the agent's workflow. You'll still be asked to confirm risky steps.
                </p>
              </div>
            </div>

            <label className="block text-[11px] font-medium uppercase tracking-wide mb-1.5" style={{ color: 'var(--c-text-secondary)' }}>
              Note (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="e.g. Deploying admin-node + student-react. Hotfix for billing bug."
              className="w-full px-2.5 py-2 text-sm outline-none rounded resize-none"
              style={{
                backgroundColor: 'var(--c-bg)',
                border: '1px solid var(--c-border)',
                color: 'var(--c-text)',
              }}
            />

            {error && (
              <p className="text-xs mt-2" style={{ color: '#ef4444' }}>{error}</p>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setConfirmAgent(null); setNote(''); setError(null); }}
                disabled={!!runningId}
                className="px-3 py-1.5 text-xs rounded cursor-pointer disabled:opacity-50"
                style={{ color: 'var(--c-text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleRun(confirmAgent)}
                disabled={!!runningId}
                className="px-3 py-1.5 text-xs rounded text-white font-medium cursor-pointer disabled:opacity-50"
                style={{ backgroundColor: 'var(--c-accent)' }}
              >
                {runningId === confirmAgent.id ? 'Starting…' : 'Start session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
