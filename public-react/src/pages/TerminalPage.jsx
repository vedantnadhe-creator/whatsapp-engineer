import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useAuth } from '../context/AuthContext'
import {
  useModels, useSessions, renameSession, deleteSession, toggleBookmark, getTranscript,
  useCostStats, useAgents, useSprints, useIssues, useTeamMembers,
  runAgent, getSprintChangelog, requestIssueSummary, getIssueLastResponse, generateSprintChangelog,
  uploadFile,
  useUsers, usePhones, useCron, useAccessRequests,
  getClaudePrompt, saveClaudePrompt, getLearnings, saveLearnings, getAdminSettings, saveAdminSetting,
} from '../hooks/useApi'
import Login from './Login'
import ShareSessionModal from '../components/ShareSessionModal'
import CostView from '../components/CostView'
import AgentsView from '../components/AgentsView'
import SprintBoard from '../components/SprintBoard'
import { AdminModal, UsersPanel, PhonesPanel, PromptsPanel, LearningsPanel, CronPanel, AccessRequestsPanel, SettingsPanel } from '../components/AdminPanels'
import {
  ArrowLeft, Circle, RotateCw, TerminalSquare, PanelLeftClose, PanelLeft,
  Plus, Search, X, MoreVertical, GitFork, History, Share2, Pencil, Trash2, Star, Play,
  MessageSquare, SendHorizontal, Wrench, ChevronDown, LayoutGrid, Sparkles, DollarSign,
  ChevronRight, Loader2, Paperclip, CheckCircle2,
  Settings, Users, Phone, FileText, BookOpen, Clock, User as UserIcon, Bell, BellOff,
  Square, Copy, Check,
} from 'lucide-react'

// Completion chime — same triangle-wave arpeggio V1 plays when the bot finishes.
function playDoneBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const t0 = ctx.currentTime
    const tone = (freq, start, dur = 0.22) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, t0 + start)
      gain.gain.setValueAtTime(0, t0 + start)
      gain.gain.linearRampToValueAtTime(0.6, t0 + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + start + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + start); osc.stop(t0 + start + dur + 0.02)
    }
    tone(880, 0); tone(1320, 0.22); tone(1760, 0.44, 0.28)
    setTimeout(() => { try { ctx.close() } catch {} }, 1200)
  } catch {}
}

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

// Track a mobile viewport so the sidebar can become an overlay drawer and the
// header can condense. < 768px is the mobile breakpoint.
function useIsMobile(bp = 768) {
  const [m, setM] = useState(typeof window !== 'undefined' && window.innerWidth < bp)
  useEffect(() => {
    const f = () => setM(window.innerWidth < bp)
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [bp])
  return m
}

// Session status → dot colour. Same mapping V1 used (components/Sidebar.jsx):
//   running → green (+pulse) · completed → blue · failed → red · stopped/else → grey
// Driven now by the interactive PTY lifecycle (no SDK), not the Agent SDK.
const STATUS_COLORS = {
  running: 'var(--c-status-running)',
  completed: 'var(--c-status-completed)',
  failed: 'var(--c-status-failed)',
  error: 'var(--c-status-failed)',
  exited: 'var(--c-status-failed)',
  stopped: 'var(--c-text-muted)',
}
function statusColorFor(status) {
  return STATUS_COLORS[(status || '').toLowerCase()] || 'var(--c-text-muted)'
}
// Ported from V1's Sidebar StatusDot: a pulsing ring while running.
function StatusDot({ status, size = 8 }) {
  const color = statusColorFor(status)
  const running = (status || '').toLowerCase() === 'running'
  return (
    <span className="relative inline-flex shrink-0" style={{ height: size, width: size }}>
      {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ backgroundColor: color }} />}
      <span className="relative inline-flex rounded-full" style={{ height: size, width: size, backgroundColor: color }} />
    </span>
  )
}

