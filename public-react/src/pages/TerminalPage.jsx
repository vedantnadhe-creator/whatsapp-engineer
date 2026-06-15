import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '../context/AuthContext'
import { useModels, useSessions } from '../hooks/useApi'
import Login from './Login'
import { ArrowLeft, Circle, RotateCw, TerminalSquare, PanelLeftClose, PanelLeft } from 'lucide-react'

// Interactive web terminal — /sessions/v2.
// A real person types into a real interactive `claude` REPL (no --print), so it
// bills from the Claude subscription pool, not the Agent SDK credit pool.
const XTERM_THEME = {
  background: '#0b0b0d',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#0b0b0d',
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
  const { user, loading, logout } = useAuth()
  const { models } = useModels()
  const { sessions } = useSessions(1, '')

  const [status, setStatus] = useState('connecting') // connecting | live | exited | error
  const [model, setModel] = useState('claude-opus-4-8')
  const [showSidebar, setShowSidebar] = useState(true)

  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const wsRef = useRef(null)
  const modelRef = useRef(model)
  modelRef.current = model

  // Init terminal once the user is authenticated.
  useEffect(() => {
    if (!user || !hostRef.current) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: XTERM_THEME,
      scrollback: 10000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let ws
    let reconnectTimer
    let disposed = false

    const connect = () => {
      if (disposed) return
      setStatus('connecting')
      ws = new WebSocket(wsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        fit.fit()
        ws.send(JSON.stringify({ type: 'start', cols: term.cols, rows: term.rows, model: modelRef.current }))
      }
      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (msg.type === 'output') term.write(msg.data)
        else if (msg.type === 'ready') { /* awaiting started */ }
        else if (msg.type === 'started') setStatus('live')
        else if (msg.type === 'exit') {
          setStatus('exited')
          term.write(`\r\n\x1b[90m── session exited (code ${msg.code}). Press ↻ to start a new one. ──\x1b[0m\r\n`)
        } else if (msg.type === 'error') {
          setStatus('error')
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`)
        }
      }
      ws.onclose = () => {
        if (disposed) return
        setStatus((s) => (s === 'exited' ? s : 'connecting'))
        reconnectTimer = setTimeout(connect, 2500)
      }
      ws.onerror = () => { try { ws.close() } catch {} }
    }

    const onData = term.onData((data) => {
      if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'input', data }))
    })

    const doFit = () => {
      try {
        fit.fit()
        if (wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch {}
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
      ro.disconnect()
      onData.dispose()
      try { ws?.close() } catch {}
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // Restart the PTY with the newly selected model.
  const restart = (nextModel) => {
    const term = termRef.current
    if (term) term.write('\r\n\x1b[90m── restarting…\x1b[0m\r\n')
    const ws = wsRef.current
    if (ws?.readyState === 1) {
      // Force a clean reconnect by closing; onclose reconnects and sends start with modelRef.
      ws.close()
    }
    if (nextModel) setModel(nextModel)
  }

  if (loading) return <div className="h-screen flex items-center justify-center bg-bg text-text-secondary font-mono text-sm">Loading…</div>
  if (!user) return <Login />

  const statusColor = status === 'live' ? '#7ee787' : status === 'connecting' ? '#f2cc60' : '#ff6b6b'
  const statusLabel = status === 'live' ? 'Live · subscription' : status === 'connecting' ? 'Connecting…' : status === 'exited' ? 'Exited' : 'Error'

  return (
    <div className="flex flex-col" style={{ height: '100dvh', backgroundColor: 'var(--c-bg)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <a
          href={window.location.pathname.startsWith('/sessions') ? '/sessions/' : '/'}
          className="flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded cursor-pointer"
          style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
        >
          <ArrowLeft size={13} /> Dashboard
        </a>
        <button
          onClick={() => setShowSidebar(s => !s)}
          className="p-1.5 rounded cursor-pointer"
          style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
          title={showSidebar ? 'Hide sessions' : 'Show sessions'}
        >
          {showSidebar ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
        </button>

        <div className="flex items-center gap-2 font-bold" style={{ color: 'var(--c-text)' }}>
          <TerminalSquare size={16} style={{ color: 'var(--c-accent)' }} />
          Terminal <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text-muted)' }}>v2</span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <select
            value={model}
            onChange={(e) => restart(e.target.value)}
            className="text-xs rounded px-2 py-1.5 cursor-pointer outline-none"
            style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            title="Model — applies on restart"
          >
            {(models?.length ? models : [{ id: 'claude-opus-4-8', name: 'Opus 4.8' }]).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button
            onClick={() => restart()}
            className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded cursor-pointer"
            style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
            title="Restart terminal"
          >
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
          <div className="w-64 shrink-0 flex flex-col" style={{ borderRight: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--c-text-muted)', borderBottom: '1px solid var(--c-border)' }}>
              Sessions ({sessions?.length || 0})
            </div>
            <div className="flex-1 overflow-y-auto">
              {(sessions || []).map(s => (
                <a
                  key={s.id}
                  href={`${window.location.pathname.startsWith('/sessions') ? '/sessions' : ''}/s/${s.id}`}
                  className="block px-3 py-2 text-xs cursor-pointer transition-colors"
                  style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  title={s.task || s.id}
                >
                  <div className="truncate" style={{ color: 'var(--c-text)' }}>{s.name || s.task || s.id}</div>
                  <div className="flex items-center gap-1.5 mt-0.5 font-mono text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                    <span>{s.status || '—'}</span>
                    {s.model && <span>· {s.model}</span>}
                  </div>
                </a>
              ))}
              {!sessions?.length && (
                <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--c-text-muted)' }}>No sessions yet.</div>
              )}
            </div>
          </div>
        )}

        {/* Terminal host */}
        <div className="flex-1 min-w-0 min-h-0" style={{ backgroundColor: XTERM_THEME.background }}>
          <div ref={hostRef} style={{ height: '100%', width: '100%', padding: '8px 10px' }} />
        </div>
      </div>
    </div>
  )
}
