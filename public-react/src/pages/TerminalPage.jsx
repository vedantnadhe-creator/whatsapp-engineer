import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuth } from '../context/AuthContext'
import {
  useModels, useSessions, renameSession, deleteSession, toggleBookmark, getTranscript,
  useCostStats, useAgents, useSprints, useIssues, useTeamMembers,
  runAgent, getSprintChangelog, requestIssueSummary, getIssueLastResponse, generateSprintChangelog,
  uploadFile,
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
  ChevronRight, Loader2, Paperclip, CheckCircle2,
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
  const [working, setWorking] = useState(false) // Claude is mid-turn (live thinking box)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState([]) // [{url, fileName, path, name}] staged images
  const [uploading, setUploading] = useState(false)
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
    setMessages([]); setWorking(false) // clear chat for the newly-requested session

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
        else if (msg.type === 'chat') { setMessages(Array.isArray(msg.messages) ? msg.messages : []); setWorking(!!msg.working) }
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
    if ((!text && attachments.length === 0) || wsRef.current?.readyState !== 1) return
    // Hand images to interactive Claude by absolute path — it reads them via its
    // Read tool. The paths echo back in the user bubble; the chat view turns any
    // /uploads/<file> reference into a thumbnail and hides the raw path text.
    let toSend = text
    const paths = attachments.map(a => a.path).filter(Boolean)
    if (paths.length) toSend = `${text || 'Please review the attached image(s).'} ${paths.join(' ')}`
    wsRef.current.send(JSON.stringify({ type: 'input', data: toSend }))
    // Small gap so the TUI commits the (bracket-pasted) input before the submit.
    setTimeout(() => { try { wsRef.current?.send(JSON.stringify({ type: 'input', data: '\r' })) } catch {} }, 60)
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
    setDraft(''); setAttachments([])
  }
  const onDraftKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
  }
  // Upload one or more image files and stage them as attachments.
  const addFiles = async (files) => {
    const imgs = Array.from(files || []).filter(f => f.type?.startsWith('image/'))
    if (!imgs.length) return
    setUploading(true)
    for (const f of imgs) {
      // Local blob preview renders instantly and reliably (V1 does the same);
      // the server url/path are kept for sending + history thumbnails.
      const previewUrl = URL.createObjectURL(f)
      try {
        const r = await uploadFile(f)
        if (r?.success) setAttachments(a => [...a, { previewUrl, url: r.url, fileName: r.fileName, path: r.path, name: f.name }])
        else URL.revokeObjectURL(previewUrl)
      } catch (_) { URL.revokeObjectURL(previewUrl) }
    }
    setUploading(false)
  }
  const removeAttachment = (i) => setAttachments(a => {
    const gone = a[i]; if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
    return a.filter((_, idx) => idx !== i)
  })

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
                <div className="mx-auto w-full px-5 py-6 flex flex-col gap-6" style={{ maxWidth: 760 }}>
                  {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-center py-20" style={{ color: 'var(--c-text-muted)' }}>
                      <MessageSquare size={26} />
                      <div className="text-sm">{status === 'live' ? 'Listening for the conversation…' : 'Connecting to the session…'}</div>
                      <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>Messages are read live from the running Claude session.</div>
                    </div>
                  ) : groupTurns(messages).map((turn, i, arr) => (
                    <ChatTurn key={i} turn={turn} active={i === arr.length - 1 && working} isLast={i === arr.length - 1} />
                  ))}
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
                attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={removeAttachment} uploading={uploading}
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

// Group the flat extracted message list into conversation turns: a user message
// and everything Claude does in response (intermediate text + tool calls + the
// final answer). One turn renders as one assistant block, mirroring V1.
function groupTurns(messages) {
  const turns = []
  let cur = null
  for (const m of messages) {
    if (m.role === 'user') { cur = { user: m, steps: [] }; turns.push(cur) }
    else { if (!cur) { cur = { user: null, steps: [] }; turns.push(cur) }; cur.steps.push(m) }
  }
  return turns
}