export default function TerminalPage() {
  const { user, loading } = useAuth()
  const { models } = useModels()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const { sessions, totalPages, refresh: refreshSessions } = useSessions(page, search)
  const hasMore = page < (totalPages || 1)

  // Top-level workspace tab. 'chat' is the terminal/conversation; the others mount
  // the same feature views V1's dashboard uses (reused as-is, no fork).
  const [tab, setTab] = useState('chat') // chat | sprint | agents | cost
  const { cost, loading: costLoading, refresh: refreshCost } = useCostStats()
  const { agents, loading: agentsLoading, refresh: refreshAgents } = useAgents()
  const { issues, refresh: refreshIssues, createIssue, updateIssue, deleteIssue } = useIssues()
  const { sprints, createSprint, updateSprint, deleteSprint } = useSprints()
  const { members } = useTeamMembers()
  // Admin / settings data (mirrors V1's dashboard wiring).
  const { users, refresh: refreshUsers, addUser, deleteUser, resetPassword, updateUser } = useUsers()
  const { phones, refresh: refreshPhones, addPhone, removePhone } = usePhones()
  const { jobs, refresh: refreshCron, saveJob, deleteJob } = useCron()
  const { requests, refresh: refreshRequests, resolve } = useAccessRequests()
  const [adminPanel, setAdminPanel] = useState(null) // users|phones|prompts|learnings|cron|requests|settings
  const [claudePrompt, setClaudePrompt] = useState(''); const [promptLoading, setPromptLoading] = useState(false)
  const [learningsContent, setLearningsContent] = useState(''); const [learningsLoading, setLearningsLoading] = useState(false)
  const [adminSettings, setAdminSettings] = useState({})
  const [sessionFilter, setSessionFilter] = useState('all') // all | mine | saved
  // Work mode follows role, matching V1 (designer → design, tester → tester, else dev).
  const workMode = user?.role === 'designer' ? 'design' : (user?.role === 'tester' ? 'tester' : 'developer')

  const [status, setStatus] = useState('idle') // idle | connecting | live | exited | error
  const [viewOnly, setViewOnly] = useState(false) // read-only transcript view (no live PTY); show Resume to go live
  const [model, setModel] = useState('claude-opus-4-8')
  const isMobile = useIsMobile()
  const [showSidebar, setShowSidebar] = useState(typeof window !== 'undefined' ? window.innerWidth >= 768 : true)
  // View mode — 'chat' renders the server-extracted conversation (subscription
  // billed, no raw TUI); 'terminal' is the raw xterm. The xterm instance stays
  // mounted-but-hidden in chat mode so toggling back shows full live state.
  const [view, setView] = useState('chat') // chat | terminal
  const [messages, setMessages] = useState([]) // [{role, content, tool}] from `chat` frames
  const [working, setWorking] = useState(false) // Claude is mid-turn (live thinking box)
  const [notice, setNotice] = useState(null) // transient banner (e.g. backend auto-compact)
  const noticeTimerRef = useRef(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState([]) // [{url, fileName, path, name}] staged images
  const [uploading, setUploading] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [activeId, setActiveId] = useState(null)
  const [menuFor, setMenuFor] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [shareFor, setShareFor] = useState(null)
  const [forkFor, setForkFor] = useState(null) // session being forked (opens the fork dialog)
  const [creatingName, setCreatingName] = useState(null) // string while naming a new session inline
  const [notifySound, setNotifySound] = useState(true) // bell: chime when a turn completes (default on)
  const notifySoundRef = useRef(true)
  notifySoundRef.current = notifySound
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
  const forkPromptRef = useRef(null) // prompt to auto-send once a fork session boots
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
    setViewOnly(!!connRef.current.view) // optimistic until the server confirms live/attached

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
          if (c.view) {
            // Read-only open: attach if live, else server returns the transcript.
            ws.send(JSON.stringify({ type: 'view', terminalId: c.sessionId, cwd: c.cwd || undefined, cols: term.cols, rows: term.rows }))
          } else {
            ws.send(JSON.stringify({
              type: 'start', cols: term.cols, rows: term.rows, model: modelRef.current,
              sessionId: c.sessionId || undefined, resume: !!c.resume, fork: !!c.fork,
              cwd: c.cwd || undefined, name: c.name || undefined,
            }))
          }
        }
      }
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.type === 'output') term.write(msg.data)
        else if (msg.type === 'chat') {
          setMessages(Array.isArray(msg.messages) ? msg.messages : []); setWorking(!!msg.working)
          if (msg.viewOnly) setStatus('idle') // read-only transcript: no live PTY behind it
          // The backend pulses `turnDone` exactly once when the whole turn ends
          // (one continuous working span). Chime + float-to-top off that single
          // pulse — never re-derive "done" from `working` here, or a turn with N
          // tools would chime N times (the "buzzing 11 times" bug).
          if (msg.turnDone) { setTimeout(() => refreshSessions(), 500); if (notifySoundRef.current) playDoneBeep() }
        }
        else if (msg.type === 'notice') {
          setNotice(msg.message || ''); clearTimeout(noticeTimerRef.current)
          noticeTimerRef.current = setTimeout(() => setNotice(null), 7000)
        }
        else if (msg.type === 'pong') { /* keepalive */ }
        else if (msg.type === 'attached') { setStatus('live'); setViewOnly(false); if (msg.terminalId) assignedIdRef.current = msg.terminalId }
        // For an existing-row resume, keep highlight on the OliBot row id; for a
        // brand-new session the server-created row id IS the Claude uuid.
        else if (msg.type === 'started') {
          setStatus('live'); setViewOnly(false); assignedIdRef.current = msg.terminalId || msg.sessionId; if (!connRef.current.rowId) setActiveId(msg.sessionId); setTimeout(refreshSessions, 400)
          // Forked with an opening prompt → send it once the resumed session is ready.
          if (forkPromptRef.current) {
            const p = forkPromptRef.current; forkPromptRef.current = null
            setTimeout(() => {
              if (wsRef.current?.readyState === 1) {
                wsRef.current.send(JSON.stringify({ type: 'input', data: p }))
                setTimeout(() => { try { wsRef.current?.send(JSON.stringify({ type: 'input', data: '\r' })) } catch {} }, 80)
              }
            }, 5000)
          }
        }
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
    // Paste into the raw terminal: xterm only pastes on Ctrl+Shift+V (Ctrl+V/Cmd+V
    // otherwise sends a literal ^V to the shell), and can't take images at all.
    // Intercept the paste in the capture phase so it works with any paste shortcut:
    // images upload → their absolute path is typed in; plain text is sent verbatim.
    const onTermPaste = async (e) => {
      if (disposed || !e.clipboardData) return
      let files = Array.from(e.clipboardData.files || [])
      if (!files.length) {
        files = Array.from(e.clipboardData.items || [])
          .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
      }
      if (files.length) {
        e.preventDefault(); e.stopPropagation()
        for (const f of files) {
          try {
            const r = await uploadFile(f)
            if (r?.success && r.path && wsRef.current?.readyState === 1)
              wsRef.current.send(JSON.stringify({ type: 'input', data: r.path + ' ' }))
          } catch (_) {}
        }
        return
      }
      const text = e.clipboardData.getData('text/plain')
      if (text) {
        e.preventDefault(); e.stopPropagation()
        if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'input', data: text }))
      }
    }
    const hostEl = hostRef.current
    hostEl.addEventListener('paste', onTermPaste, true)
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
      try { hostEl.removeEventListener('paste', onTermPaste, true) } catch {}
      ro.disconnect(); onData.dispose()
      try { ws?.close() } catch {}
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, connReq.key])

  // Turn-finished side effects (chime + float-to-top) are driven by the backend's
  // single `turnDone` pulse in the `chat` handler above — NOT re-derived from the
  // `working` boolean here, which flickers across inter-tool spinner gaps.

  // Keep the chat pinned to the latest message when the user is near the bottom.
  useEffect(() => {
    if (view !== 'chat') return
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, view])

  // Scroll to bottom when a session is opened (messages first load)
  useEffect(() => {
    if (view !== 'chat') return
    const el = scrollRef.current
    if (!el || messages.length === 0) return
    // Use a small timeout to ensure DOM has updated with new messages
    const id = setTimeout(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    }, 0)
    return () => clearTimeout(id)
  }, [connReq.key, view])

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
    if (paths.length) toSend = `${text || 'Please review the attached file(s).'} ${paths.join(' ')}`
    wsRef.current.send(JSON.stringify({ type: 'input', data: toSend }))
    // Small gap so the TUI commits the (bracket-pasted) input before the submit.
    setTimeout(() => { try { wsRef.current?.send(JSON.stringify({ type: 'input', data: '\r' })) } catch {} }, 60)
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
    setDraft(''); setAttachments([])
  }
  const onDraftKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
  }
  // Stop the current turn — send Esc to the interactive REPL (validated: interrupts).
  const stopChat = () => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'input', data: '\x1b' }))
  }
  // Per-question actions: edit (load into composer), reload (resend as-is).
  const editText = (text) => { setDraft(text || ''); setTimeout(() => { try { draftRef.current?.focus() } catch {} }, 30) }
  const reloadText = (text) => {
    if (!text || working || wsRef.current?.readyState !== 1) return
    wsRef.current.send(JSON.stringify({ type: 'input', data: text }))
    setTimeout(() => { try { wsRef.current?.send(JSON.stringify({ type: 'input', data: '\r' })) } catch {} }, 60)
  }
  // Upload one or more files of any type (images, md, doc, xlsx, pdf, …) and
  // stage them as attachments. Images get a blob thumbnail; everything else
  // shows a file chip. All are handed to Claude by absolute path on send.
  const addFiles = async (files) => {
    const list = Array.from(files || [])
    if (!list.length) return
    setUploading(true)
    for (const f of list) {
      const isImage = f.type?.startsWith('image/')
      // Local blob preview renders instantly and reliably (V1 does the same);
      // the server url/path are kept for sending + history thumbnails.
      const previewUrl = isImage ? URL.createObjectURL(f) : null
      try {
        const r = await uploadFile(f)
        if (r?.success) setAttachments(a => [...a, { previewUrl, url: r.url, fileName: r.fileName, path: r.path, name: f.name, isImage }])
        else if (previewUrl) URL.revokeObjectURL(previewUrl)
      } catch (_) { if (previewUrl) URL.revokeObjectURL(previewUrl) }
    }
    setUploading(false)
  }
  const removeAttachment = (i) => setAttachments(a => {
    const gone = a[i]; if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
    return a.filter((_, idx) => idx !== i)
  })

  // New session: reveal an inline name field (no separate dialog). Enter creates.
  const beginNewSession = () => setCreatingName('')
  const confirmNewSession = () => {
    const name = (creatingName || '').trim()
    setCreatingName(null)
    setActiveId(null)
    setConnReq(c => ({ key: c.key + 1, sessionId: null, rowId: null, resume: false, fork: false, cwd: null, name: name || null }))
  }

  // Admin: open a panel, lazy-loading its data first where needed.
  const showAdmin = async (key) => {
    if (key === 'prompts') { setPromptLoading(true); try { const r = await getClaudePrompt(); setClaudePrompt(r?.prompt || r?.content || '') } catch (_) {} setPromptLoading(false) }
    if (key === 'learnings') { setLearningsLoading(true); try { const r = await getLearnings(); setLearningsContent(r?.content || '') } catch (_) {} setLearningsLoading(false) }
    if (key === 'settings') { try { const r = await getAdminSettings(); setAdminSettings(r || {}) } catch (_) {} }
    setAdminPanel(key)
  }
  const handleSavePrompt = async (text) => { setPromptLoading(true); try { await saveClaudePrompt(text); setClaudePrompt(text) } catch (_) {} setPromptLoading(false) }
  const handleSaveLearnings = async (text) => { setLearningsLoading(true); try { await saveLearnings(text); setLearningsContent(text) } catch (_) {} setLearningsLoading(false) }
  // Resume uses the mapped Claude session UUID (claude_session_id), NOT the OliBot
  // row id, and runs in the session's own working dir so Claude finds the transcript.
  const openSession = (s) => {
    setMenuFor(null); setActiveId(s.id); setTab('chat')
    if (isMobile) setShowSidebar(false) // collapse the drawer after picking on mobile
    // Sync the model picker to this session's actual model so opening it doesn't
    // trigger a needless model-switch respawn (and the dropdown reflects reality).
    if (s.model) setModel(s.model)
    setConnReq(c => ({ key: c.key + 1, sessionId: s.claude_session_id || s.id, rowId: s.id, resume: true, fork: false, cwd: s.working_dir || null, name: null }))
  }
  // Feature views (sprint/agents) hand back a session id to OPEN — not resume. We
  // attach if a live PTY is still up, else just show the saved transcript (no
  // Claude spawn). The user clicks Resume in the composer to actually continue it.
  const goToSession = (sessionId) => {
    if (!sessionId) return
    const s = (sessions || []).find(x => x.id === sessionId || x.claude_session_id === sessionId)
    setTab('chat'); setActiveId(s?.id || sessionId)
    setConnReq(c => ({ key: c.key + 1, sessionId: s?.claude_session_id || sessionId, rowId: s?.id || null, resume: false, fork: false, view: true, cwd: s?.working_dir || null, name: null }))
  }
  // Go live on the session currently being viewed read-only (the Resume button).
  const resumeActive = () => {
    const c = connRef.current
    if (!c.sessionId) return
    setViewOnly(false)
    setConnReq(p => ({ key: p.key + 1, sessionId: c.sessionId, rowId: c.rowId, resume: true, fork: false, view: false, cwd: c.cwd, name: null }))
  }
  // Fork a session with a chosen name and an optional opening prompt. The prompt
  // is auto-sent to the forked PTY once it boots (see the 'started' handler), so
  // the new session immediately answers the question you forked it to explore.
  const doFork = (s, name, prompt) => {
    setForkFor(null); setMenuFor(null)
    forkPromptRef.current = (prompt || '').trim() || null
    setActiveId(null); setTab('chat')
    setConnReq(c => ({ key: c.key + 1, sessionId: s.claude_session_id || s.id, rowId: null, resume: true, fork: true, cwd: s.working_dir || null, name: (name || '').trim() || null }))
  }
  const restart = (nextModel) => {
    if (nextModel) setModel(nextModel)
    // A model change (or ↻) on an existing session must go live as a real resume
    // so the new --model takes effect — not a read-only re-attach to the old PTY.
    if (nextModel) setViewOnly(false)
    setConnReq(c => ({ ...c, key: c.key + 1, view: nextModel ? false : c.view, resume: c.sessionId ? true : c.resume }))
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

  const activeSession = (sessions || []).find(s => s.id === activeId) || null
  // Connection + activity aware: green only while Claude is actively working,
  // blue (done) when connected and idle, amber connecting, red exited/error.
  const statusColor = status === 'live' ? (working ? 'var(--c-status-running)' : 'var(--c-status-completed)') : status === 'connecting' ? '#f2cc60' : status === 'idle' ? 'var(--c-text-muted)' : 'var(--c-status-failed)'
  const statusLabel = status === 'live' ? (working ? 'Working…' : 'Done') : status === 'connecting' ? 'Connecting…' : status === 'idle' ? 'No session' : status === 'exited' ? 'Exited' : 'Error'

  return (
    <div className="flex" style={{ height: '100dvh', backgroundColor: 'var(--c-bg)' }}>
      <NavRail tab={tab} setTab={setTab} isAdmin={user.isAdmin} onShowAdmin={showAdmin} pendingRequests={(requests || []).length} />
      <div className="flex flex-col flex-1 min-w-0">
      {/* Chat workspace stays mounted across tab switches so the live xterm + WS
          survive; it's just hidden when another feature tab is active. */}
      <div className="flex flex-col flex-1 min-h-0" style={{ display: tab === 'chat' ? 'flex' : 'none' }}>
      {/* Header */}
      <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <a href={window.location.pathname.startsWith('/sessions') ? '/sessions/' : '/'}
          className="hidden sm:flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded cursor-pointer"
          style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
          <ArrowLeft size={13} /> Dashboard
        </a>
        <button onClick={() => setShowSidebar(s => !s)} className="p-1.5 rounded cursor-pointer shrink-0"
          style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} title={showSidebar ? 'Hide sessions' : 'Show sessions'}>
          {showSidebar ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
        </button>
        <div className="hidden md:flex items-center gap-2 font-bold shrink-0" style={{ color: 'var(--c-text)' }}>
          <TerminalSquare size={16} style={{ color: 'var(--c-accent)' }} />
          OliBot <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text-muted)' }}>v2</span>
        </div>
        {activeSession && (
          <div className="flex items-center gap-2 min-w-0 md:pl-2" style={{ borderLeft: '1px solid var(--c-border)' }}>
            <span title={statusLabel} style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: statusColor, flexShrink: 0, marginLeft: 4 }} />
            <span className="truncate text-sm font-medium min-w-0" style={{ color: 'var(--c-text)', maxWidth: 220 }}>{activeSession.name || activeSession.task || activeSession.id}</span>
            <ModeTag mode={activeSession.mode} />
            {(activeSession.owner_name || activeSession.owner_email) && (
              <span className="hidden sm:flex items-center gap-1 text-xs shrink-0 px-1.5 py-0.5 rounded" style={{ color: 'var(--c-text-secondary)', backgroundColor: 'var(--c-surface-2)' }} title={activeSession.owner_name || activeSession.owner_email}>
                <UserIcon size={11} /> {activeSession.owner_name || activeSession.owner_email}
              </span>
            )}
            {/* Per-session quick actions — collapse on mobile (also in the sidebar menu) */}
            <div className="hidden sm:flex items-center gap-0.5 ml-1">
              <IconBtn title="Fork session" onClick={() => setForkFor(activeSession)}><GitFork size={14} /></IconBtn>
              <IconBtn title="Share session" onClick={() => setShareFor(activeSession)}><Share2 size={14} /></IconBtn>
              <IconBtn title="History" onClick={() => setHistoryFor(activeSession)}><History size={14} /></IconBtn>
            </div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-3 shrink-0">
          <IconBtn title={notifySound ? 'Sound on — chimes when a turn finishes (click to mute)' : 'Sound off — click to chime on finish'}
            onClick={() => setNotifySound(v => !v)} active={notifySound}>
            {notifySound ? <Bell size={15} /> : <BellOff size={15} />}
          </IconBtn>
          {/* View toggle — Chat (extracted conversation) vs raw Terminal */}
          <div className="flex items-center p-0.5 rounded-md" style={{ backgroundColor: 'var(--c-surface-2)', border: '1px solid var(--c-border)' }} role="tablist" aria-label="View mode">
            <ViewTab active={view === 'chat'} onClick={() => setView('chat')} icon={<MessageSquare size={13} />} label="Chat" />
            <ViewTab active={view === 'terminal'} onClick={() => setView('terminal')} icon={<TerminalSquare size={13} />} label="Terminal" />
          </div>
          <select value={model} onChange={(e) => restart(e.target.value)}
            className="hidden sm:block text-xs rounded px-2 py-1.5 cursor-pointer outline-none"
            style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)', maxWidth: 130 }} title="Model — applies on restart">
            {(models?.length ? models : [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }]).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button onClick={() => restart()} className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded cursor-pointer shrink-0"
            style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} title="Restart current session">
            <RotateCw size={14} /> <span className="hidden sm:inline">Restart</span>
          </button>
          <span className="flex items-center gap-1.5 text-xs font-mono shrink-0" style={{ color: 'var(--c-text-secondary)' }}>
            <Circle size={9} fill={statusColor} style={{ color: statusColor }} /> <span className="hidden lg:inline">{statusLabel}</span>
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* On mobile the sidebar is a fixed drawer over the workspace with a backdrop. */}
        {showSidebar && isMobile && (
          <div className="fixed inset-0 z-30" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }} onClick={() => setShowSidebar(false)} />
        )}
        {showSidebar && (
          <div className={`${isMobile ? 'fixed inset-y-0 left-14 z-40 max-w-[80vw]' : ''} w-72 shrink-0 flex flex-col`} style={{ borderRight: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
            <div className="p-2 flex gap-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
              {creatingName === null ? (
                <button onClick={beginNewSession} className="flex items-center justify-center gap-1.5 flex-1 text-xs font-medium text-white rounded px-2 py-1.5 cursor-pointer"
                  style={{ backgroundColor: 'var(--c-accent)' }}>
                  <Plus size={13} /> New session
                </button>
              ) : (
                <div className="flex items-center gap-1.5 flex-1 rounded px-2 py-1" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-accent)' }}>
                  <input autoFocus value={creatingName} onChange={(e) => setCreatingName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmNewSession(); if (e.key === 'Escape') setCreatingName(null) }}
                    onBlur={() => setCreatingName(null)}
                    placeholder="Name this session, then Enter"
                    className="flex-1 bg-transparent outline-none text-xs" style={{ color: 'var(--c-text)' }} />
                  <button onMouseDown={(e) => { e.preventDefault(); confirmNewSession() }} title="Create" className="cursor-pointer" style={{ color: 'var(--c-accent)' }}><Plus size={14} /></button>
                </div>
              )}
            </div>
            <div className="px-2 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <div className="relative flex items-center" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 6 }}>
                <Search size={13} className="ml-2 shrink-0" style={{ color: 'var(--c-text-muted)' }} />
                <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Search sessions…"
                  className="w-full bg-transparent outline-none px-2 py-1.5 text-sm" style={{ color: 'var(--c-text)' }} />
                {search && <button onClick={() => { setSearch(''); setPage(1) }} className="mr-1 p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={12} /></button>}
              </div>
            </div>
            {/* Filters: All / Mine / Saved */}
            <div className="px-2 py-1.5 flex gap-1" style={{ borderBottom: '1px solid var(--c-border)' }}>
              {[
                { key: 'all', label: `All (${(sessions || []).length})` },
                { key: 'mine', label: `Mine (${(sessions || []).filter(s => s.is_mine).length})` },
                { key: 'saved', label: `Saved (${(sessions || []).filter(s => s.bookmarked).length})` },
              ].map(({ key, label }) => (
                <button key={key} onClick={() => setSessionFilter(key)}
                  className="flex-1 text-[11px] font-medium rounded px-1.5 py-1 cursor-pointer transition-colors"
                  style={{ backgroundColor: sessionFilter === key ? 'var(--c-surface-2)' : 'transparent', color: sessionFilter === key ? 'var(--c-text)' : 'var(--c-text-secondary)' }}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto">
              {(sessionFilter === 'mine' ? (sessions || []).filter(s => s.is_mine) : sessionFilter === 'saved' ? (sessions || []).filter(s => s.bookmarked) : (sessions || [])).map(s => (
                <div key={s.id} className="relative group" style={{ borderBottom: '1px solid var(--c-border)' }}>
                  <div onClick={() => openSession(s)}
                    className="px-3 py-2 text-xs cursor-pointer transition-colors"
                    style={{ backgroundColor: activeId === s.id ? 'var(--c-surface-2)' : 'transparent' }}
                    onMouseEnter={(e) => { if (activeId !== s.id) e.currentTarget.style.backgroundColor = 'var(--c-surface)' }}
                    onMouseLeave={(e) => { if (activeId !== s.id) e.currentTarget.style.backgroundColor = 'transparent' }}>
                    <div className="flex items-center gap-1.5">
                      <span title={s.status || 'unknown'}><StatusDot status={s.status} size={7} /></span>
                      {s.bookmarked ? <Star size={11} fill="#f2cc60" style={{ color: '#f2cc60' }} /> : null}
                      <span className="truncate flex-1" style={{ color: 'var(--c-text)' }}>{s.name || s.task || s.id}</span>
                      <button onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === s.id ? null : s.id) }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}>
                        <MoreVertical size={13} />
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                      <ModeTag mode={s.mode} />
                      {(s.owner_name || s.owner_email) && (
                        <span className="flex items-center gap-0.5 truncate max-w-[90px]" style={{ color: 'var(--c-text-secondary)' }} title={s.owner_name || s.owner_email}>
                          <UserIcon size={9} /> {s.owner_name || s.owner_email}
                        </span>
                      )}
                      <span>· {s.status || '—'}</span>
                      {s.model && <span>· {s.model.replace('claude-', '')}</span>}
                    </div>
                  </div>
                  {menuFor === s.id && (
                    <div className="absolute right-2 top-8 z-20 rounded shadow-lg py-1 text-xs"
                      style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', minWidth: 150 }}
                      onMouseLeave={() => setMenuFor(null)}>
                      <MenuItem icon={<Play size={12} />} label="Open / Resume" onClick={() => openSession(s)} />
                      <MenuItem icon={<GitFork size={12} />} label="Fork" onClick={() => { setMenuFor(null); setForkFor(s) }} />
                      <MenuItem icon={<History size={12} />} label="History" onClick={() => { setMenuFor(null); setHistoryFor(s) }} />
                      <MenuItem icon={<Share2 size={12} />} label="Share" onClick={() => { setMenuFor(null); setShareFor(s) }} />
                      <MenuItem icon={<Pencil size={12} />} label="Rename" onClick={() => doRename(s)} />
                      <MenuItem icon={<Star size={12} />} label={s.bookmarked ? 'Unbookmark' : 'Bookmark'} onClick={() => doBookmark(s)} />
                      {user.isAdmin && <MenuItem icon={<Trash2 size={12} />} label="Delete" danger onClick={() => doDelete(s)} />}
                    </div>
                  )}
                </div>
              ))}
              {!(sessionFilter === 'mine' ? (sessions || []).filter(s => s.is_mine) : sessionFilter === 'saved' ? (sessions || []).filter(s => s.bookmarked) : (sessions || [])).length && (
                <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--c-text-muted)' }}>
                  {sessionFilter === 'mine' ? 'No sessions by you yet' : sessionFilter === 'saved' ? 'No saved sessions yet' : 'No sessions.'}
                </div>
              )}
              {hasMore && (
                <button onClick={() => setPage(p => p + 1)}
                  className="w-full text-[11px] font-medium py-2 cursor-pointer transition-colors"
                  style={{ color: 'var(--c-accent)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}>
                  Load more sessions
                </button>
              )}
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
              <button onClick={() => { setShowSidebar(true); beginNewSession() }} className="flex items-center gap-1.5 text-xs font-medium text-white rounded px-3 py-1.5 cursor-pointer" style={{ backgroundColor: 'var(--c-accent)' }}>
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
              {notice && (
                <div className="flex items-center gap-2 px-3 sm:px-5 py-2 text-xs font-medium border-b"
                  style={{ color: '#f2cc60', borderColor: 'var(--c-border)', backgroundColor: 'rgba(242,204,96,0.08)' }}>
                  <Loader2 size={13} className="animate-spin" style={{ flexShrink: 0 }} />
                  <span className="truncate">{notice}</span>
                </div>
              )}
              <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}
                onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 160) }}>
                <div className="mx-auto w-full px-3 sm:px-5 py-4 sm:py-6 flex flex-col gap-5 sm:gap-6" style={{ maxWidth: 760 }}>
                  {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-center py-20" style={{ color: 'var(--c-text-muted)' }}>
                      <MessageSquare size={26} />
                      <div className="text-sm">{viewOnly ? 'No saved messages for this session.' : status === 'live' ? 'Listening for the conversation…' : 'Connecting to the session…'}</div>
                      <div className="text-xs" style={{ color: 'var(--c-text-muted)' }}>{viewOnly ? 'Click Resume to start a live session.' : 'Messages are read live from the running Claude session.'}</div>
                    </div>
                  ) : groupTurns(messages).map((turn, i, arr) => (
                    <ChatTurn key={i} turn={turn} active={i === arr.length - 1 && working}
                      working={working} onEdit={editText} onReload={reloadText} />
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
              {viewOnly ? (
                <div className="flex items-center justify-between gap-3 px-3 sm:px-5 py-3 border-t" style={{ borderColor: 'var(--c-border)', backgroundColor: 'var(--c-surface)' }}>
                  <span className="text-xs flex items-center gap-1.5" style={{ color: 'var(--c-text-muted)' }}>
                    <History size={13} /> Viewing saved chat — not live.
                  </span>
                  <button onClick={resumeActive}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer"
                    style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>
                    <Play size={13} /> Resume to continue
                  </button>
                </div>
              ) : (
                <ChatComposer
                  draft={draft} setDraft={setDraft} onKeyDown={onDraftKey} onSend={sendChat}
                  disabled={status !== 'live'} inputRef={draftRef} status={status}
                  attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={removeAttachment} uploading={uploading}
                  working={working} onStop={stopChat}
                />
              )}
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
      {forkFor && <ForkModal session={forkFor} onClose={() => setForkFor(null)} onConfirm={(name, prompt) => doFork(forkFor, name, prompt)} />}

      {/* Admin & settings panels (reused from V1's dashboard) */}
      {adminPanel === 'users' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Team Members">
          <UsersPanel users={users} onAdd={async (data) => { await addUser(data); refreshUsers() }} onDelete={async (id) => { await deleteUser(id); refreshUsers() }} onResetPassword={async (id) => { await resetPassword(id) }} onUpdateUser={async (id, changes) => { await updateUser(id, changes) }} />
        </AdminModal>
      )}
      {adminPanel === 'phones' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Allowed Phones">
          <PhonesPanel phones={phones} onAdd={async (phone, label) => { await addPhone(phone, label); refreshPhones() }} onRemove={async (phone) => { await removePhone(phone); refreshPhones() }} />
        </AdminModal>
      )}
      {adminPanel === 'prompts' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="System Prompt (CLAUDE.md)">
          <PromptsPanel prompt={claudePrompt} onSave={handleSavePrompt} loading={promptLoading} />
        </AdminModal>
      )}
      {adminPanel === 'learnings' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Learnings (Self-Improving Knowledge)">
          <LearningsPanel content={learningsContent} onSave={handleSaveLearnings} loading={learningsLoading} />
        </AdminModal>
      )}
      {adminPanel === 'cron' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Cron Jobs">
          <CronPanel jobs={jobs} onSave={async (job) => { await saveJob(job); refreshCron() }} onDelete={async (id) => { await deleteJob(id); refreshCron() }} />
        </AdminModal>
      )}
      {adminPanel === 'requests' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Access Requests">
          <AccessRequestsPanel requests={requests} onResolve={async (id, approve) => { await resolve(id, approve); refreshRequests() }} />
        </AdminModal>
      )}
      {adminPanel === 'settings' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Settings">
          <SettingsPanel settings={adminSettings} onSave={async (key, value) => { await saveAdminSetting(key, value); setAdminSettings(prev => ({ ...prev, [key]: value })); if (key === 'show_all_sessions') refreshSessions() }} />
        </AdminModal>
      )}
    </div>
  )
}

