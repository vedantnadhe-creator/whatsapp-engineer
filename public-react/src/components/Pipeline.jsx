import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Lightbulb,
  Sparkles,
  Code2,
  FlaskConical,
  CheckCheck,
  Rocket,
  ArrowRight,
  ArrowLeft,
  CircleDot,
  MessageSquare,
  Loader2,
  X,
  Calendar,
  FileText,
  Filter,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { apiFetch } from '../hooks/useApi';

const colors = {
  bg: 'var(--c-bg)',
  surface: 'var(--c-surface)',
  surface2: 'var(--c-surface-2)',
  surface3: 'var(--c-surface-3)',
  border: 'var(--c-border)',
  text: 'var(--c-text)',
  textSecondary: 'var(--c-text-secondary)',
  accent: 'var(--c-accent)',
};

const STAGE_CONFIG = {
  idea:        { label: 'Idea',        icon: Lightbulb,    color: '#eab308' },
  design:      { label: 'Design',      icon: Sparkles,     color: '#8b5cf6' },
  development: { label: 'Development', icon: Code2,        color: '#3b82f6' },
  qa:          { label: 'QA',          icon: FlaskConical, color: '#f97316' },
  done:        { label: 'Done',        icon: CheckCheck,   color: '#22c55e' },
};
const STAGE_ORDER = ['idea', 'design', 'development', 'qa', 'done'];

const TYPE_CONFIG = {
  task:        { label: 'Task',        color: '#3b82f6' },
  bug:         { label: 'Bug',         color: '#ef4444' },
  feature:     { label: 'Feature',     color: '#8b5cf6' },
  improvement: { label: 'Improvement', color: '#06b6d4' },
};

function TypePill({ type }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.task;
  return (
    <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide" style={{ backgroundColor: `${cfg.color}18`, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

function TagChips({ labels = [] }) {
  if (!labels || labels.length === 0) return null;
  const visible = labels.slice(0, 3);
  const extra = labels.length - visible.length;
  return (
    <span className="inline-flex items-center gap-1 flex-shrink-0">
      {visible.map((t) => (
        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}>
          #{t}
        </span>
      ))}
      {extra > 0 && (
        <span className="text-[10px]" style={{ color: colors.textSecondary }}>+{extra}</span>
      )}
    </span>
  );
}

function stageIndex(s) { const i = STAGE_ORDER.indexOf(s || 'idea'); return i < 0 ? 0 : i; }

function StagePill({ stage }) {
  const cfg = STAGE_CONFIG[stage] || STAGE_CONFIG.idea;
  const Icon = cfg.icon;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: `${cfg.color}18`, color: cfg.color }}>
      <Icon size={10} /> {cfg.label}
    </span>
  );
}

function MiniPipeline({ stage }) {
  const curIdx = stageIndex(stage);
  return (
    <div className="flex items-center gap-0.5">
      {STAGE_ORDER.map((s, i) => {
        const cfg = STAGE_CONFIG[s];
        const active = i === curIdx;
        const past = i < curIdx;
        return (
          <div key={s} className="flex items-center">
            <div
              className="h-1.5 w-5 rounded-sm"
              style={{
                backgroundColor: active ? cfg.color : past ? `${cfg.color}70` : colors.surface3,
              }}
              title={cfg.label}
            />
            {i < STAGE_ORDER.length - 1 && <div className="w-0.5" />}
          </div>
        );
      })}
    </div>
  );
}

