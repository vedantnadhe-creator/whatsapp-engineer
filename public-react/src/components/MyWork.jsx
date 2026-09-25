import { useState, useEffect, useCallback, useMemo } from 'react'
import { Bot, ArrowUp, ArrowDown, X, Play, Pause, Loader2, MessageSquare, FlaskConical, RefreshCw } from 'lucide-react'
import {
  getMyWork, getMyQueue, enqueueTasks, updateQueueSettings, updateQueueItem, removeQueueItem, openMyAgent,
} from '../hooks/useApi'
import { devStatusMeta, priorityMeta } from './sprintMeta'

// What each queue state means to the developer, in their words.
const QUEUE_STATUS = {
  queued: { label: 'Queued', color: 'var(--c-text-muted)' },
  running: { label: 'Running', color: '#f59e0b' },
  testing: { label: 'Jev testing', color: '#a78bfa' },
  needs_input: { label: 'Needs you', color: '#f87171' },
  dev_completed: { label: 'Dev Completed', color: '#3b82f6' },
  done: { label: 'Done', color: '#22c55e' },
}

const cell = { borderBottom: '1px solid var(--c-border)' }
const btn = 'inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md cursor-pointer disabled:opacity-50 disabled:cursor-default'
const btnStyle = { border: '1px solid var(--c-border)', color: 'var(--c-text-secondary)', backgroundColor: 'var(--c-surface)' }
const select = 'text-xs px-2 py-1.5 rounded-md outline-none cursor-pointer'
const selectStyle = { border: '1px solid var(--c-border)', color: 'var(--c-text)', backgroundColor: 'var(--c-surface)' }

