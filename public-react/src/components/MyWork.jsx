import { useState, useEffect, useCallback, useMemo } from 'react'
import { Bot, ArrowUp, ArrowDown, X, Play, Square, Loader2, MessageSquare, FlaskConical, RefreshCw, Pencil, ChevronUp, ChevronDown } from 'lucide-react'
import {
  getMyWork, getMyQueue, enqueueTasks, updateQueueSettings, updateQueueItem, removeQueueItem, openMyAgent,
  runQueue, stopQueue, getUsers,
} from '../hooks/useApi'
import { devStatusMeta, priorityMeta, memberName } from './sprintMeta'
import { MultiPillSelect } from './SprintBoard'

// Sort keys for "Assigned to me". Sprints compare naturally ("Sprint 9" < "Sprint 41");
// rows with no sprint always sort last, whichever way the column is sorted.
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 }
const DEV_RANK = { todo: 0, in_progress: 1, dev_completed: 2 }
const SORTS = {
  title: (a, b) => a.title.localeCompare(b.title),
  person: (a, b) => (a.user_name || '').localeCompare(b.user_name || ''),
  sprint: (a, b) => (a.sprint_name || '').localeCompare(b.sprint_name || '', undefined, { numeric: true }),
  priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2),
  dev_status: (a, b) => (DEV_RANK[a.dev_status] ?? 9) - (DEV_RANK[b.dev_status] ?? 9),
}
const TEAM_KEY = 'mywork.team'