// A sent message echoes back with the attached images' absolute paths appended.
// Pull those /uploads/<file> references out into thumbnails and strip the raw
// path text from what we display. Whitespace is normalised first so a path that
// wrapped across terminal lines still matches.
// The app may be served under /sessions — resolve bare /api/* asset urls against
// that base (matches V1's UserContent). A raw /api/uploads/... 404s under /sessions.
const ASSET_BASE = window.location.pathname.startsWith('/sessions') ? '/sessions' : ''

const UPLOAD_RE = /uploads\/(\d{10,}-[a-z0-9]+\.(?:png|jpe?g|gif|webp|bmp|svg))/gi
function parseUserContent(content) {
  const raw = content || ''
  // Extract thumbnails from a whitespace-STRIPPED copy so a path that wrapped
  // across terminal lines (newline inside the filename) still matches.
  const images = []
  let m
  UPLOAD_RE.lastIndex = 0
  const joined = raw.replace(/\s+/g, '')
  while ((m = UPLOAD_RE.exec(joined))) images.push(`${ASSET_BASE}/api/uploads/${m[1]}`)
  // Display text: the appended paths always trail the user's text, so cut at the
  // first /uploads reference, then scrub any leftover path/filename fragments.
  let text = raw
  const cut = text.search(/\S*\/uploads/)
  if (cut >= 0) text = text.slice(0, cut)
  text = text
    .replace(/\S*\/?uploads\/\S*/gi, '')
    .replace(/\b\d{10,}-[a-z0-9]+\.(?:png|jpe?g|gif|webp|bmp|svg)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ').trim()
  return { text, images: [...new Set(images)] }
}

// Markdown renderer tuned for the dark chat surface. Compact, readable, fenced
// code in a monospace block, GFM tables/lists.
const MD = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0" style={{ lineHeight: 1.65 }}>{children}</p>,
  h1: ({ children }) => <h1 className="text-lg font-bold mt-4 mb-2" style={{ color: 'var(--c-text)' }}>{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold mt-4 mb-2" style={{ color: 'var(--c-text)' }}>{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold mt-3 mb-1.5" style={{ color: 'var(--c-text)' }}>{children}</h3>,
  ul: ({ children }) => <ul className="my-2 pl-5" style={{ listStyle: 'disc' }}>{children}</ul>,
  ol: ({ children }) => <ol className="my-2 pl-5" style={{ listStyle: 'decimal' }}>{children}</ol>,
  li: ({ children }) => <li className="my-0.5" style={{ lineHeight: 1.6 }}>{children}</li>,
  a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--c-accent)', textDecoration: 'underline' }}>{children}</a>,
  strong: ({ children }) => <strong style={{ color: 'var(--c-text)', fontWeight: 700 }}>{children}</strong>,
  blockquote: ({ children }) => <blockquote className="my-2 pl-3" style={{ borderLeft: '2px solid var(--c-border)', color: 'var(--c-text-secondary)' }}>{children}</blockquote>,
  hr: () => <hr className="my-3" style={{ border: 0, borderTop: '1px solid var(--c-border)' }} />,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="text-xs" style={{ borderCollapse: 'collapse' }}>{children}</table></div>,
  th: ({ children }) => <th className="px-2 py-1 text-left font-semibold" style={{ border: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface-2)' }}>{children}</th>,
  td: ({ children }) => <td className="px-2 py-1" style={{ border: '1px solid var(--c-border)' }}>{children}</td>,
  code: ({ inline, children }) => inline
    ? <code className="px-1 py-0.5 rounded text-[0.85em]" style={{ backgroundColor: 'var(--c-surface-2)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{children}</code>
    : <pre className="my-2 p-3 rounded-lg overflow-x-auto text-xs" style={{ backgroundColor: 'var(--c-surface-2)', border: '1px solid var(--c-border)' }}><code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: 1.5 }}>{children}</code></pre>,
}
function Markdown({ children }) {
  return <div className="text-sm" style={{ color: 'var(--c-text)' }}><ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{children || ''}</ReactMarkdown></div>
}

// A tool invocation + its output, shown as a quiet monospace block.
function ToolBlock({ content }) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium" style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}>
        <Wrench size={11} /> {(content.split('\n')[0] || 'tool').slice(0, 80)}
      </div>
      <pre className="px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-words" style={{ color: 'var(--c-text-secondary)', maxHeight: 240, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: 0 }}>
        {content.split('\n').slice(1).join('\n') || content}
      </pre>
    </div>
  )
}