// "My work": what is assigned to me, a queue that runs it as agent sessions N at a time
// (optionally handing each to Jev), and the questions those sessions are waiting on.
export default function MyWork({ model, wsOn, onGoToSession }) {
  const [work, setWork] = useState(null)
  const [queue, setQueue] = useState(null)
  const [selected, setSelected] = useState([])
  const [jevForNew, setJevForNew] = useState(true)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    try {
      const [w, q] = await Promise.all([getMyWork(), getMyQueue()])
      setWork(w); setQueue(q)
    } catch (e) { setMsg({ kind: 'error', text: e.message }) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!wsOn) return
    const offs = [wsOn('task_queue_updated', load), wsOn('issue_updated', load)]
    return () => offs.forEach(fn => fn?.())
  }, [wsOn, load])

  // Every call either returns the fresh queue or fails loudly — never a silent no-op.
  const run = async (key, fn, ok) => {
    setBusy(key); setMsg(null)
    try {
      const r = await fn()
      if (r?.items) setQueue(r)
      if (ok) setMsg({ kind: 'info', text: typeof ok === 'function' ? ok(r) : ok })
      getMyWork().then(setWork).catch(() => {})
    } catch (e) { setMsg({ kind: 'error', text: e.message }) }
    finally { setBusy(null) }
  }

  const items = queue?.items || []
  const settings = queue?.settings
  const active = items.filter(i => ['queued', 'running', 'testing', 'needs_input'].includes(i.status))
  const finished = items.filter(i => i.status === 'done' || i.status === 'dev_completed')
  const queueable = useMemo(() => (work?.issues || []).filter(i => !i.queue_status), [work])
  const allSelected = queueable.length > 0 && queueable.every(i => selected.includes(i.id))
  const toggle = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  const addToQueue = () => run('enqueue', () => enqueueTasks(selected, { jev: jevForNew, model }), (r) => {
    setSelected([])
    const skipped = r?.skipped?.length ? ` · ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s => s.reason))].join(', ')})` : ''
    return `Queued ${r?.added ?? 0} task${r?.added === 1 ? '' : 's'}${skipped}.`
  })
  const openAgent = () => run('agent', async () => { const r = await openMyAgent(); onGoToSession(r.sessionId) })

  if (!work || !queue) {
    return <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--c-text-muted)' }}><Loader2 size={14} className="animate-spin mr-2" />Loading your work…</div>
  }
  const c = work.counts

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--c-bg)' }}>
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-5 flex-wrap" style={{ minHeight: 52, borderBottom: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface)' }}>
        <h1 className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>My work</h1>
        <span className="text-xs tabular-nums" style={{ color: 'var(--c-text-secondary)' }}>
          {c.total} assigned · {c.todo} to do · {c.in_progress} in progress · {c.dev_completed} dev completed
          {work.questions > 0 && <> · <span style={{ color: '#f87171' }}>{work.questions} waiting on you</span></>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={load} className={btn} style={btnStyle} title="Refresh"><RefreshCw size={13} /></button>
          <button onClick={openAgent} disabled={busy === 'agent'} className={btn} style={btnStyle}>
            {busy === 'agent' ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}My agent
          </button>
        </div>
      </div>

      {msg && (
        <div className="px-5 py-2 text-xs" role={msg.kind === 'error' ? 'alert' : 'status'} style={{ color: msg.kind === 'error' ? '#f87171' : 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}>
          {msg.text}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {/* Queue */}
        <section className="px-5 pt-5">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>Queue</h2>
            <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--c-text-secondary)' }}>
              Run at a time
              <select value={settings.parallel} onChange={e => run('parallel', () => updateQueueSettings({ parallel: Number(e.target.value) }))} className={select} style={selectStyle} aria-label="Tasks to run at a time">
                {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--c-text-secondary)' }}>
              Jev on
              <select value={settings.device} onChange={e => run('device', () => updateQueueSettings({ device: e.target.value }))} className={select} style={selectStyle} aria-label="Jev device">
                <option value="pc">PC</option><option value="android">Android</option><option value="ios">iOS</option>
              </select>
              <select value={settings.browser} onChange={e => run('browser', () => updateQueueSettings({ browser: e.target.value }))} className={select} style={selectStyle} aria-label="Jev browser">
                <option value="chromium">Chromium</option><option value="firefox">Firefox</option><option value="webkit">WebKit</option>
              </select>
            </label>
            <button onClick={() => run('pause', () => updateQueueSettings({ paused: !settings.paused }))} className={btn} style={btnStyle}>
              {settings.paused ? <><Play size={13} />Resume</> : <><Pause size={13} />Pause</>}
            </button>
            {settings.paused && <span className="text-xs" style={{ color: '#f59e0b' }}>Paused — running tasks finish, nothing new starts.</span>}
          </div>

          {active.length === 0 && finished.length === 0 ? (
            <p className="text-xs py-6" style={{ color: 'var(--c-text-muted)' }}>Nothing queued. Pick tasks below and add them to the queue.</p>
          ) : (
            <table className="w-full text-xs border-collapse" style={{ border: '1px solid var(--c-border)' }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--c-text-secondary)', backgroundColor: 'var(--c-surface)' }}>
                  <th className="px-3 py-2 font-medium" style={cell}>Task</th>
                  <th className="px-3 py-2 font-medium w-32" style={cell}>Status</th>
                  <th className="px-3 py-2 font-medium w-20" style={cell}>Jev</th>
                  <th className="px-3 py-2 font-medium w-44" style={cell}>Sessions</th>
                  <th className="px-3 py-2 w-24" style={cell}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {[...active, ...finished].map(item => {
                  const st = QUEUE_STATUS[item.status] || QUEUE_STATUS.queued
                  const queuedIdx = active.filter(i => i.status === 'queued').findIndex(i => i.id === item.id)
                  const queuedCount = active.filter(i => i.status === 'queued').length
                  const waitingIn = item.phase === 'jev' ? item.jev_session_id : item.dev_session_id
                  return (
                    <tr key={item.id} style={{ backgroundColor: item.status === 'needs_input' ? 'rgba(248,113,113,0.06)' : 'transparent' }}>
                      <td className="px-3 py-2 align-top" style={cell}>
                        <div style={{ color: 'var(--c-text)' }}>{item.issue_title || item.issue_id}</div>
                        {item.sprint_name && <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>{item.sprint_name}</div>}
                        {item.status === 'needs_input' && item.question && (
                          <div className="mt-1.5 flex items-start gap-2">
                            <span className="text-[11px] leading-snug whitespace-pre-wrap" style={{ color: '#fca5a5' }}>{item.question}</span>
                            {waitingIn && (
                              <button onClick={() => onGoToSession(waitingIn)} className="shrink-0 text-[11px] underline cursor-pointer" style={{ color: 'var(--c-accent)' }}>Answer in session</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap" style={{ ...cell, color: st.color }}>
                        {(item.status === 'running' || item.status === 'testing') && <Loader2 size={11} className="inline animate-spin mr-1 -mt-0.5" />}
                        {st.label}
                        {item.verdict && <span className="ml-1" style={{ color: 'var(--c-text-muted)' }}>· {item.verdict}</span>}
                      </td>
                      <td className="px-3 py-2 align-top" style={cell}>
                        <input
                          type="checkbox"
                          checked={!!item.jev}
                          disabled={!['queued', 'running'].includes(item.status) || busy === item.id}
                          onChange={e => run(item.id, () => updateQueueItem(item.id, { jev: e.target.checked }))}
                          aria-label={`Test "${item.issue_title}" with Jev`}
                          className="cursor-pointer disabled:cursor-default"
                        />
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap" style={cell}>
                        <div className="flex items-center gap-3">
                          {item.dev_session_id && <button onClick={() => onGoToSession(item.dev_session_id)} className="inline-flex items-center gap-1 cursor-pointer hover:underline" style={{ color: 'var(--c-accent)' }}><MessageSquare size={12} />Dev</button>}
                          {item.jev_session_id && <button onClick={() => onGoToSession(item.jev_session_id)} className="inline-flex items-center gap-1 cursor-pointer hover:underline" style={{ color: '#a78bfa' }}><FlaskConical size={12} />Jev</button>}
                          {!item.dev_session_id && <span style={{ color: 'var(--c-text-muted)' }}>—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top" style={cell}>
                        <div className="flex items-center justify-end gap-1">
                          {item.status === 'queued' && <>
                            <button onClick={() => run(item.id, () => updateQueueItem(item.id, { move: 'up' }))} disabled={queuedIdx === 0} className="p-1 rounded cursor-pointer disabled:opacity-30 disabled:cursor-default hover:bg-[var(--c-surface-2)]" style={{ color: 'var(--c-text-secondary)' }} aria-label="Move up"><ArrowUp size={13} /></button>
                            <button onClick={() => run(item.id, () => updateQueueItem(item.id, { move: 'down' }))} disabled={queuedIdx === queuedCount - 1} className="p-1 rounded cursor-pointer disabled:opacity-30 disabled:cursor-default hover:bg-[var(--c-surface-2)]" style={{ color: 'var(--c-text-secondary)' }} aria-label="Move down"><ArrowDown size={13} /></button>
                          </>}
                          {item.status !== 'running' && item.status !== 'testing' && (
                            <button onClick={() => run(item.id, () => removeQueueItem(item.id))} className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)]" style={{ color: 'var(--c-text-muted)' }} aria-label={item.status === 'queued' || item.status === 'needs_input' ? 'Remove from queue' : 'Clear from list'} title={item.status === 'queued' || item.status === 'needs_input' ? 'Remove from queue' : 'Clear from list'}><X size={13} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* Assigned to me */}
        <section className="px-5 pt-6 pb-24">
          <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--c-text)' }}>Assigned to me</h2>
          {work.issues.length === 0 ? (
            <p className="text-xs py-6" style={{ color: 'var(--c-text-muted)' }}>Nothing assigned to you.</p>
          ) : (
            <table className="w-full text-xs border-collapse" style={{ border: '1px solid var(--c-border)' }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--c-text-secondary)', backgroundColor: 'var(--c-surface)' }}>
                  <th className="px-3 py-2 w-8" style={cell}>
                    <input type="checkbox" checked={allSelected} disabled={!queueable.length} onChange={() => setSelected(allSelected ? [] : queueable.map(i => i.id))} aria-label="Select every task not already queued" className="cursor-pointer" />
                  </th>
                  <th className="px-3 py-2 font-medium" style={cell}>Task</th>
                  <th className="px-3 py-2 font-medium w-36" style={cell}>Sprint</th>
                  <th className="px-3 py-2 font-medium w-24" style={cell}>Priority</th>
                  <th className="px-3 py-2 font-medium w-32" style={cell}>Dev status</th>
                  <th className="px-3 py-2 font-medium w-28" style={cell}>Queue</th>
                </tr>
              </thead>
              <tbody>
                {work.issues.map(i => {
                  const pr = priorityMeta(i.priority)
                  const ds = devStatusMeta(i.dev_status)
                  const qs = i.queue_status ? QUEUE_STATUS[i.queue_status] : null
                  return (
                    <tr key={i.id} className="hover:bg-[var(--c-surface)]">
                      <td className="px-3 py-2" style={cell}>
                        <input type="checkbox" checked={selected.includes(i.id)} disabled={!!i.queue_status} onChange={() => toggle(i.id)} aria-label={`Select "${i.title}"`} className="cursor-pointer disabled:cursor-default" />
                      </td>
                      <td className="px-3 py-2" style={{ ...cell, color: 'var(--c-text)' }}>{i.title}</td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ ...cell, color: 'var(--c-text-secondary)' }}>{i.sprint_name || (i.is_backlog ? 'Backlog' : '—')}</td>
                      <td className="px-3 py-2" style={{ ...cell, color: pr.color }}>{pr.label}</td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ ...cell, color: ds.color }}>{ds.label}</td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ ...cell, color: qs?.color || 'var(--c-text-muted)' }}>{qs?.label || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Selection bar */}
      {selected.length > 0 && (
        <div className="flex items-center gap-4 px-5 py-3" style={{ borderTop: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface)' }}>
          <span className="text-xs" style={{ color: 'var(--c-text)' }}>{selected.length} selected</span>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--c-text-secondary)' }}>
            <input type="checkbox" checked={jevForNew} onChange={e => setJevForNew(e.target.checked)} />
            Test with Jev
          </label>
          <span className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
            {jevForNew ? 'Deployed to DEV and tested; a pass moves it to Done.' : 'Moves to Dev Completed when the session finishes.'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setSelected([])} className={btn} style={btnStyle}>Clear</button>
            <button onClick={addToQueue} disabled={busy === 'enqueue'} className={btn} style={{ backgroundColor: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)' }}>
              {busy === 'enqueue' && <Loader2 size={13} className="animate-spin" />}Add to queue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
