// Agent Run Screen — replaces the single-session flow for orchestrated
// agents. The master session (driven by the server's master_agent.js loop)
// is the default view; every worker the master spawns via the
// spawn_sub_session tool appears in the left list and can be opened in the
// right pane. The user can chat with the master OR any worker — it's just a
// regular session from the chat input's perspective.
//
// Real-time: the server pushes `agent_child_spawned` over the same WebSocket
// we already have, so children appear without polling. The active chat is
// driven by the existing useSessionMessages hook (incremental updates on
// `session_message` events).

import { useState, useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Bot, User2, Play, Send, RefreshCw, ListChecks, X } from 'lucide-react';
import { useSessionMessages, sendMessage as sendMessageApi, getSessionChildren as getSessionChildrenApi, getAgentSprint as getAgentSprintApi } from '../hooks/useApi';

// Inline sprint setter — tiny, so we don't pull in a separate component.
function SprintBar({ agentId, onSprintChange }) {
    const [sprintName, setSprintName] = useState('');
    const [current, setCurrent] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        getAgentSprintApi(agentId)
            .then((r) => { if (!cancelled) { setCurrent(r); setSprintName(r?.sprintName || ''); } })
            .catch(() => { /* no sprint yet */ })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [agentId]);

    const save = async () => {
        if (!sprintName.trim() || saving) return;
        setSaving(true);
        try {
            const { setAgentSprint } = await import('../hooks/useApi');
            await setAgentSprint(agentId, sprintName.trim());
            setCurrent({ sprintName: sprintName.trim(), setAt: new Date().toISOString() });
            setEditing(false);
            onSprintChange?.(sprintName.trim());
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <span className="text-[11px] font-mono" style={{ color: 'var(--c-text-muted)' }}>loading sprint…</span>;
    }
    if (!current?.sprintName || editing) {
        return (
            <div className="flex items-center gap-1.5">
                <input
                    value={sprintName}
                    onChange={(e) => setSprintName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
                    placeholder="Sprint 47"
                    className="text-[11px] font-mono px-2 py-1 rounded outline-none"
                    style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
                />
                <button
                    onClick={save}
                    disabled={saving || !sprintName.trim()}
                    className="text-[11px] px-2 py-1 rounded font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: 'var(--c-accent)' }}
                >
                    {saving ? 'saving…' : 'Set sprint'}
                </button>
                {current?.sprintName && (
                    <button onClick={() => { setEditing(false); setSprintName(current.sprintName); }} className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                        cancel
                    </button>
                )}
            </div>
        );
    }
    return (
        <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded"
            style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
            title={`Set ${new Date(current.setAt).toLocaleString()}`}
        >
            <ListChecks size={11} /> Sprint: <span style={{ color: 'var(--c-text)' }}>{current.sprintName}</span>
        </button>
    );
}

// Tiny chat pane that talks to one session — reuses useSessionMessages so
// the same live-update plumbing as the rest of the app applies.
function ChatPane({ sessionId, isMaster, childName }) {
    const { messages, refresh, loading } = useSessionMessages(sessionId);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const scrollerRef = useRef(null);

    useEffect(() => {
        // Auto-scroll on new content.
        if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }, [messages]);

    const onSend = async () => {
        const text = draft.trim();
        if (!text || sending) return;
        setSending(true);
        setDraft('');
        try {
            await sendMessageApi(sessionId, { text });
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="h-full flex flex-col">
            <div
                ref={scrollerRef}
                className="flex-1 overflow-y-auto p-4 space-y-3"
                style={{ backgroundColor: 'var(--c-bg)' }}
            >
                {loading && messages.length === 0 && (
                    <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>Loading…</div>
                )}
                {messages.map((m, i) => (
                    <div
                        key={i}
                        className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[80%]"
                        style={{
                            backgroundColor: m.role === 'user' ? 'var(--c-surface-2)' : 'var(--c-surface)',
                            border: '1px solid var(--c-border)',
                            color: 'var(--c-text)',
                            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                        }}
                    >
                        <div className="text-[10px] uppercase font-mono mb-1" style={{ color: 'var(--c-text-muted)' }}>
                            {m.role === 'user' ? 'you' : (isMaster ? 'master' : (childName || 'worker'))}
                        </div>
                        {m.content}
                    </div>
                ))}
            </div>
            <div
                className="p-3 flex items-end gap-2"
                style={{ borderTop: '1px solid var(--c-border)' }}
            >
                <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            onSend();
                        }
                    }}
                    rows={1}
                    placeholder={isMaster ? 'Reply to the master agent…' : `Reply to ${childName || 'worker'}…`}
                    className="flex-1 px-3 py-2 text-sm rounded outline-none resize-none"
                    style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
                />
                <button
                    onClick={onSend}
                    disabled={!draft.trim() || sending}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs rounded text-white font-medium disabled:opacity-50"
                    style={{ backgroundColor: 'var(--c-accent)' }}
                >
                    <Send size={12} /> Send
                </button>
            </div>
        </div>
    );
}