// Slim icon rail switching the top-level workspace tab. Chat is the terminal /
// conversation; the rest mount V1's feature views (reused unchanged).
function NavRail({ tab, setTab, isAdmin, onShowAdmin, pendingRequests = 0 }) {
  const [adminOpen, setAdminOpen] = useState(false)
  const items = [
    { key: 'chat', icon: MessageSquare, label: 'Chat' },
    { key: 'sprint', icon: LayoutGrid, label: 'Sprints' },
    { key: 'agents', icon: Sparkles, label: 'Agents' },
    { key: 'cost', icon: DollarSign, label: 'Cost' },
  ]
  const adminItems = [
    { key: 'users', label: 'Users', icon: Users },
    { key: 'phones', label: 'Phones', icon: Phone },
    { key: 'prompts', label: 'Prompts', icon: FileText },
    { key: 'learnings', label: 'Learnings', icon: BookOpen },
    { key: 'cron', label: 'Cron', icon: Clock },
    { key: 'requests', label: 'Requests', icon: MessageSquare, badge: pendingRequests },
    { key: 'settings', label: 'Settings', icon: Settings },
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
      {isAdmin && (
        <div className="mt-auto relative">
          <button onClick={() => setAdminOpen(o => !o)} title="Admin & settings" aria-label="Admin"
            className="relative flex items-center justify-center rounded-lg cursor-pointer transition-colors"
            style={{ width: 44, height: 44, color: adminOpen ? 'var(--c-accent)' : 'var(--c-text-secondary)', backgroundColor: adminOpen ? 'color-mix(in srgb, var(--c-accent) 14%, transparent)' : 'transparent' }}
            onMouseEnter={(e) => { if (!adminOpen) e.currentTarget.style.backgroundColor = 'var(--c-surface-2)' }}
            onMouseLeave={(e) => { if (!adminOpen) e.currentTarget.style.backgroundColor = 'transparent' }}>
            <Settings size={17} />
            {pendingRequests > 0 && <span style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 99, backgroundColor: '#ff6b6b' }} />}
          </button>
          {adminOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAdminOpen(false)} />
              <div className="absolute bottom-0 left-full ml-1 z-50 rounded-lg shadow-lg py-1" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', minWidth: 160 }}>
                {adminItems.map(({ key, label, icon: Icon, badge }) => (
                  <button key={key} onClick={() => { setAdminOpen(false); onShowAdmin(key) }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-sm cursor-pointer text-left" style={{ color: 'var(--c-text)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}>
                    <Icon size={14} style={{ color: 'var(--c-text-secondary)' }} /> {label}
                    {badge > 0 && <span className="ml-auto text-[10px] px-1.5 rounded-full text-white" style={{ backgroundColor: '#ff6b6b' }}>{badge}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <a href={dashHref} title="Back to dashboard" aria-label="Back to dashboard"
        className={`${isAdmin ? '' : 'mt-auto'} flex items-center justify-center rounded-lg cursor-pointer transition-colors`}
        style={{ width: 44, height: 44, color: 'var(--c-text-muted)' }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--c-surface-2)'; e.currentTarget.style.color = 'var(--c-text)' }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--c-text-muted)' }}>
        <ArrowLeft size={17} />
      </a>
    </div>
  )
}

// Role tag for the board/header: designers and testers get a colored chip;
// developers (the default) get nothing.
function ModeTag({ mode }) {
  if (mode === 'design') return <span className="px-1 rounded text-[9px] font-semibold" style={{ backgroundColor: 'rgba(210,168,255,0.18)', color: '#d2a8ff' }}>design</span>
  if (mode === 'tester') return <span className="px-1 rounded text-[9px] font-semibold" style={{ backgroundColor: 'rgba(242,204,96,0.18)', color: '#f2cc60' }}>tester</span>
  return null
}

// Small action button under a user question (edit / reload).
function QActionBtn({ title, onClick, disabled, children }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className="flex items-center justify-center rounded cursor-pointer transition-colors"
      style={{ width: 24, height: 24, color: 'var(--c-text-muted)', opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.backgroundColor = 'var(--c-surface-2)'; e.currentTarget.style.color = 'var(--c-text)' } }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--c-text-muted)' }}>
      {children}
    </button>
  )
}
function CopyBtn({ text }) {
  const [done, setDone] = useState(false)
  return (
    <QActionBtn title={done ? 'Copied' : 'Copy'} onClick={() => {
      try { navigator.clipboard.writeText(text || '') } catch (_) {}
      setDone(true); setTimeout(() => setDone(false), 1200)
    }}>
      {done ? <Check size={12} style={{ color: '#7ee787' }} /> : <Copy size={12} />}
    </QActionBtn>
  )
}

function IconBtn({ title, onClick, active, children }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className="flex items-center justify-center rounded-md cursor-pointer transition-colors"
      style={{ width: 30, height: 30, color: active ? 'var(--c-accent)' : 'var(--c-text-secondary)', backgroundColor: active ? 'color-mix(in srgb, var(--c-accent) 14%, transparent)' : 'transparent' }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'var(--c-surface-2)' }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'transparent' }}>
      {children}
    </button>
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
      {icon} <span className="hidden sm:inline">{label}</span>
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

