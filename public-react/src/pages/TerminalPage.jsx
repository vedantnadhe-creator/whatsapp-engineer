import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '../context/AuthContext'
import {
  useModels, useSessions, renameSession, deleteSession, toggleBookmark, getTranscript,
  useCostStats, useAgents, useSprints, useIssues, useTeamMembers,
  runAgent, getSprintChangelog, requestIssueSummary, getIssueLastResponse, generateSprintChangelog,
} from '../hooks/useApi'
import Login from './Login'
import ShareSessionModal from '../components/ShareSessionModal'
import CostView from '../components/CostView'
import AgentsView from '../components/AgentsView'
import SprintBoard from '../components/SprintBoard'
import {
  ArrowLeft, Circle, RotateCw, TerminalSquare, PanelLeftClose, PanelLeft,
  Plus, Search, X, MoreVertical, GitFork, History, Share2, Pencil, Trash2, Star, Play,
  MessageSquare, SendHorizontal, Wrench, ChevronDown, LayoutGrid, Sparkles, DollarSign,
} from 'lucide-react'

// Interactive web terminal — /sessions/v2. Real human typing → subscription-billed.
// Each session's id IS the Claude session UUID, so open/resume/fork map onto
// `claude --resume` / `--fork-session`.
const XTERM_THEME = {
  background: '#0b0b0d', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#0b0b0d',
  selectionBackground: 'rgba(255,255,255,0.18)',
  black: '#1c1c1f', red: '#ff6b6b', green: '#7ee787', yellow: '#f2cc60',
  blue: '#6cb6ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#d0d0d0',
  brightBlack: '#6e7681', brightRed: '#ff8585', brightGreen: '#a2f7b0',
  brightYellow: '#ffdf73', brightBlue: '#91cbff', brightMagenta: '#e0c1ff',
  brightCyan: '#a5f0f5', brightWhite: '#ffffff',
}

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = window.location.pathname.startsWith('/sessions') ? '/sessions' : ''
  return `${proto}//${window.location.host}${prefix}/term`
}

