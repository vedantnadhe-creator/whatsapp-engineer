import { useState, useMemo, useCallback } from 'react'
import { Play, MessageSquare, Loader2, Calendar, Bug } from 'lucide-react'
import {
  DEV_STATUS, TYPE_PILL, memberName, featureCompletion, completionColor, openBugCount,
} from './sprintMeta'

// Native HTML5 drag-and-drop carries the dragged issue id as plain text. Typed so a
// drag from anywhere else on the page (a file, a text selection) is ignored on drop.
const DRAG_MIME = 'application/x-olibot-issue'

const shortDate = (v) => {
  if (!v) return ''
  const d = new Date(String(v).slice(0, 10))
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
// A deadline is "late" once the day has passed and the work is not finished.
const isOverdue = (f) => {
  if (!f?.deadline || featureCompletion(f) === 100) return false
  return String(f.deadline).slice(0, 10) < new Date().toISOString().slice(0, 10)
}

// ── Card ─────────────────────────────────────────────────────────────────────
function KanbanCard({ f, status, members, onMove, onStartSession, onGoToSession, busyStart, dragging, onDragStart, onDragEnd }) {
  const pct = featureCompletion(f)
  const pctColor = completionColor(pct)
  const bugs = openBugCount(f)
  const dev = (members || []).find(m => m.id === f.assigned_to)
  const qa = (members || []).find(m => m.id === f.qa_owner)
  const typeColor = TYPE_PILL[f.type || 'feature'] || TYPE_PILL.feature
  const overdue = isOverdue(f)

  return (
    <article
      draggable
      onDragStart={(e) => onDragStart(e, f.id)}
      onDragEnd={onDragEnd}
      className="rounded-lg p-2.5 flex flex-col gap-2 cursor-grab active:cursor-grabbing transition-colors duration-150"
      style={{
        backgroundColor: 'var(--c-surface-2)',
        border: '1px solid var(--c-border)',
        opacity: dragging ? 0.4 : 1,
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="text-[10px] font-medium rounded px-1.5 py-0.5 flex-shrink-0"
          style={{ backgroundColor: `${typeColor}22`, color: typeColor }}
        >{f.type || 'feature'}</span>
        {f.platform && (
          <span className="text-[10px] truncate" style={{ color: 'var(--c-text-muted)' }}>{f.platform}</span>
        )}
        <div className="flex-1" />
        {f.session_id ? (
          <button
            onClick={() => onGoToSession(f.session_id)}
            title="Open dev session"
            aria-label={`Open dev session for ${f.title}`}
            className="p-0.5 rounded cursor-pointer flex-shrink-0 hover:bg-[var(--c-surface-3)]"
            style={{ color: 'var(--c-accent)' }}
          ><MessageSquare size={13} /></button>
        ) : (
          <button
            onClick={() => onStartSession(f)}
            disabled={busyStart}
            title="Start dev session"
            aria-label={`Start dev session for ${f.title}`}
            className="p-0.5 rounded cursor-pointer flex-shrink-0 hover:bg-[var(--c-surface-3)] disabled:opacity-40"
            style={{ color: '#4ade80' }}
          >{busyStart ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}</button>
        )}
      </div>

      <p className="text-xs leading-snug break-words" style={{ color: 'var(--c-text)' }}>{f.title}</p>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--c-surface-3)' }}>
          <div className="h-full rounded-full transition-all duration-150" style={{ width: `${pct}%`, backgroundColor: pctColor }} />
        </div>
        <span className="font-mono text-[10px] tabular-nums" style={{ color: pctColor }}>{pct}%</span>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
        {dev && <span style={{ color: 'var(--c-text-secondary)' }}>{memberName(dev)}</span>}
        {qa && <span title="QA owner">QA: {memberName(qa)}</span>}
        {f.deadline && (
          <span className="inline-flex items-center gap-1" style={{ color: overdue ? '#f87171' : 'var(--c-text-muted)' }}>
            <Calendar size={10} />{shortDate(f.deadline)}
          </span>
        )}
        {bugs > 0 && (
          <span className="inline-flex items-center gap-1" style={{ color: (f.critical_bugs || 0) > 0 ? '#f87171' : '#fbbf24' }}>
            <Bug size={10} />{bugs}
          </span>
        )}
        <span className="flex-1" />
        {/* Keyboard, screen-reader and touch path for moving a card — HTML5 drag-and-drop
            works with neither a keyboard nor a touchscreen, so this is the real control
            and dragging is the shortcut. Kept inline so it reads as one more piece of
            card metadata rather than a form field stapled to the bottom. */}
        <select
          value={status}
          onChange={(e) => onMove(f.id, e.target.value)}
          aria-label={`Dev status for ${f.title}`}
          className="text-[10px] rounded px-1 py-0.5 cursor-pointer outline-none"
          style={{ backgroundColor: 'transparent', color: 'var(--c-text-muted)', border: '1px solid var(--c-border)', maxWidth: 130 }}
        >
          {DEV_STATUS.map(s => (
            <option key={s.v} value={s.v} style={{ color: 'var(--c-text)', backgroundColor: 'var(--c-surface)' }}>{s.label}</option>
          ))}
        </select>
      </div>
    </article>
  )
}

// ── Column ───────────────────────────────────────────────────────────────────
function KanbanColumn({ status, items, isDropTarget, onDragOver, onDragLeave, onDrop, children }) {
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label={`${status.label} — ${items.length} item${items.length === 1 ? '' : 's'}`}
      className="flex flex-col min-h-0 rounded-lg transition-colors duration-150"
      style={{
        // Share the width evenly. min-width keeps a column readable, and once four of
        // them no longer fit the row overflows into the board's horizontal scroll
        // instead of squeezing every card into a sliver.
        flex: '1 1 0',
        minWidth: 260,
        backgroundColor: isDropTarget ? 'var(--c-surface-2)' : 'var(--c-surface)',
        border: `1px solid ${isDropTarget ? 'var(--c-accent)' : 'var(--c-border)'}`,
      }}
    >
      <header
        className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--c-border)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: status.color }} />
        <h3 className="text-[11px] font-semibold" style={{ color: 'var(--c-text)' }}>{status.label}</h3>
        <span className="font-mono text-[11px]" style={{ color: 'var(--c-text-muted)' }}>{items.length}</span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {children}
        {items.length === 0 && (
          // my-auto centres the message in a now full-height empty column.
          <p className="text-[11px] text-center my-auto" style={{ color: 'var(--c-text-muted)' }}>
            {isDropTarget ? 'Drop here' : 'Nothing here'}
          </p>
        )}
      </div>
    </section>
  )
}