// Markdown renderer — ported verbatim from V1 (components/Workspace.jsx) so the
// V2 chat renders identically to the original Dashboard: react-markdown +
// remark-gfm, with react-syntax-highlighter (Prism / oneDark) for fenced code.
const colors = {
  bg: 'var(--c-bg)', surface: 'var(--c-surface)', surface2: 'var(--c-surface-2)',
  surface3: 'var(--c-surface-3)', border: 'var(--c-border)', text: 'var(--c-text)',
  textSecondary: 'var(--c-text-secondary)', accent: 'var(--c-accent)',
}

function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false)
  const code = String(children).replace(/\n$/, '')
  const handleCopy = () => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  return (
    <div className="relative my-2 rounded-lg overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ backgroundColor: colors.surface3 }}>
        <span className="font-mono text-[10px] uppercase" style={{ color: colors.textSecondary }}>{language || 'code'}</span>
        <button onClick={handleCopy} className="p-1 rounded hover:opacity-80 cursor-pointer" title="Copy code">
          {copied ? <Check size={12} style={{ color: 'var(--c-status-running)' }} /> : <Copy size={12} style={{ color: colors.textSecondary }} />}
        </button>
      </div>
      <SyntaxHighlighter language={language || 'text'} style={oneDark}
        customStyle={{ margin: 0, padding: '12px', fontSize: '13px', background: colors.surface, borderRadius: 0 }} wrapLongLines>
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

const markdownComponents = {
  code({ inline, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    if (!inline && (match || String(children).includes('\n'))) return <CodeBlock language={match?.[1]}>{children}</CodeBlock>
    return <code className="px-1.5 py-0.5 rounded font-mono text-sm" style={{ backgroundColor: colors.surface3 }} {...props}>{children}</code>
  },
  p({ children }) { return <p className="mb-2 last:mb-0">{children}</p> },
  ul({ children }) { return <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul> },
  ol({ children }) { return <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol> },
  li({ children }) { return <li>{children}</li> },
  h1({ children }) { return <h1 className="text-lg font-bold mb-2 mt-3 font-mono">{children}</h1> },
  h2({ children }) { return <h2 className="text-base font-bold mb-2 mt-3 font-mono">{children}</h2> },
  h3({ children }) { return <h3 className="text-sm font-bold mb-1 mt-2 font-mono">{children}</h3> },
  blockquote({ children }) { return <blockquote className="pl-3 my-2 italic" style={{ borderLeft: `2px solid ${colors.accent}`, color: colors.textSecondary }}>{children}</blockquote> },
  a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: colors.accent }}>{children}</a> },
  table({ children }) { return <div className="overflow-x-auto my-2"><table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>{children}</table></div> },
  th({ children }) { return <th className="text-left px-3 py-1.5 font-medium font-mono text-xs" style={{ borderBottom: `1px solid ${colors.border}`, color: colors.textSecondary }}>{children}</th> },
  td({ children }) { return <td className="px-3 py-1.5 text-sm" style={{ borderBottom: `1px solid ${colors.border}` }}>{children}</td> },
  hr() { return <hr className="my-3" style={{ borderColor: colors.border }} /> },
  strong({ children }) { return <strong className="font-semibold">{children}</strong> },
}
function Markdown({ children }) {
  return <div className="text-sm" style={{ color: 'var(--c-text)' }}><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{children || ''}</ReactMarkdown></div>
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
function ThinkingBox({ steps, active, done }) {
  const [open, setOpen] = useState(false)
  if (!steps.length && !active && !done) return null
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
function ChatTurn({ turn, active, working, onEdit, onReload }) {
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
        <div className="flex justify-end group/q">
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
            {u.text && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover/q:opacity-100 transition-opacity">
                <CopyBtn text={u.text} />
                <QActionBtn title="Edit & reuse" onClick={() => onEdit?.(u.text)}><Pencil size={12} /></QActionBtn>
                <QActionBtn title={working ? 'Wait for the current turn to finish' : 'Ask again'} disabled={working} onClick={() => onReload?.(u.text)}><RotateCw size={12} /></QActionBtn>
              </div>
            )}
          </div>
        </div>
      )}
      {(steps.length > 0 || active) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--c-text-secondary)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: 'var(--c-accent)', display: 'inline-block' }} /> Claude
          </div>
          {/* Every completed response shows the green ✓ Done; the live one shows Working…. */}
          <ThinkingBox steps={thinkingSteps} active={active} done={!active && steps.length > 0} />
          {answer && <Markdown>{answer.content}</Markdown>}
        </div>
      )}
    </div>
  )
}