export default function AgentRunPage({ agent, onBack, onSprintChange, websocketMessage }) {
    const [masterSessionId, setMasterSessionId] = useState(null);
    const [children, setChildren] = useState([]);
    const [activeId, setActiveId] = useState(null); // master OR a child id
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState(null);
    const childrenRef = useRef([]);

    // Keep ref in sync so the WS handler always sees the latest list.
    useEffect(() => { childrenRef.current = children; }, [children]);

    // Listen for new children on the shared WS.
    useEffect(() => {
        if (!websocketMessage) return;
        if (websocketMessage.type === 'agent_child_spawned' && websocketMessage.masterSessionId === masterSessionId) {
            const newChild = {
                id: websocketMessage.childSessionId,
                name: websocketMessage.name || websocketMessage.agentId,
                agentId: websocketMessage.agentId,
            };
            setChildren((prev) => {
                if (prev.find((c) => c.id === newChild.id)) return prev;
                return [...prev, newChild];
            });
            // Auto-select the most recent child so the user sees it appear.
            setActiveId(newChild.id);
        }
    }, [websocketMessage, masterSessionId]);

    const start = async (note) => {
        if (starting) return;
        setStarting(true);
        setError(null);
        try {
            const { runAgentOrchestrated } = await import('../hooks/useApi');
            const res = await runAgentOrchestrated(agent.id, note || '');
            if (res?.masterSessionId) {
                setMasterSessionId(res.masterSessionId);
                setActiveId(res.masterSessionId);
            } else {
                setError('Failed to start master session');
            }
        } catch (e) {
            setError(e?.message || 'Failed to start');
        } finally {
            setStarting(false);
        }
    };

    // Pre-start view — same as the old modal flow, but inline.
    if (!masterSessionId) {
        return (
            <div className="h-full flex items-center justify-center p-6" style={{ backgroundColor: 'var(--c-bg)' }}>
                <div className="w-full max-w-md rounded-lg p-5" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
                    <div className="flex items-center gap-3 mb-3">
                        <button onClick={onBack} className="p-1 rounded" style={{ color: 'var(--c-text-secondary)' }}>
                            <ArrowLeft size={16} />
                        </button>
                        <Bot size={20} style={{ color: 'var(--c-accent)' }} />
                        <h2 className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>{agent.name}</h2>
                    </div>
                    <p className="text-xs mb-4" style={{ color: 'var(--c-text-secondary)' }}>{agent.description}</p>
                    <div className="mb-3 flex items-center gap-2">
                        <span className="text-[11px] uppercase font-mono" style={{ color: 'var(--c-text-muted)' }}>Active sprint:</span>
                        <SprintBar agentId={agent.id} onSprintChange={onSprintChange} />
                    </div>
                    <StartForm onStart={start} starting={starting} error={error} />
                </div>
            </div>
        );
    }

    // Running view — master + children list + active chat.
    return (
        <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--c-bg)' }}>
            <div
                className="px-4 py-2.5 flex items-center gap-3"
                style={{ borderBottom: '1px solid var(--c-border)' }}
            >
                <button onClick={onBack} className="p-1 rounded" style={{ color: 'var(--c-text-secondary)' }}>
                    <ArrowLeft size={14} />
                </button>
                <Bot size={16} style={{ color: 'var(--c-accent)' }} />
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: 'var(--c-text)' }}>
                        {agent.name}
                    </div>
                    <div className="text-[11px] font-mono" style={{ color: 'var(--c-text-muted)' }}>
                        Master: {masterSessionId.slice(0, 12)}… · {children.length} worker{children.length === 1 ? '' : 's'}
                    </div>
                </div>
                <SprintBar agentId={agent.id} onSprintChange={onSprintChange} />
            </div>
            <div className="flex-1 flex min-h-0">
                <div
                    className="w-64 shrink-0 overflow-y-auto p-2 space-y-1"
                    style={{ borderRight: '1px solid var(--c-border)' }}
                >
                    <SessionRow
                        active={activeId === masterSessionId}
                        onClick={() => setActiveId(masterSessionId)}
                        icon={<Bot size={12} />}
                        label="Master"
                        sub="coordinates workers"
                    />
                    {children.length > 0 && (
                        <div className="text-[10px] uppercase font-mono pt-2 pb-1 px-1.5" style={{ color: 'var(--c-text-muted)' }}>
                            Workers
                        </div>
                    )}
                    {children.map((c) => (
                        <SessionRow
                            key={c.id}
                            active={activeId === c.id}
                            onClick={() => setActiveId(c.id)}
                            icon={<User2 size={12} />}
                            label={c.name || c.agentId}
                            sub={c.id.slice(0, 12) + '…'}
                        />
                    ))}
                </div>
                <div className="flex-1 min-w-0">
                    {activeId ? (
                        <ChatPane
                            sessionId={activeId}
                            isMaster={activeId === masterSessionId}
                            childName={children.find((c) => c.id === activeId)?.name}
                        />
                    ) : (
                        <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                            Select a session to chat
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function SessionRow({ active, onClick, icon, label, sub }) {
    return (
        <button
            onClick={onClick}
            className="w-full text-left rounded px-2 py-1.5 flex items-center gap-2"
            style={{
                backgroundColor: active ? 'var(--c-surface-2)' : 'transparent',
                border: '1px solid ' + (active ? 'var(--c-border)' : 'transparent'),
            }}
        >
            <span style={{ color: 'var(--c-accent)' }}>{icon}</span>
            <span className="min-w-0 flex-1">
                <div className="text-xs truncate" style={{ color: 'var(--c-text)' }}>{label}</div>
                <div className="text-[10px] font-mono truncate" style={{ color: 'var(--c-text-muted)' }}>{sub}</div>
            </span>
        </button>
    );
}

function StartForm({ onStart, starting, error }) {
    const [note, setNote] = useState('');
    return (
        <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide mb-1.5" style={{ color: 'var(--c-text-secondary)' }}>
                Note (optional)
            </label>
            <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="e.g. Deploying admin-node + student-react. Sprint 47 hotfix."
                className="w-full px-2.5 py-2 text-sm outline-none rounded resize-none"
                style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }}
            />
            {error && <p className="text-xs mt-2" style={{ color: '#ef4444' }}>{error}</p>}
            <div className="flex justify-end mt-3">
                <button
                    onClick={() => onStart(note)}
                    disabled={starting}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded text-white font-medium disabled:opacity-50"
                    style={{ backgroundColor: 'var(--c-accent)' }}
                >
                    <Play size={12} /> {starting ? 'Starting…' : 'Start master session'}
                </button>
            </div>
        </div>
    );
}