// ── Board ────────────────────────────────────────────────────────────────────
export default function SprintKanban({
  features, members, onUpdateIssue, onStartSession, onGoToSession, busyStart, onError,
}) {
  const [draggingId, setDraggingId] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  // Moves the server has not confirmed yet: id -> target dev_status. onUpdateIssue
  // refetches the whole list rather than patching it, so without this the card snaps
  // back to its old column for the length of the round-trip.
  //
  // An entry needs no clean-up to stay correct — once the refetch lands, the target
  // and the real status are the same value. It is pruned on the next move purely so
  // the map cannot grow, and so a card someone else moved stops being pinned here.
  const [pendingMoves, setPendingMoves] = useState({})

  const statusOf = useCallback((f) => pendingMoves[f.id] ?? (f.dev_status || 'todo'), [pendingMoves])

  const columns = useMemo(() => DEV_STATUS.map(status => ({
    status,
    items: features.filter(f => statusOf(f) === status.v),
  })), [features, statusOf])

  const move = useCallback(async (id, devStatus) => {
    const f = features.find(x => x.id === id)
    if (!f || statusOf(f) === devStatus) return
    setPendingMoves(prev => {
      const next = {}
      for (const [pendingId, target] of Object.entries(prev)) {
        const current = features.find(x => x.id === pendingId)
        if (current && current.dev_status !== target) next[pendingId] = target
      }
      next[id] = devStatus
      return next
    })
    try {
      await onUpdateIssue(id, { dev_status: devStatus })
    } catch (err) {
      setPendingMoves(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      onError?.(err?.message || 'Could not move the card.')
    }
  }, [features, statusOf, onUpdateIssue, onError])

  const handleDragStart = (e, id) => {
    e.dataTransfer.setData(DRAG_MIME, id)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingId(id)
  }

  const handleDragOver = (e, statusValue) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault() // required, or the browser refuses the drop
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(statusValue)
  }

  const handleDrop = (e, statusValue) => {
    const id = e.dataTransfer.getData(DRAG_MIME)
    setDropTarget(null)
    setDraggingId(null)
    if (!id) return
    e.preventDefault()
    move(id, statusValue)
  }

  return (
    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden p-3">
      <div className="flex gap-3 h-full items-stretch">
        {columns.map(({ status, items }) => (
          <KanbanColumn
            key={status.v}
            status={status}
            items={items}
            isDropTarget={dropTarget === status.v}
            onDragOver={(e) => handleDragOver(e, status.v)}
            onDragLeave={() => setDropTarget(prev => (prev === status.v ? null : prev))}
            onDrop={(e) => handleDrop(e, status.v)}
          >
            {items.map(f => (
              <KanbanCard
                key={f.id}
                f={f}
                status={status.v}
                members={members}
                onMove={move}
                onStartSession={onStartSession}
                onGoToSession={onGoToSession}
                busyStart={busyStart === f.id}
                dragging={draggingId === f.id}
                onDragStart={handleDragStart}
                onDragEnd={() => { setDraggingId(null); setDropTarget(null) }}
              />
            ))}
          </KanbanColumn>
        ))}
      </div>
    </div>
  )
}