function ChatComposer({ draft, setDraft, onKeyDown, onSend, disabled, inputRef, status, attachments = [], onAddFiles, onRemoveAttachment, uploading, working, onStop }) {
  const fileRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  // While Claude is working you can't start a new question — only Stop.
  const locked = disabled || working
  const canSend = !locked && (draft.trim() || attachments.length > 0)
  const onPaste = (e) => {
    // Files land in clipboardData.files in some browsers and only in .items in
    // others — check both so pasting any file (image, doc, xlsx, …) stages it.
    // Plain text falls through to the textarea's native paste.
    const cd = e.clipboardData
    if (!cd) return
    let files = Array.from(cd.files || [])
    if (!files.length) {
      files = Array.from(cd.items || [])
        .filter(it => it.kind === 'file')
        .map(it => it.getAsFile()).filter(Boolean)
    }
    if (files.length) { e.preventDefault(); onAddFiles(files) }
  }
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    if (e.dataTransfer?.files?.length) onAddFiles(e.dataTransfer.files)
  }
  return (
    <div className="shrink-0 px-3 sm:px-5 py-2.5 sm:py-3" style={{ borderTop: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
      <div className="mx-auto w-full" style={{ maxWidth: 760 }}>
        {/* Staged image attachments */}
        {(attachments.length > 0 || uploading) && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((a, i) => {
              const isImage = a.isImage ?? (a.previewUrl != null)
              return (
                <div key={i} className="relative group rounded-lg overflow-hidden flex items-center"
                  style={{ height: 56, width: isImage ? 56 : 'auto', maxWidth: 180, border: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface-2)' }}>
                  {isImage ? (
                    <img src={a.previewUrl || a.url} alt={a.name || 'image'} className="w-full h-full" style={{ objectFit: 'cover' }} />
                  ) : (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 min-w-0" title={a.name || a.fileName}>
                      <FileText size={16} className="shrink-0" style={{ color: 'var(--c-text-secondary)' }} />
                      <span className="truncate text-[11px]" style={{ color: 'var(--c-text)', maxWidth: 120 }}>{a.name || a.fileName}</span>
                    </div>
                  )}
                  <button onClick={() => onRemoveAttachment(i)} title="Remove"
                    className="absolute top-0.5 right-0.5 flex items-center justify-center rounded-full cursor-pointer"
                    style={{ width: 16, height: 16, backgroundColor: 'rgba(0,0,0,0.65)', color: '#fff' }}>
                    <X size={10} />
                  </button>
                </div>
              )
            })}
            {uploading && (
              <div className="flex items-center justify-center rounded-lg" style={{ width: 56, height: 56, border: '1px dashed var(--c-border)', color: 'var(--c-text-muted)' }}>
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl px-2 py-2"
          onDragOver={(e) => { e.preventDefault(); if (!locked) setDragOver(true) }}
          onDragLeave={() => setDragOver(false)} onDrop={locked ? undefined : onDrop}
          style={{ backgroundColor: 'var(--c-surface)', border: `1px solid ${dragOver ? 'var(--c-accent)' : 'var(--c-border)'}` }}>
          <input ref={fileRef} type="file" multiple hidden
            onChange={(e) => { onAddFiles(e.target.files); e.target.value = '' }} />
          <button onClick={() => fileRef.current?.click()} disabled={locked} title="Attach files"
            className="flex items-center justify-center rounded-lg cursor-pointer shrink-0 transition-colors"
            style={{ width: 32, height: 32, color: 'var(--c-text-secondary)', opacity: locked ? 0.4 : 1 }}
            onMouseEnter={(e) => { if (!locked) e.currentTarget.style.backgroundColor = 'var(--c-surface-2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}>
            <Paperclip size={16} />
          </button>
          <textarea
            ref={inputRef} value={draft} rows={1} onKeyDown={onKeyDown} onPaste={onPaste}
            onChange={(e) => { setDraft(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px' }}
            placeholder={disabled ? 'Session not live — switch to a running session to chat' : working ? 'Claude is working… press Stop to interrupt' : 'Message Claude…  (Enter to send, paste or drop files)'}
            disabled={locked}
            className="flex-1 bg-transparent outline-none resize-none text-sm py-1.5"
            style={{ color: 'var(--c-text)', maxHeight: 160, lineHeight: 1.5 }}
          />
          {working ? (
            <button onClick={onStop} title="Stop (interrupt)"
              className="flex items-center justify-center rounded-lg cursor-pointer shrink-0"
              style={{ width: 34, height: 34, backgroundColor: '#ff6b6b', color: '#fff' }}>
              <Square size={14} fill="#fff" />
            </button>
          ) : (
            <button onClick={onSend} disabled={!canSend} title="Send (Enter)"
              className="flex items-center justify-center rounded-lg cursor-pointer shrink-0 transition-opacity"
              style={{ width: 34, height: 34, backgroundColor: 'var(--c-accent)', color: '#fff', opacity: canSend ? 1 : 0.4 }}>
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11px] flex items-center gap-1.5" style={{ color: 'var(--c-text-muted)' }}>
          <Circle size={7} fill={working ? '#7ee787' : status === 'live' ? '#6cb6ff' : '#6e7681'} style={{ color: working ? '#7ee787' : status === 'live' ? '#6cb6ff' : '#6e7681' }} />
          {working ? 'Claude is working… — Stop to interrupt' : status === 'live' ? 'Connected to the live session · billed to subscription' : 'Reconnecting…'}
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

// Fork dialog: name the fork and (optionally) give it an opening prompt that's
// auto-sent once the forked session boots, so it starts by answering that.
function ForkModal({ session, onClose, onConfirm }) {
  const base = session.name || session.task || 'session'
  const [name, setName] = useState(`Fork of ${base}`.slice(0, 60))
  const [prompt, setPrompt] = useState('')
  const submit = () => onConfirm(name, prompt)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-lg flex flex-col" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <span className="font-bold text-sm flex items-center gap-1.5" style={{ color: 'var(--c-text)' }}><GitFork size={14} /> Fork session</span>
          <button onClick={onClose} className="cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={16} /></button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--c-text-secondary)' }}>Fork name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              className="text-sm rounded-lg px-3 py-2 outline-none"
              style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--c-text-secondary)' }}>Opening prompt <span style={{ color: 'var(--c-text-muted)' }}>(sent to the fork)</span></span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="e.g. Try a different approach: refactor this with a state machine instead."
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
              className="text-sm rounded-lg px-3 py-2 outline-none resize-none"
              style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', lineHeight: 1.5 }} />
          </label>
          <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
            The fork resumes this session's full context, then runs your prompt. Leave the prompt empty to fork without asking anything.
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--c-border)' }}>
          <button onClick={onClose} className="text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer" style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>Cancel</button>
          <button onClick={submit} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg cursor-pointer text-white" style={{ backgroundColor: 'var(--c-accent)' }}>
            <GitFork size={13} /> Create fork
          </button>
        </div>
      </div>
    </div>
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
