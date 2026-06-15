import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '../context/AuthContext'
import { useModels, useSessions, renameSession, deleteSession, toggleBookmark, getTranscript } from '../hooks/useApi'
import Login from './Login'
import ShareSessionModal from '../components/ShareSessionModal'
import {
  ArrowLeft, Circle, RotateCw, TerminalSquare, PanelLeftClose, PanelLeft,
  Plus, Search, X, MoreVertical, GitFork, History, Share2, Pencil, Trash2, Star, Play,
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

  const [status, setStatus] = useState('idle') // idle | connecting | live | exited | error
  const [model, setModel] = useState('claude-opus-4-8')
  const [showSidebar, setShowSidebar] = useState(true)
  const [activeId, setActiveId] = useState(null)
  const [menuFor, setMenuFor] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [shareFor, setShareFor] = useState(null)
  // Connection request — bump .key to (re)spawn the terminal with these params.
  const [connReq, setConnReq] = useState({ key: 0, sessionId: null, resume: false, fork: false })

  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  const connRef = useRef(connReq)
  connRef.current = connReq
  const modelRef = useRef(model)
  modelRef.current = model

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

    let ws, reconnectTimer, disposed = false

    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      ws = new WebSocket(wsUrl())
      wsRef.current = ws
      ws.onopen = () => {
        fit.fit()
        const c = connRef.current
        ws.send(JSON.stringify({
          type: 'start', cols: term.cols, rows: term.rows, model: modelRef.current,
          sessionId: c.sessionId || undefined, resume: !!c.resume, fork: !!c.fork,
        }))
      }
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.type === 'output') term.write(msg.data)
        else if (msg.type === 'started') { setStatus('live'); setActiveId(msg.sessionId); setTimeout(refreshSessions, 400) }
        else if (msg.type === 'forked') { setActiveId(msg.sessionId); setTimeout(refreshSessions, 400) }
        else if (msg.type === 'exit') { setStatus('exited'); term.write(`\r\n\x1b[90m── exited (code ${msg.code}). ↻ to start new. ──\x1b[0m\r\n`); setTimeout(refreshSessions, 400) }
        else if (msg.type === 'error') { setStatus('error'); term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`) }
      }
      ws.onclose = () => { if (disposed) return; setStatus((s) => s === 'exited' ? s : 'connecting'); reconnectTimer = setTimeout(connect, 2500) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }

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
      window.removeEventListener('resize', doFit)
      ro.disconnect(); onData.dispose()
      try { ws?.close() } catch {}
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, connReq.key])

  const startNew = () => { setActiveId(null); setConnReq(c => ({ key: c.key + 1, sessionId: null, resume: false, fork: false })) }
  const openSession = (s) => { setMenuFor(null); setActiveId(s.id); setConnReq(c => ({ key: c.key + 1, sessionId: s.id, resume: true, fork: false })) }
  const forkSession = (s) => { setMenuFor(null); setConnReq(c => ({ key: c.key + 1, sessionId: s.id, resume: true, fork: true })) }
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
    <div className="flex flex-col" style={{ height: '100dvh', backgroundColor: 'var(--c-bg)' }}>
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

        {/* Terminal host */}
        <div className="flex-1 min-w-0 min-h-0 relative" style={{ backgroundColor: XTERM_THEME.background }}>
          {connReq.key === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm" style={{ color: 'var(--c-text-muted)' }}>
              <TerminalSquare size={28} style={{ color: 'var(--c-text-muted)' }} />
              <div>Pick a session on the left, or</div>
              <button onClick={startNew} className="flex items-center gap-1.5 text-xs font-medium text-white rounded px-3 py-1.5 cursor-pointer" style={{ backgroundColor: 'var(--c-accent)' }}>
                <Plus size={13} /> New session
              </button>
            </div>
          )}
          <div ref={hostRef} style={{ height: '100%', width: '100%', padding: '8px 10px', display: connReq.key === 0 ? 'none' : 'block' }} />
        </div>
      </div>

      {historyFor && <HistoryModal session={historyFor} onClose={() => setHistoryFor(null)} />}
      {shareFor && <ShareSessionModal sessionId={shareFor.id} onClose={() => setShareFor(null)} />}
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