// Collapsible "working" box holding the intermediate steps of a turn. Live while
// the turn is still running (active); a quiet, collapsed summary once finished.
function ThinkingBox({ steps, active, isLast }) {
  const [open, setOpen] = useState(false)
  if (!steps.length && !active && !isLast) return null
  const toolCount = steps.filter(s => s.tool).length
  const DONE_GREEN = '#7ee787'
  const label = active ? 'Working…' : `Done${toolCount ? ` · ${toolCount} tool${toolCount > 1 ? 's' : ''}` : ''}`
  const hasBody = steps.length > 0
  return (
    <div className="rounded-lg" style={{ backgroundColor: 'var(--c-surface)', border: `1px solid ${active ? 'color-mix(in srgb, var(--c-accent) 40%, var(--c-border))' : 'var(--c-border)'}` }}>
      <button onClick={() => hasBody && setOpen(o => !o)} className="flex items-center gap-2 w-full px-3 py-2 text-left text-xs font-medium"
        style={{ color: 'var(--c-text-secondary)', cursor: hasBody ? 'pointer' : 'default' }}>
        {active
          ? <Loader2 size={13} className="animate-spin" style={{ color: 'var(--c-accent)' }} />
          : <CheckCircle2 size={13} style={{ color: DONE_GREEN }} />}
        <span style={{ color: active ? 'var(--c-accent)' : DONE_GREEN }}>{label}</span>
        {!active && hasBody && <span className="ml-auto flex items-center gap-1" style={{ color: 'var(--c-text-muted)' }}>{open ? 'hide' : 'show'} {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>}
      </button>
      {(open || active) && steps.length > 0 && (
        <div className="px-3 pb-3 pt-0 flex flex-col gap-2">
          {steps.map((s, i) => s.tool
            ? <ToolBlock key={i} content={s.content} />
            : <div key={i} className="text-xs" style={{ color: 'var(--c-text-secondary)', lineHeight: 1.55 }}><Markdown>{s.content}</Markdown></div>
          )}
        </div>
      )}
    </div>
  )
}

// One full turn: the user bubble, a thinking box for intermediate work, and the
// final answer in markdown. While `active`, all steps stay in the live box and
// no answer is split out yet.
function ChatTurn({ turn, active, isLast }) {
  const steps = turn.steps
  let thinkingSteps = steps, answer = null
  if (!active) {
    // The last plain-assistant block is the final answer; the rest is "thinking".
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].role === 'assistant' && !steps[i].tool) { answer = steps[i]; thinkingSteps = steps.slice(0, i); break }
    }
  }
  const u = turn.user ? parseUserContent(turn.user.content) : null
  return (
    <div className="flex flex-col gap-3">
      {turn.user && (u.text || u.images.length > 0) && (
        <div className="flex justify-end">
          <div className="flex flex-col items-end gap-1.5" style={{ maxWidth: '85%' }}>
            {u.images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {u.images.map((src, i) => (
                  <a key={i} href={src} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden" style={{ border: '1px solid var(--c-border)' }}>
                    <img src={src} alt="attachment" style={{ maxWidth: 160, maxHeight: 160, objectFit: 'cover', display: 'block' }} />
                  </a>
                ))}
              </div>
            )}
            {u.text && (
              <div className="px-4 py-2.5 rounded-2xl rounded-br-md text-sm whitespace-pre-wrap break-words"
                style={{ backgroundColor: 'rgba(59,130,246,0.16)', color: 'var(--c-text)', border: '1px solid rgba(59,130,246,0.30)', lineHeight: 1.55 }}>
                {u.text}
              </div>
            )}
          </div>
        </div>
      )}
      {(thinkingSteps.length > 0 || active || isLast || answer) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--c-text-secondary)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: 'var(--c-accent)', display: 'inline-block' }} /> Claude
          </div>
          {(thinkingSteps.length > 0 || active || isLast) && (
            <ThinkingBox steps={thinkingSteps} active={active} isLast={isLast} />
          )}
          {answer && <Markdown>{answer.content}</Markdown>}
        </div>
      )}
    </div>
  )
}