export default function TerminalPage() {
  const { user, loading } = useAuth()
  const { models } = useModels()

  const [search, setSearch] = useState('')
  const { sessions, refresh: refreshSessions } = useSessions(1, search)

  // Top-level workspace tab. 'chat' is the terminal/conversation; the others mount
  // the same feature views V1's dashboard uses (reused as-is, no fork).
  const [tab, setTab] = useState('chat') // chat | sprint | agents | cost
  const { cost, loading: costLoading, refresh: refreshCost } = useCostStats()
  const { agents, loading: agentsLoading, refresh: refreshAgents } = useAgents()
  const { issues, refresh: refreshIssues, createIssue, updateIssue, deleteIssue } = useIssues()
  const { sprints, createSprint, updateSprint, deleteSprint } = useSprints()
  const { members } = useTeamMembers()
  // Work mode follows role, matching V1 (designer → design, tester → tester, else dev).
  const workMode = user?.role === 'designer' ? 'design' : (user?.role === 'tester' ? 'tester' : 'developer')

  const [status, setStatus] = useState('idle') // idle | connecting | live | exited | error
  const [model, setModel] = useState('claude-opus-4-8')
  const [showSidebar, setShowSidebar] = useState(true)
  // View mode — 'chat' renders the server-extracted conversation (subscription
  // billed, no raw TUI); 'terminal' is the raw xterm. The xterm instance stays
  // mounted-but-hidden in chat mode so toggling back shows full live state.
  const [view, setView] = useState('chat') // chat | terminal
  const [messages, setMessages] = useState([]) // [{role, content, tool}] from `chat` frames
  const [draft, setDraft] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [activeId, setActiveId] = useState(null)
  const [menuFor, setMenuFor] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [shareFor, setShareFor] = useState(null)
  // Connection request — bump .key to (re)spawn the terminal with these params.
  // sessionId = Claude session UUID passed to --resume; rowId = OliBot row id (for
  // sidebar highlight; null for brand-new sessions); cwd = the session's working dir
  // so Claude finds the transcript in the right project folder.
  const [connReq, setConnReq] = useState({ key: 0, sessionId: null, rowId: null, resume: false, fork: false, cwd: null, name: null })

  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  const scrollRef = useRef(null)   // chat scroll container
  const draftRef = useRef(null)    // chat input textarea
  const viewRef = useRef(view)
  viewRef.current = view
  const connRef = useRef(connReq)
  connRef.current = connReq
  const modelRef = useRef(model)
  modelRef.current = model
  // The live PTY's terminal id (Claude uuid). Once set, reconnects RE-ATTACH to
  // the running process instead of spawning a new session (fixes repeat trust prompt).
  const assignedIdRef = useRef(null)

  // (Re)create the terminal + WS whenever the connection request changes.
  useEffect(() => {
    if (!user || !hostRef.current) return
    if (connReq.key === 0) return // nothing requested yet

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13, lineHeight: 1.2, cursorBlink: true, theme: XTERM_THEME,
      scrollback: 10000, allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let ws, reconnectTimer, pingTimer, disposed = false
    // Fresh connection request → forget any previous PTY id so the first open
    // sends start; later reconnects within this same session re-attach.
    assignedIdRef.current = null
    setMessages([]) // clear chat for the newly-requested session

    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      ws = new WebSocket(wsUrl())
      wsRef.current = ws
      ws.onopen = () => {
        fit.fit()
        if (assignedIdRef.current) {
          // Reconnect → re-attach to the still-running PTY.
          ws.send(JSON.stringify({ type: 'attach', terminalId: assignedIdRef.current, cols: term.cols, rows: term.rows }))
        } else {
          const c = connRef.current
          ws.send(JSON.stringify({
            type: 'start', cols: term.cols, rows: term.rows, model: modelRef.current,
            sessionId: c.sessionId || undefined, resume: !!c.resume, fork: !!c.fork,
            cwd: c.cwd || undefined, name: c.name || undefined,
          }))
        }
      }
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.type === 'output') term.write(msg.data)
        else if (msg.type === 'chat') setMessages(Array.isArray(msg.messages) ? msg.messages : [])
        else if (msg.type === 'pong') { /* keepalive */ }
        else if (msg.type === 'attached') { setStatus('live'); if (msg.terminalId) assignedIdRef.current = msg.terminalId }
        // For an existing-row resume, keep highlight on the OliBot row id; for a
        // brand-new session the server-created row id IS the Claude uuid.
        else if (msg.type === 'started') { setStatus('live'); assignedIdRef.current = msg.terminalId || msg.sessionId; if (!connRef.current.rowId) setActiveId(msg.sessionId); setTimeout(refreshSessions, 400) }
        else if (msg.type === 'forked') { assignedIdRef.current = msg.terminalId || msg.sessionId; setActiveId(msg.sessionId); setTimeout(refreshSessions, 400) }
        else if (msg.type === 'exit') { setStatus('exited'); assignedIdRef.current = null; term.write(`\r\n\x1b[90m── exited (code ${msg.code}). ↻ to start new. ──\x1b[0m\r\n`); setTimeout(refreshSessions, 400) }
        else if (msg.type === 'error') { setStatus('error'); term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`) }
      }
      ws.onclose = () => { if (disposed) return; setStatus((s) => s === 'exited' ? s : 'connecting'); reconnectTimer = setTimeout(connect, 2000) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }

    // Keepalive — app-level ping keeps the proxy from closing an idle WS.
    pingTimer = setInterval(() => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'ping' })) }, 25000)

    const onData = term.onData((data) => {
      if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'input', data }))
    })
    const doFit = () => {
      try { fit.fit(); if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch {}
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(hostRef.current)
    window.addEventListener('resize', doFit)

    connect()
    setTimeout(doFit, 60)

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      clearInterval(pingTimer)
      window.removeEventListener('resize', doFit)
      ro.disconnect(); onData.dispose()
      try { ws?.close() } catch {}
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, connReq.key])

  // Keep the chat pinned to the latest message when the user is near the bottom.
  useEffect(() => {
    if (view !== 'chat') return
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, view])

  // xterm can't size while hidden — refit when the chat tab/terminal becomes
  // visible again (returning from a feature tab, or toggling chat↔terminal).
  useEffect(() => {
    if (tab !== 'chat') return
    if (view === 'terminal') {
      const id = setTimeout(() => {
        try { fitRef.current?.fit(); termRef.current?.focus() } catch {}
        if (wsRef.current?.readyState === 1 && termRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }))
        }
      }, 50)
      return () => clearTimeout(id)
    } else {
      const id = setTimeout(() => { try { draftRef.current?.focus() } catch {} }, 50)
      return () => clearTimeout(id)
    }
  }, [view, tab])

  // Send a chat-mode message straight to the PTY stdin: the text, then Enter.
  // The PTY echoes it back through the headless emulator, so it reappears as a
  // parsed `user` bubble — same path a human typing in the terminal would take.
  const sendChat = () => {
    const text = draft.replace(/\s+$/, '')
    if (!text || wsRef.current?.readyState !== 1) return
    wsRef.current.send(JSON.stringify({ type: 'input', data: text }))
    // Small gap so the TUI commits the (bracket-pasted) input before the submit.
    setTimeout(() => { try { wsRef.current?.send(JSON.stringify({ type: 'input', data: '\r' })) } catch {} }, 40)
    setDraft('')
  }
  const onDraftKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
  }

  const startNew = () => {
    const name = window.prompt('Name this session (optional):', '')
    if (name === null) return // cancelled
    setActiveId(null)
    setConnReq(c => ({ key: c.key + 1, sessionId: null, rowId: null, resume: false, fork: false, cwd: null, name: name.trim() || null }))
  }
  // Resume uses the mapped Claude session UUID (claude_session_id), NOT the OliBot
  // row id, and runs in the session's own working dir so Claude finds the transcript.
  const openSession = (s) => {
    setMenuFor(null); setActiveId(s.id); setTab('chat')
    setConnReq(c => ({ key: c.key + 1, sessionId: s.claude_session_id || s.id, rowId: s.id, resume: true, fork: false, cwd: s.working_dir || null, name: null }))
  }
  // Feature views (sprint/agents) hand back a session id to open in the terminal.
  const goToSession = (sessionId) => {
    if (!sessionId) return
    const s = (sessions || []).find(x => x.id === sessionId || x.claude_session_id === sessionId)
    setTab('chat'); setActiveId(s?.id || sessionId)
    setConnReq(c => ({ key: c.key + 1, sessionId: s?.claude_session_id || sessionId, rowId: s?.id || null, resume: true, fork: false, cwd: s?.working_dir || null, name: null }))
  }
  const forkSession = (s) => {
    setMenuFor(null)
    setConnReq(c => ({ key: c.key + 1, sessionId: s.claude_session_id || s.id, rowId: null, resume: true, fork: true, cwd: s.working_dir || null, name: null }))
  }
  const restart = (nextModel) => {
    if (nextModel) setModel(nextModel)
    setConnReq(c => ({ ...c, key: c.key + 1 }))
  }

  const doRename = async (s) => {
    setMenuFor(null)
    const name = window.prompt('Rename session', s.name || s.task || '')
    if (name == null) return
    await renameSession(s.id, name.trim())
    refreshSessions()
  }
  const doDelete = async (s) => {
    setMenuFor(null)
    if (!window.confirm('Delete this session? (transcript stays in Claude history)')) return
    try { await deleteSession(s.id) } catch (e) { alert('Delete failed: ' + (e.message || e)) }
    refreshSessions()
  }
  const doBookmark = async (s) => { setMenuFor(null); await toggleBookmark(s.id); refreshSessions() }

  if (loading) return <div className="h-screen flex items-center justify-center bg-bg text-text-secondary font-mono text-sm">Loading…</div>
  if (!user) return <Login />

  const statusColor = status === 'live' ? '#7ee787' : status === 'connecting' ? '#f2cc60' : status === 'idle' ? '#6e7681' : '#ff6b6b'
  const statusLabel = status === 'live' ? 'Live · subscription' : status === 'connecting' ? 'Connecting…' : status === 'idle' ? 'No session' : status === 'exited' ? 'Exited' : 'Error'

  return (
    <div className="flex" style={{ height: '100dvh', backgroundColor: 'var(--c-bg)' }}>
      <NavRail tab={tab} setTab={setTab} />
      <div className="flex flex-col flex-1 min-w-0">
      {/* Chat workspace stays mounted across tab switches so the live xterm + WS
          survive; it's just hidden when another feature tab is active. */}
      <div className="flex flex-col flex-1 min-h-0" style={{ display: tab === 'chat' ? 'flex' : 'none' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <a href={window.location.pathname.startsWith('/sessions') ? '/sessions/' : '/'}
          className="flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded cursor-pointer"
          style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
          <ArrowLeft size={13} /> Dashboard
        </a>
        <button onClick={() => setShowSidebar(s => !s)} className="p-1.5 rounded cursor-pointer"
          style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} title={showSidebar ? 'Hide sessions' : 'Show sessions'}>
          {showSidebar ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
        </button>
        <div className="flex items-center gap-2 font-bold" style={{ color: 'var(--c-text)' }}>
          <TerminalSquare size={16} style={{ color: 'var(--c-accent)' }} />
          Terminal <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text-muted)' }}>v2</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {/* View toggle — Chat (extracted conversation) vs raw Terminal */}
          <div className="flex items-center p-0.5 rounded-md" style={{ backgroundColor: 'var(--c-surface-2)', border: '1px solid var(--c-border)' }} role="tablist" aria-label="View mode">
            <ViewTab active={view === 'chat'} onClick={() => setView('chat')} icon={<MessageSquare size={12} />} label="Chat" />
            <ViewTab active={view === 'terminal'} onClick={() => setView('terminal')} icon={<TerminalSquare size={12} />} label="Terminal" />
          </div>
          <select value={model} onChange={(e) => restart(e.target.value)}
            className="text-xs rounded px-2 py-1.5 cursor-pointer outline-none"
            style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} title="Model — applies on restart">
            {(models?.length ? models : [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }]).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button onClick={() => restart()} className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded cursor-pointer"
            style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} title="Restart current session">
            <RotateCw size={13} /> Restart
          </button>
          <span className="flex items-center gap-1.5 text-xs font-mono" style={{ color: 'var(--c-text-secondary)' }}>
            <Circle size={9} fill={statusColor} style={{ color: statusColor }} /> {statusLabel}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {showSidebar && (
          <div className="w-72 shrink-0 flex flex-col" style={{ borderRight: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
            <div className="p-2 flex gap-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <button onClick={startNew} className="flex items-center justify-center gap-1.5 flex-1 text-xs font-medium text-white rounded px-2 py-1.5 cursor-pointer"
                style={{ backgroundColor: 'var(--c-accent)' }}>
                <Plus size={13} /> New session
              </button>
            </div>
            <div className="px-2 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <div className="relative flex items-center" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 6 }}>
                <Search size={13} className="ml-2 shrink-0" style={{ color: 'var(--c-text-muted)' }} />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sessions…"
                  className="w-full bg-transparent outline-none px-2 py-1.5 text-sm" style={{ color: 'var(--c-text)' }} />
                {search && <button onClick={() => setSearch('')} className="mr-1 p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={12} /></button>}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {(sessions || []).map(s => (
                <div key={s.id} className="relative group" style={{ borderBottom: '1px solid var(--c-border)' }}>
                  <div onClick={() => openSession(s)}
                    className="px-3 py-2 text-xs cursor-pointer transition-colors"
                    style={{ backgroundColor: activeId === s.id ? 'var(--c-surface-2)' : 'transparent' }}
                    onMouseEnter={(e) => { if (activeId !== s.id) e.currentTarget.style.backgroundColor = 'var(--c-surface)' }}
                    onMouseLeave={(e) => { if (activeId !== s.id) e.currentTarget.style.backgroundColor = 'transparent' }}>
                    <div className="flex items-center gap-1.5">
                      {s.bookmarked ? <Star size={11} fill="#f2cc60" style={{ color: '#f2cc60' }} /> : null}
                      <span className="truncate flex-1" style={{ color: 'var(--c-text)' }}>{s.name || s.task || s.id}</span>
                      <button onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id) }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}>
                        <MoreVertical size={13} />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      {s.source === 'terminal' ? <span style={{ color: 'var(--c-accent)' }}>terminal</span> : <span>agent</span>}
                      <span>· {s.status || '—'}</span>
                      {s.model && <span>· {s.model.replace('claude-', '')}</span>}
                    </div>
                  </div>
                  {menuFor === s.id && (
                    <div className="absolute right-2 top-8 z-20 rounded shadow-lg py-1 text-xs"
                      style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', minWidth: 150 }}
                      onMouseLeave={() => setMenuFor(null)}>
                      <MenuItem icon={<Play size={12} />} label="Open / Resume" onClick={() => openSession(s)} />
                      <MenuItem icon={<GitFork size={12} />} label="Fork" onClick={() => forkSession(s)} />
                      <MenuItem icon={<History size={12} />} label="History" onClick={() => { setMenuFor(null); setHistoryFor(s) }} />
                      <MenuItem icon={<Share2 size={12} />} label="Share" onClick={() => { setMenuFor(null); setShareFor(s) }} />
                      <MenuItem icon={<Pencil size={12} />} label="Rename" onClick={() => doRename(s)} />
                      <MenuItem icon={<Star size={12} />} label={s.bookmarked ? 'Unbookmark' : 'Bookmark'} onClick={() => doBookmark(s)} />
                      {user.isAdmin && <MenuItem icon={<Trash2 size={12} />} label="Delete" danger onClick={() => doDelete(s)} />}
                    </div>
                  )}
                </div>
              ))}
              {!sessions?.length && <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--c-text-muted)' }}>No sessions.</div>}
            </div>
          </div>
        )}

        {/* Workspace — xterm host and the chat panel are stacked; the xterm stays
            sized at all times (so FitAddon can measure) and is just hidden under
            the chat panel in chat view. */}
        <div className="flex-1 min-w-0 min-h-0 relative" style={{ backgroundColor: XTERM_THEME.background }}>
          {connReq.key === 0 && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-sm" style={{ color: 'var(--c-text-muted)', backgroundColor: 'var(--c-bg)' }}>
              <TerminalSquare size={28} style={{ color: 'var(--c-text-muted)' }} />
              <div>Pick a session on the left, or</div>
              <button onClick={startNew} className="flex items-center gap-1.5 text-xs font-medium text-white rounded px-3 py-1.5 cursor-pointer" style={{ backgroundColor: 'var(--c-accent)' }}>
                <Plus size={13} /> New session
              </button>
            </div>
          )}

          {/* Raw terminal — always mounted; faded out (not unmounted) in chat view. */}
          <div ref={hostRef} aria-hidden={view !== 'terminal'}
            style={{
              position: 'absolute', inset: 0, padding: '8px 10px',
              opacity: view === 'terminal' ? 1 : 0,
              pointerEvents: view === 'terminal' ? 'auto' : 'none',
              transition: 'opacity 140ms ease-out',
            }} />

          {/* Chat — server-extracted conversation. */}
          {view === 'chat' && connReq.key !== 0 && (
            <div className="absolute inset-0 z-10 flex flex-col chat-fade" style={{ backgroundColor: 'var(--c-bg)' }}>
              <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}
                onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 160) }}>
                <div className="mx-auto w-full px-5 py-6 flex flex-col gap-5" style={{ maxWidth: 760 }}>
                  {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-center py-20" style={{ color: 'var(--c-text-muted)' }}>
                      <MessageSquare size={26} />
                      <div className="text-sm">{status === 'live' ? 'Listening for the conversation…' : 'Connecting to the session…'}</div>
                      <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>Messages are read live from the running Claude session.</div>
                    </div>
                  ) : messages.map((m, i) => <ChatMessage key={i} role={m.role} content={m.content} tool={m.tool} />)}
                </div>
              </div>
              {!atBottom && messages.length > 0 && (
                <button onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
                  className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full shadow-lg cursor-pointer"
                  style={{ bottom: 96, backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}>
                  <ChevronDown size={13} /> Latest
                </button>
              )}
              <ChatComposer
                draft={draft} setDraft={setDraft} onKeyDown={onDraftKey} onSend={sendChat}
                disabled={status !== 'live'} inputRef={draftRef} status={status}
              />
            </div>
          )}
        </div>
      </div>
      </div>
      {tab !== 'chat' && (
        <div className="flex-1 min-h-0 h-full overflow-hidden">
          {tab === 'cost' && (
            <CostView cost={cost} loading={costLoading} onRefresh={refreshCost} onGoToSession={goToSession} />
          )}
          {tab === 'agents' && (
            <AgentsView agents={agents} loading={agentsLoading} onRunAgent={async (agentId, note) => {
              const result = await runAgent(agentId, note)
              if (result?.sessionId) { setTimeout(() => { refreshSessions(); refreshAgents() }, 800); goToSession(result.sessionId) }
              return result
            }} />
          )}
          {tab === 'sprint' && (
            <SprintBoard
              onBack={() => setTab('chat')}
              issues={issues} refreshIssues={refreshIssues}
              onCreateIssue={(data) => createIssue({ mode: workMode, ...data })}
              onUpdateIssue={updateIssue} onDeleteIssue={deleteIssue}
              sprints={sprints} onCreateSprint={createSprint} onUpdateSprint={updateSprint} onDeleteSprint={deleteSprint}
              members={members} user={user} model={model}
              onGoToSession={goToSession}
              onGetChangelog={getSprintChangelog}
              onRequestIssueSummary={requestIssueSummary}
              onGetIssueLastResponse={getIssueLastResponse}
              onGenerateChangelog={async (sprintId, summaries) => {
                const result = await generateSprintChangelog(sprintId, summaries)
                if (result?.sessionId) { setTimeout(() => { refreshSessions(); refreshIssues() }, 1000); goToSession(result.sessionId) }
                return result
              }}
            />
          )}
        </div>
      )}
      </div>

      {historyFor && <HistoryModal session={historyFor} onClose={() => setHistoryFor(null)} />}
      {shareFor && <ShareSessionModal sessionId={shareFor.id} onClose={() => setShareFor(null)} />}
    </div>
  )
}

// Slim icon rail switching the top-level workspace tab. Chat is the terminal /
// conversation; the rest mount V1's feature views (reused unchanged).
function NavRail({ tab, setTab }) {
  const items = [
    { key: 'chat', icon: MessageSquare, label: 'Chat' },
    { key: 'sprint', icon: LayoutGrid, label: 'Sprints' },
    { key: 'agents', icon: Sparkles, label: 'Agents' },
    { key: 'cost', icon: DollarSign, label: 'Cost' },
  ]
  const dashHref = window.location.pathname.startsWith('/sessions') ? '/sessions/' : '/'
  return (
    <div className="shrink-0 flex flex-col items-center gap-1 py-3" style={{ width: 56, borderRight: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface)' }}>
      <div className="mb-2 flex items-center justify-center rounded-lg" style={{ width: 32, height: 32, backgroundColor: 'var(--c-accent)' }} title="OliBot v2">
        <TerminalSquare size={17} style={{ color: '#fff' }} />
      </div>
      {items.map(({ key, icon: Icon, label }) => {
        const active = tab === key
        return (
          <button key={key} onClick={() => setTab(key)} title={label} aria-label={label} aria-current={active}
            className="relative flex flex-col items-center justify-center gap-0.5 rounded-lg cursor-pointer transition-colors"
            style={{ width: 44, height: 44, color: active ? 'var(--c-accent)' : 'var(--c-text-secondary)', backgroundColor: active ? 'color-mix(in srgb, var(--c-accent) 14%, transparent)' : 'transparent' }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'var(--c-surface-2)' }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'transparent' }}>
            <Icon size={17} />
            <span className="text-[9px] font-medium leading-none">{label}</span>
          </button>
        )
      })}
      <a href={dashHref} title="Back to dashboard" aria-label="Back to dashboard"
        className="mt-auto flex items-center justify-center rounded-lg cursor-pointer transition-colors"
        style={{ width: 44, height: 44, color: 'var(--c-text-muted)' }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--c-surface-2)'; e.currentTarget.style.color = 'var(--c-text)' }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--c-text-muted)' }}>
        <ArrowLeft size={17} />
      </a>
    </div>
  )
}

function ViewTab({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} role="tab" aria-selected={active}
      className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded cursor-pointer transition-colors"
      style={{
        backgroundColor: active ? 'var(--c-surface-3)' : 'transparent',
        color: active ? 'var(--c-text)' : 'var(--c-text-secondary)',
      }}>
      {icon} {label}
    </button>
  )
}

// One conversation turn. Roles are visually distinct without being identical
// cards: user is an accent-tinted bubble on the right, assistant is open prose
// on the left, tool output is a quiet monospace block.
function ChatMessage({ role, content, tool }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="px-4 py-2.5 rounded-2xl rounded-br-md text-sm whitespace-pre-wrap break-words"
          style={{ maxWidth: '85%', backgroundColor: 'rgba(59,130,246,0.16)', color: 'var(--c-text)', border: '1px solid rgba(59,130,246,0.30)', lineHeight: 1.55 }}>
          {content}
        </div>
      </div>
    )
  }
  if (tool) {
    return (
      <div className="rounded-lg overflow-hidden" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium" style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}>
          <Wrench size={11} /> tool
        </div>
        <pre className="px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-words" style={{ color: 'var(--c-text-secondary)', maxHeight: 280, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0 }}>
          {content}
        </pre>
      </div>
    )
  }
  // assistant
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--c-text-secondary)' }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: 'var(--c-accent)', display: 'inline-block' }} />
        Claude
      </div>
      <div className="text-sm whitespace-pre-wrap break-words" style={{ color: 'var(--c-text)', lineHeight: 1.6 }}>
        {content}
      </div>
    </div>
  )
}

function ChatComposer({ draft, setDraft, onKeyDown, onSend, disabled, inputRef, status }) {
  return (
    <div className="shrink-0 px-5 py-3" style={{ borderTop: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
      <div className="mx-auto w-full" style={{ maxWidth: 760 }}>
        <div className="flex items-end gap-2 rounded-xl px-3 py-2" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
          <textarea
            ref={inputRef} value={draft} rows={1} onKeyDown={onKeyDown}
            onChange={(e) => { setDraft(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px' }}
            placeholder={disabled ? 'Session not live — switch to a running session to chat' : 'Message Claude…  (Enter to send, Shift+Enter for newline)'}
            disabled={disabled}
            className="flex-1 bg-transparent outline-none resize-none text-sm py-1"
            style={{ color: 'var(--c-text)', maxHeight: 160, lineHeight: 1.5 }}
          />
          <button onClick={onSend} disabled={disabled || !draft.trim()} title="Send (Enter)"
            className="flex items-center justify-center rounded-lg cursor-pointer shrink-0 transition-opacity"
            style={{ width: 34, height: 34, backgroundColor: 'var(--c-accent)', color: '#fff', opacity: disabled || !draft.trim() ? 0.4 : 1 }}>
            <SendHorizontal size={16} />
          </button>
        </div>
        <div className="mt-1.5 text-[11px] flex items-center gap-1.5" style={{ color: 'var(--c-text-muted)' }}>
          <Circle size={7} fill={status === 'live' ? '#7ee787' : '#6e7681'} style={{ color: status === 'live' ? '#7ee787' : '#6e7681' }} />
          {status === 'live' ? 'Connected to the live session · billed to subscription' : 'Reconnecting…'}
        </div>
      </div>
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2 w-full px-3 py-1.5 cursor-pointer text-left"
      style={{ color: danger ? '#ff6b6b' : 'var(--c-text)' }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}>
      {icon} {label}
    </button>
  )
}

function HistoryModal({ session, onClose }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let live = true
    getTranscript(session.id).then(d => { if (live) setData(d) }).catch(e => { if (live) setErr(e.message || String(e)) })
    return () => { live = false }
  }, [session.id])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg flex flex-col" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <span className="font-bold text-sm truncate" style={{ color: 'var(--c-text)' }}>{session.name || session.task || session.id}</span>
          <button onClick={onClose} className="cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={16} /></button>
        </div>
        <div className="overflow-y-auto p-4 flex flex-col gap-3">
          {err && <div className="text-xs" style={{ color: '#ff6b6b' }}>{err}</div>}
          {!data && !err && <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>Loading transcript…</div>}
          {data?.messages?.length === 0 && <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>No transcript yet for this session.</div>}
          {(data?.messages || []).map((m, i) => (
            <div key={i} className="text-xs">
              <div className="font-mono mb-0.5" style={{ color: m.role === 'user' ? 'var(--c-accent)' : 'var(--c-text-secondary)' }}>{m.role}</div>
              <div className="whitespace-pre-wrap" style={{ color: 'var(--c-text)' }}>{m.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