// What each queue state means to the developer, in their words.
const QUEUE_STATUS = {
  queued: { label: 'Queued', color: 'var(--c-text-muted)' },
  up_next: { label: 'Up next', color: '#eab308' },
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
export default function MyWork({ user, model, wsOn, onGoToSession }) {
  const [work, setWork] = useState(null)
  const [queue, setQueue] = useState(null)
  const [selected, setSelected] = useState([])
  const [jevForNew, setJevForNew] = useState(true)
  // Add-to-queue dialog: open with the selection, one optional description per task.
  const [composer, setComposer] = useState(false)
  const [notes, setNotes] = useState({})
  const [editing, setEditing] = useState(null) // { id, text } — a queued item's description being edited
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const [sort, setSort] = useState({ key: null, dir: 1 })
  // Admins can add other people's assigned tasks to the table (read-only); remembered per browser.
  const isAdmin = !!user?.isAdmin
  const [team, setTeam] = useState(() => { try { return JSON.parse(localStorage.getItem(TEAM_KEY) || '[]') } catch { return [] } })
  const [people, setPeople] = useState([])
  useEffect(() => { if (isAdmin) getUsers().then(u => setPeople(Array.isArray(u) ? u : [])).catch(() => {}) }, [isAdmin])
  useEffect(() => { localStorage.setItem(TEAM_KEY, JSON.stringify(team)) }, [team])
  const teamKey = isAdmin ? team.join(',') : ''

  const load = useCallback(async () => {
    try {
      const ids = teamKey ? teamKey.split(',') : []
      const [w, q] = await Promise.all([getMyWork(ids), getMyQueue()])
      setWork(w); setQueue(q)
    } catch (e) { setMsg({ kind: 'error', text: e.message }) }
  }, [teamKey])
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
      getMyWork(teamKey ? teamKey.split(',') : []).then(setWork).catch(() => {})
      return true
    } catch (e) { setMsg({ kind: 'error', text: e.message }); return false }
    finally { setBusy(null) }
  }

  const items = queue?.items || []
  const settings = queue?.settings
  const active = items.filter(i => ['queued', 'running', 'testing', 'needs_input'].includes(i.status))
  const finished = items.filter(i => i.status === 'done' || i.status === 'dev_completed')
  const armed = queue?.run?.armed || 0
  const waiting = queue?.run?.waiting || 0
  const statusOf = (i) => QUEUE_STATUS[i.status === 'queued' && i.armed ? 'up_next' : i.status] || QUEUE_STATUS.queued
  // Close only on success — a failed save must not throw away what was typed.
  const saveNote = () => run(editing.id, () => updateQueueItem(editing.id, { note: editing.text })).then(ok => ok && setEditing(null))
  const queueable = useMemo(() => (work?.issues || []).filter(i => !i.queue_status), [work])
  // With people picked, their tasks join the table (read-only) under a Person column.
  const showPeople = isAdmin && team.length > 0
  const issues = useMemo(() => {
    const me = user?.displayName || 'Me'
    const list = [...(work?.issues || []).map(i => ({ ...i, user_name: me, mine: true })), ...(showPeople ? work?.team_issues || [] : [])]
    if (!sort.key) return list
    const cmp = SORTS[sort.key]
    return list.sort((a, b) => {
      if (sort.key === 'sprint' && !a.sprint_name !== !b.sprint_name) return a.sprint_name ? -1 : 1
      return cmp(a, b) * sort.dir
    })
  }, [work, sort, showPeople, user?.displayName])
  // Click: ascending → descending → back to the default order.
  const sortBy = (key) => setSort(s => s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : { key: null, dir: 1 })
  const sortTh = (k, label, className = '') => (
    <th className={`px-3 py-2 font-medium ${className}`} style={cell} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => sortBy(k)} className="inline-flex items-center gap-1 cursor-pointer hover:text-[var(--c-text)]" title={`Sort by ${label}`}>
        {label}
        {sort.key === k ? (sort.dir === 1 ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </button>
    </th>
  )
  const allSelected = queueable.length > 0 && queueable.every(i => selected.includes(i.id))
  const toggle = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  const addToQueue = () => run('enqueue', () => enqueueTasks(selected, { jev: jevForNew, model, notes }), (r) => {
    setSelected([]); setNotes({}); setComposer(false)
    const skipped = r?.skipped?.length ? ` · ${r.skipped.length} skipped (${[...new Set(r.skipped.map(s => s.reason))].join(', ')})` : ''
    return `Queued ${r?.added ?? 0} task${r?.added === 1 ? '' : 's'}${skipped}. Press Run when you're ready.`
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
            <button
              onClick={() => run('run', runQueue)}
              disabled={!waiting || busy === 'run'}
              className={btn}
              style={waiting ? { backgroundColor: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)' } : btnStyle}
            >
              {busy === 'run' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}Run{waiting ? ` ${waiting}` : ''}
            </button>
            {armed > 0 && (
              <button onClick={() => run('stop', stopQueue)} disabled={busy === 'stop'} className={btn} style={btnStyle}>
                <Square size={12} />Stop
              </button>
            )}
            <span className="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              {armed > 0
                ? `${armed} up next${waiting ? ` · ${waiting} added since — press Run to include them` : ''}. Stop lets running tasks finish.`
                : waiting > 0 ? 'Nothing starts until you press Run.' : ''}
            </span>
            {isAdmin && (
              <span className="ml-auto flex items-center gap-1.5 text-xs" style={{ color: 'var(--c-text-secondary)' }}>
                Also show
                <span className="inline-flex rounded" style={{ border: '1px solid var(--c-border)' }}>
                  <MultiPillSelect
                    value={team}
                    onChange={setTeam}
                    options={people.filter(p => p.id !== user?.id).map(p => ({ v: p.id, label: p.displayName || memberName(p) || p.email }))}
                    fg="#a78bfa"
                    placeholder="Other people's tasks"
                    title="Show other people's tasks"
                    emptyText="No other users."
                  />
                </span>
              </span>
            )}
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
                  const st = statusOf(item)
                  const queuedIdx = active.filter(i => i.status === 'queued').findIndex(i => i.id === item.id)
                  const queuedCount = active.filter(i => i.status === 'queued').length
                  const waitingIn = item.phase === 'jev' ? item.jev_session_id : item.dev_session_id
                  return (
                    <tr key={item.id} style={{ backgroundColor: item.status === 'needs_input' ? 'rgba(248,113,113,0.06)' : 'transparent' }}>
                      <td className="px-3 py-2 align-top" style={cell}>
                        <div style={{ color: 'var(--c-text)' }}>{item.issue_title || item.issue_id}</div>
                        {item.sprint_name && <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>{item.sprint_name}</div>}
                        {editing?.id === item.id ? (
                          <div className="mt-1.5 flex flex-col gap-1.5">
                            <textarea
                              autoFocus
                              value={editing.text}
                              onChange={e => setEditing({ ...editing, text: e.target.value })}
                              onKeyDown={e => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote() }}
                              rows={3}
                              maxLength={4000}
                              aria-label={`Description for "${item.issue_title}"`}
                              className="w-full text-xs px-2 py-1.5 rounded-md outline-none resize-y"
                              style={{ ...selectStyle, backgroundColor: 'var(--c-bg)' }}
                            />
                            <div className="flex items-center gap-2">
                              <button onClick={saveNote} disabled={busy === item.id} className={btn} style={{ backgroundColor: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)' }}>Save</button>
                              <button onClick={() => setEditing(null)} className={btn} style={btnStyle}>Cancel</button>
                            </div>
                          </div>
                        ) : item.note ? (
                          <div className="mt-1 text-[11px] leading-snug whitespace-pre-wrap" style={{ color: 'var(--c-text-secondary)' }}>{item.note}</div>
                        ) : null}
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
                            <button onClick={() => setEditing({ id: item.id, text: item.note || '' })} className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)]" style={{ color: 'var(--c-text-secondary)' }} aria-label="Edit description" title="Edit description"><Pencil size={12} /></button>
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
          <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--c-text)' }}>{showPeople ? 'Assigned' : 'Assigned to me'}</h2>
          {issues.length === 0 ? (
            <p className="text-xs py-6" style={{ color: 'var(--c-text-muted)' }}>Nothing assigned to you.</p>
          ) : (
            <table className="w-full text-xs border-collapse" style={{ border: '1px solid var(--c-border)' }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--c-text-secondary)', backgroundColor: 'var(--c-surface)' }}>
                  <th className="px-3 py-2 w-8" style={cell}>
                    <input type="checkbox" checked={allSelected} disabled={!queueable.length} onChange={() => setSelected(allSelected ? [] : queueable.map(i => i.id))} aria-label="Select every task not already queued" className="cursor-pointer" />
                  </th>
                  {showPeople && sortTh('person', 'Person', 'w-36')}
                  {sortTh('title', 'Task')}
                  {sortTh('sprint', 'Sprint', 'w-36')}
                  {sortTh('priority', 'Priority', 'w-24')}
                  {sortTh('dev_status', 'Dev status', 'w-32')}
                  <th className="px-3 py-2 font-medium w-28" style={cell}>Queue</th>
                </tr>
              </thead>
              <tbody>
                {issues.map(i => {
                  const pr = priorityMeta(i.priority)
                  const ds = devStatusMeta(i.dev_status)
                  const qs = i.queue_status ? QUEUE_STATUS[i.queue_status] : null
                  return (
                    <tr key={`${i.user_id || 'me'}:${i.id}`} className="hover:bg-[var(--c-surface)]">
                      <td className="px-3 py-2" style={cell}>
                        {/* Only your own tasks can be queued — a queue runs as its owner. */}
                        <input type="checkbox" checked={i.mine && selected.includes(i.id)} disabled={!i.mine || !!i.queue_status} onChange={() => toggle(i.id)} aria-label={`Select "${i.title}"`} title={i.mine ? undefined : `Only ${i.user_name} can queue their own tasks`} className="cursor-pointer disabled:cursor-default" />
                      </td>
                      {showPeople && <td className="px-3 py-2 whitespace-nowrap" style={{ ...cell, color: i.mine ? 'var(--c-text)' : 'var(--c-text-secondary)' }}>{i.user_name}</td>}
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
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setSelected([])} className={btn} style={btnStyle}>Clear</button>
            <button onClick={() => setComposer(true)} className={btn} style={{ backgroundColor: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)' }}>
              Add to queue…
            </button>
          </div>
        </div>
      )}

      {/* Add-to-queue dialog: a description per task, then queue. Nothing starts until Run. */}
      {composer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={() => setComposer(false)} onKeyDown={e => e.key === 'Escape' && setComposer(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="queue-composer-title" className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
              <h2 id="queue-composer-title" className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>Add {selected.length} task{selected.length === 1 ? '' : 's'} to the queue</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--c-text-muted)' }}>Anything you add here goes to the agent with the task. They wait in the queue until you press Run.</p>
            </div>
            <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-4">
              {selected.map(id => {
                const issue = (work?.issues || []).find(i => i.id === id)
                if (!issue) return null
                return (
                  <div key={id}>
                    <label htmlFor={`note-${id}`} className="block text-xs font-medium" style={{ color: 'var(--c-text)' }}>{issue.title}</label>
                    {issue.description && (
                      <p className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--c-text-muted)' }} title={issue.description}>{issue.description}</p>
                    )}
                    <textarea
                      id={`note-${id}`}
                      value={notes[id] || ''}
                      onChange={e => setNotes(n => ({ ...n, [id]: e.target.value }))}
                      rows={3}
                      maxLength={4000}
                      placeholder="Extra description for the agent (optional) — what to change, where, acceptance criteria…"
                      className="mt-1.5 w-full text-xs px-2.5 py-2 rounded-md outline-none resize-y"
                      style={{ border: '1px solid var(--c-border)', color: 'var(--c-text)', backgroundColor: 'var(--c-bg)' }}
                    />
                  </div>
                )
              })}
            </div>
            <div className="flex items-center gap-3 px-5 py-3" style={{ borderTop: '1px solid var(--c-border)' }}>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--c-text-secondary)' }}>
                <input type="checkbox" checked={jevForNew} onChange={e => setJevForNew(e.target.checked)} />
                Test with Jev
              </label>
              <span className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                {jevForNew ? 'Deployed to DEV and tested; a pass moves it to Done.' : 'Moves to Dev Completed when the session finishes.'}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setComposer(false)} className={btn} style={btnStyle}>Cancel</button>
                <button onClick={addToQueue} disabled={busy === 'enqueue'} className={btn} style={{ backgroundColor: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)' }}>
                  {busy === 'enqueue' && <Loader2 size={13} className="animate-spin" />}Add to queue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