function ChatComposer({ draft, setDraft, onKeyDown, onSend, disabled, inputRef, status, attachments = [], onAddFiles, onRemoveAttachment, uploading }) {
  const fileRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const canSend = !disabled && (draft.trim() || attachments.length > 0)
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter(f => f.type?.startsWith('image/'))
    if (files.length) { e.preventDefault(); onAddFiles(files) }
  }
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    if (e.dataTransfer?.files?.length) onAddFiles(e.dataTransfer.files)
  }
  return (
    <div className="shrink-0 px-5 py-3" style={{ borderTop: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
      <div className="mx-auto w-full" style={{ maxWidth: 760 }}>
        {/* Staged image attachments */}
        {(attachments.length > 0 || uploading) && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) => (
              <div key={i} className="relative group rounded-lg overflow-hidden" style={{ width: 56, height: 56, border: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface-2)' }}>
                <img src={a.previewUrl || a.url} alt={a.name || 'image'} className="w-full h-full" style={{ objectFit: 'cover' }} />
                <button onClick={() => onRemoveAttachment(i)} title="Remove"
                  className="absolute top-0.5 right-0.5 flex items-center justify-center rounded-full cursor-pointer"
                  style={{ width: 16, height: 16, backgroundColor: 'rgba(0,0,0,0.65)', color: '#fff' }}>
                  <X size={10} />
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex items-center justify-center rounded-lg" style={{ width: 56, height: 56, border: '1px dashed var(--c-border)', color: 'var(--c-text-muted)' }}>
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl px-2 py-2"
          onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true) }}
          onDragLeave={() => setDragOver(false)} onDrop={disabled ? undefined : onDrop}
          style={{ backgroundColor: 'var(--c-surface)', border: `1px solid ${dragOver ? 'var(--c-accent)' : 'var(--c-border)'}` }}>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { onAddFiles(e.target.files); e.target.value = '' }} />
          <button onClick={() => fileRef.current?.click()} disabled={disabled} title="Attach images"
            className="flex items-center justify-center rounded-lg cursor-pointer shrink-0 transition-colors"
            style={{ width: 32, height: 32, color: 'var(--c-text-secondary)', opacity: disabled ? 0.4 : 1 }}
            onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.backgroundColor = 'var(--c-surface-2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}>
            <Paperclip size={16} />
          </button>
          <textarea
            ref={inputRef} value={draft} rows={1} onKeyDown={onKeyDown} onPaste={onPaste}
            onChange={(e) => { setDraft(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px' }}
            placeholder={disabled ? 'Session not live — switch to a running session to chat' : 'Message Claude…  (Enter to send, paste or drop images)'}
            disabled={disabled}
            className="flex-1 bg-transparent outline-none resize-none text-sm py-1.5"
            style={{ color: 'var(--c-text)', maxHeight: 160, lineHeight: 1.5 }}
          />
          <button onClick={onSend} disabled={!canSend} title="Send (Enter)"
            className="flex items-center justify-center rounded-lg cursor-pointer shrink-0 transition-opacity"
            style={{ width: 34, height: 34, backgroundColor: 'var(--c-accent)', color: '#fff', opacity: canSend ? 1 : 0.4 }}>
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