function AdvanceModal({ item, toStage, onClose, onSubmit }) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const isDone = toStage === 'done';

  useEffect(() => {
    if (isDone) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const path = item.kind === 'issue'
      ? `/api/issues/${item.id}/stage-prompt?toStage=${toStage}`
      : `/api/sessions/${item.id}/stage-prompt?toStage=${toStage}`;
    apiFetch(path).then((res) => {
      if (cancelled) return;
      setPrompt(res?.prompt || '');
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item.id, item.kind, toStage, isDone]);

  const cfg = STAGE_CONFIG[toStage];
  const Icon = cfg?.icon || Sparkles;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({ toStage, customPrompt: isDone ? null : prompt });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl overflow-hidden flex flex-col" style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}`, maxHeight: '85vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}`, backgroundColor: `${cfg?.color}10` }}>
          <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ backgroundColor: `${cfg?.color}20`, color: cfg?.color }}>
            <Icon size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold" style={{ color: colors.text }}>Advance to {cfg?.label}</div>
            <div className="text-xs truncate" style={{ color: colors.textSecondary }}>{item.id} · {item.title}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded cursor-pointer hover:opacity-80"><X size={16} style={{ color: colors.textSecondary }} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {isDone ? (
            <div className="text-sm" style={{ color: colors.text }}>
              Mark as <strong>Done</strong>? No agent will run — this just closes out the lifecycle.
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: colors.textSecondary }}>
              <Loader2 size={14} className="animate-spin" /> Loading prompt…
            </div>
          ) : (
            <>
              <div className="text-xs mb-2" style={{ color: colors.textSecondary }}>
                A new Claude session will run with this prompt. Edit it if you want.
              </div>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={16}
                className="w-full text-xs font-mono bg-transparent outline-none resize-none rounded-lg p-3"
                style={{ color: colors.text, border: `1px solid ${colors.border}`, backgroundColor: colors.surface2 }} />
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}` }}>
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md cursor-pointer" style={{ color: colors.textSecondary }}>Cancel</button>
          <button onClick={handleSubmit} disabled={submitting || (!isDone && (loading || !prompt.trim()))}
            className="text-xs px-3 py-1.5 rounded-md font-medium text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            style={{ backgroundColor: cfg?.color }}>
            {submitting ? <Loader2 size={12} className="animate-spin" /> : isDone ? <CheckCheck size={12} /> : <Rocket size={12} />}
            {submitting ? 'Starting…' : isDone ? 'Mark Done' : `Start ${cfg?.label} session`}
          </button>
        </div>
      </div>
    </div>
  );
}

function PipelineRow({ item, onGoToSession, onOpenIssue, onAdvance }) {
  const stage = item.stage || 'idea';
  const curIdx = stageIndex(stage);
  const next = curIdx < STAGE_ORDER.length - 1 ? STAGE_ORDER[curIdx + 1] : null;
  const nextCfg = next ? STAGE_CONFIG[next] : null;
  const NextIcon = nextCfg?.icon || Rocket;

  const primary = () => {
    if (item.kind === 'session') onGoToSession?.(item.id);
    else onOpenIssue?.(item);
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 cursor-pointer group transition-colors"
      style={{ borderBottom: `1px solid ${colors.border}` }}
      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = colors.surface2}
      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      onClick={primary}
    >
      <span className="flex-shrink-0" title={item.kind === 'session' ? 'Session' : 'Issue'}>
        {item.kind === 'session' ? (
          <MessageSquare size={14} style={{ color: colors.textSecondary }} />
        ) : (
          <CircleDot size={14} style={{ color: colors.textSecondary }} />
        )}
      </span>
      <span className="font-mono text-[10px] flex-shrink-0" style={{ color: colors.textSecondary, minWidth: '80px' }}>{item.id}</span>
      <TypePill type={item.type || 'task'} />
      <StagePill stage={stage} />
      <MiniPipeline stage={stage} />
      <span className="text-sm flex-1 min-w-0 truncate" style={{ color: colors.text }}>{item.title || 'Untitled'}</span>
      <TagChips labels={item.labels} />

      {item.owner_name && (
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: colors.textSecondary }}>{item.owner_name}</span>
      )}
      {item.assignee_name && (
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: colors.textSecondary }}>→ {item.assignee_name}</span>
      )}

      {next && (
        <button
          onClick={(e) => { e.stopPropagation(); onAdvance(item, next); }}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded cursor-pointer text-white flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ backgroundColor: nextCfg.color }}
          title={`Advance to ${nextCfg.label}`}
        >
          <NextIcon size={10} /> {nextCfg.label} <ArrowRight size={10} />
        </button>
      )}
    </div>
  );
}

const PAGE_SIZE = 30;

function SprintGroup({ group, onGoToSession, onOpenIssue, onAdvance, filters }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState(group.total || 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fetchedOnceRef = useRef(false);

  const sprintKey = group.sprintId || '__nosprint__';

  const loadMore = useCallback(async (reset = false) => {
    setLoading(true);
    setError(null);
    try {
      const offset = reset ? 0 : loaded;
      const data = await apiFetch(`/api/pipeline/groups/${encodeURIComponent(sprintKey)}/items?limit=${PAGE_SIZE}&offset=${offset}`);
      setItems(prev => reset ? (data.items || []) : [...prev, ...(data.items || [])]);
      setLoaded(offset + (data.items?.length || 0));
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e.message || 'Failed to load items');
    } finally {
      setLoading(false);
    }
  }, [loaded, sprintKey]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !fetchedOnceRef.current) {
      fetchedOnceRef.current = true;
      loadMore(true);
    }
  };

  const filteredItems = useMemo(() => {
    return items.filter(it => {
      if (filters.stage !== 'all' && (it.stage || 'idea') !== filters.stage) return false;
      if (filters.kind !== 'all' && it.kind !== filters.kind) return false;
      if (filters.type !== 'all' && (it.type || 'task') !== filters.type) return false;
      if (filters.tag && !(it.labels || []).map(l => l.toLowerCase()).includes(filters.tag.toLowerCase())) return false;
      return true;
    });
  }, [items, filters]);

  const isUnassigned = !group.sprintId;
  const hasMore = loaded < total;

  return (
    <div className="mb-3">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 px-4 py-2 rounded-md cursor-pointer transition-colors"
        style={{
          backgroundColor: isUnassigned ? 'rgba(251,191,36,0.08)' : colors.surface2,
          border: `1px solid ${isUnassigned ? 'rgba(251,191,36,0.25)' : colors.border}`,
        }}
      >
        {open ? <ChevronDown size={14} style={{ color: colors.textSecondary }} /> : <ChevronRight size={14} style={{ color: colors.textSecondary }} />}
        {isUnassigned ? <Filter size={12} style={{ color: '#f59e0b' }} /> : <Calendar size={12} style={{ color: colors.accent }} />}
        <span className="text-sm font-semibold" style={{ color: isUnassigned ? '#f59e0b' : colors.text }}>
          {group.sprintName}
        </span>
        {group.sprintStatus && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded uppercase" style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}>
            {group.sprintStatus}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}>
            {group.total}
          </span>
          <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
            {group.issueCount}i · {group.sessionCount}s
          </span>
        </div>
      </button>

      {open && (
        <div className="mt-1">
          {loading && items.length === 0 && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs" style={{ color: colors.textSecondary }}>
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div className="px-4 py-3 text-xs" style={{ color: '#ef4444' }}>{error}</div>
          )}
          {filteredItems.length > 0 && (
            <div className="rounded-md overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
              {filteredItems.map(item => (
                <PipelineRow key={`${item.kind}-${item.id}`} item={item} onGoToSession={onGoToSession} onOpenIssue={onOpenIssue} onAdvance={onAdvance} />
              ))}
            </div>
          )}
          {!loading && items.length > 0 && filteredItems.length === 0 && (
            <div className="px-4 py-3 text-xs" style={{ color: colors.textSecondary }}>Nothing matches the current filters in this loaded batch.</div>
          )}
          {hasMore && (
            <div className="flex items-center justify-center mt-2">
              <button
                onClick={() => loadMore(false)}
                disabled={loading}
                className="text-[11px] px-3 py-1.5 rounded cursor-pointer hover:opacity-80 disabled:opacity-50"
                style={{ backgroundColor: colors.surface2, color: colors.text, border: `1px solid ${colors.border}` }}
              >
                {loading ? 'Loading…' : `Load more (${loaded} / ${total})`}
              </button>
            </div>
          )}
          {!hasMore && items.length > 0 && (
            <div className="text-center text-[10px] mt-2" style={{ color: colors.textSecondary }}>
              All {total} items loaded
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Pipeline({ onGoToSession, onOpenIssue, onBack }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [advanceTarget, setAdvanceTarget] = useState(null);
  const [filters, setFilters] = useState({ stage: 'all', kind: 'all', type: 'all', tag: '' });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch('/api/pipeline/groups');
      setGroups(data?.groups || []);
    } catch (e) {
      setError(e.message || 'Failed to load pipeline');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const totals = useMemo(() => {
    let issues = 0, sessions = 0;
    for (const g of groups) {
      issues += g.issueCount || 0;
      sessions += g.sessionCount || 0;
    }
    return { issues, sessions };
  }, [groups]);

  const handleAdvance = async ({ toStage, customPrompt }) => {
    if (!advanceTarget) return;
    const item = advanceTarget.item;
    const path = item.kind === 'issue'
      ? `/api/issues/${item.id}/advance-stage`
      : `/api/sessions/${item.id}/advance-stage`;
    const result = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStage, customPrompt }),
    });
    refresh();
    if (result?.sessionId) onGoToSession?.(result.sessionId);
    return result;
  };

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: colors.bg }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        {onBack && (
          <button onClick={onBack} className="p-1 rounded cursor-pointer hover:opacity-80">
            <ArrowLeft size={16} style={{ color: colors.textSecondary }} />
          </button>
        )}
        <h2 className="text-sm font-semibold" style={{ color: colors.text }}>Pipeline</h2>
        <div className="flex items-center gap-1 text-[10px] font-mono" style={{ color: colors.textSecondary }}>
          <span>{totals.issues} issues</span>
          <span>·</span>
          <span>{totals.sessions} sessions</span>
        </div>
        <div className="flex-1" />

        {/* Stage filter */}
        <select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })}
          className="text-xs px-2 py-1 rounded outline-none cursor-pointer"
          style={{ backgroundColor: colors.surface2, color: colors.text, border: `1px solid ${colors.border}` }}>
          <option value="all">All stages</option>
          {STAGE_ORDER.map(s => <option key={s} value={s}>{STAGE_CONFIG[s].label}</option>)}
        </select>

        {/* Kind filter */}
        <select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}
          className="text-xs px-2 py-1 rounded outline-none cursor-pointer"
          style={{ backgroundColor: colors.surface2, color: colors.text, border: `1px solid ${colors.border}` }}>
          <option value="all">Sessions + Issues</option>
          <option value="session">Sessions only</option>
          <option value="issue">Issues only</option>
        </select>

        {/* Type filter */}
        <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}
          className="text-xs px-2 py-1 rounded outline-none cursor-pointer"
          style={{ backgroundColor: colors.surface2, color: colors.text, border: `1px solid ${colors.border}` }}>
          <option value="all">All types</option>
          {Object.entries(TYPE_CONFIG).map(([id, cfg]) => <option key={id} value={id}>{cfg.label}</option>)}
        </select>

        {/* Tag filter */}
        <input
          value={filters.tag}
          onChange={(e) => setFilters({ ...filters, tag: e.target.value })}
          placeholder="Tag…"
          className="text-xs px-2 py-1 rounded outline-none"
          style={{ backgroundColor: colors.surface2, color: colors.text, border: `1px solid ${colors.border}`, width: '100px' }}
        />

        <button onClick={refresh} className="p-1.5 rounded cursor-pointer hover:opacity-80" title="Refresh"
          style={{ backgroundColor: colors.surface2, border: `1px solid ${colors.border}` }}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} style={{ color: colors.textSecondary }} />}
        </button>
      </div>

      {/* Stage bar summary */}
      <div className="flex items-center gap-2 px-4 py-2 flex-shrink-0 overflow-x-auto" style={{ borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.surface }}>
        {STAGE_ORDER.map((s, i) => {
          const cfg = STAGE_CONFIG[s];
          const Icon = cfg.icon;
          return (
            <div key={s} className="flex items-center gap-1">
              <button
                onClick={() => setFilters({ ...filters, stage: filters.stage === s ? 'all' : s })}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md cursor-pointer transition-colors"
                style={{
                  backgroundColor: filters.stage === s ? `${cfg.color}22` : 'transparent',
                  color: filters.stage === s ? cfg.color : colors.textSecondary,
                  border: `1px solid ${filters.stage === s ? cfg.color : colors.border}`,
                }}
              >
                <Icon size={12} /> {cfg.label}
              </button>
              {i < STAGE_ORDER.length - 1 && <ArrowRight size={10} style={{ color: colors.textSecondary, opacity: 0.5 }} />}
            </div>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && groups.length === 0 ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: colors.textSecondary }}>
            <Loader2 size={14} className="animate-spin" /> Loading pipeline…
          </div>
        ) : error ? (
          <div className="text-xs" style={{ color: '#ef4444' }}>{error}</div>
        ) : groups.length === 0 ? (
          <div className="text-xs text-center py-12" style={{ color: colors.textSecondary }}>No items yet. Create a session or issue to get started.</div>
        ) : (
          groups.map((g) => (
            <SprintGroup
              key={g.sprintId || '__nosprint__'}
              group={g}
              onGoToSession={onGoToSession}
              onOpenIssue={onOpenIssue}
              onAdvance={(item, toStage) => setAdvanceTarget({ item, toStage })}
              filters={filters}
            />
          ))
        )}
      </div>

      {advanceTarget && (
        <AdvanceModal
          item={advanceTarget.item}
          toStage={advanceTarget.toStage}
          onClose={() => setAdvanceTarget(null)}
          onSubmit={handleAdvance}
        />
      )}
    </div>
  );
}
