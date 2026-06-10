import { useState } from 'react'
import { GitMerge, X, Search } from 'lucide-react'

// Merge dialog — same flow as Fork, but combines 2+ sessions. The session the
// user clicked "Merge with…" on is the primary; they pick one or more others to
// fold in, then describe the task for the new merged session.
export default function MergeDialog({ sessions = [], primaryId, onClose, onMerge, busy = false }) {
  const [selected, setSelected] = useState(() => new Set())
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')

  const primary = sessions.find(s => s.id === primaryId)
  const q = query.trim().toLowerCase()
  const candidates = sessions.filter(s =>
    s.id !== primaryId &&
    (!q || `${s.name || ''} ${s.task || ''} ${s.id}`.toLowerCase().includes(q))
  )

  const toggle = (id) => setSelected(prev => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const canMerge = selected.size >= 1 && !busy
  const label = (s) => s.name || s.task || s.id

  const submit = () => {
    if (!canMerge) return
    onMerge([primaryId, ...selected], text.trim())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--c-overlay, rgba(0,0,0,0.5))' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-xl p-5 flex flex-col max-h-[80vh]"
        style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <GitMerge size={16} style={{ color: 'var(--c-accent)' }} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--c-text-primary)' }}>Merge Sessions</h3>
          </div>
          <button onClick={onClose} className="cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={16} /></button>
        </div>

        <p className="text-xs mb-3" style={{ color: 'var(--c-text-secondary)' }}>
          Each selected session is compacted and combined into one new session that carries the full merged context. The originals stay intact.
        </p>

        {/* Primary (the session merge was started from) */}
        <div className="mb-3">
          <p className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--c-text-muted)' }}>Primary</p>
          <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
            style={{ backgroundColor: 'var(--c-surface-2)', border: '1px solid var(--c-accent)', color: 'var(--c-text-primary)' }}>
            <span className="font-medium truncate">{primary ? label(primary) : primaryId}</span>
            <span className="font-mono text-[10px] ml-auto flex-shrink-0" style={{ color: 'var(--c-text-muted)' }}>{primaryId}</span>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 rounded-lg px-3 py-2 mb-2"
          style={{ backgroundColor: 'var(--c-surface-2)', border: '1px solid var(--c-border)' }}>
          <Search size={13} style={{ color: 'var(--c-text-muted)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions to merge in…"
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--c-text-primary)' }}
          />
        </div>

        {/* Candidate list */}
        <div className="flex-1 overflow-y-auto -mx-1 px-1 mb-3" style={{ minHeight: 80 }}>
          {candidates.length === 0 ? (
            <p className="text-xs py-4 text-center" style={{ color: 'var(--c-text-muted)' }}>No other sessions to merge.</p>
          ) : candidates.map(s => {
            const on = selected.has(s.id)
            return (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                className="w-full flex items-center gap-2 rounded-lg px-3 py-2 mb-1 text-left cursor-pointer transition-colors"
                style={{
                  backgroundColor: on ? 'color-mix(in srgb, var(--c-accent) 14%, transparent)' : 'transparent',
                  border: `1px solid ${on ? 'var(--c-accent)' : 'var(--c-border)'}`,
                }}
              >
                <span className="flex-shrink-0 w-4 h-4 rounded flex items-center justify-center text-[10px]"
                  style={{
                    backgroundColor: on ? 'var(--c-accent)' : 'transparent',
                    border: `1px solid ${on ? 'var(--c-accent)' : 'var(--c-border)'}`,
                    color: '#fff',
                  }}>
                  {on ? '✓' : ''}
                </span>
                <span className="text-sm truncate" style={{ color: 'var(--c-text-primary)' }}>{label(s)}</span>
                {s.mode === 'tester' && <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--c-accent)' }}>tester</span>}
                {s.mode === 'design' && <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--c-accent)' }}>design</span>}
                <span className="font-mono text-[10px] ml-auto flex-shrink-0" style={{ color: 'var(--c-text-muted)' }}>{s.id}</span>
              </button>
            )
          })}
        </div>

        {/* Task */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should the merged session work on? (optional — leave blank to just continue from the combined context)"
          rows={2}
          className="w-full text-sm outline-none resize-none rounded-lg p-3 mb-3"
          style={{ color: 'var(--c-text-primary)', border: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface-2)' }}
        />

        <div className="flex items-center gap-2 justify-end">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md cursor-pointer" style={{ color: 'var(--c-text-secondary)' }}>Cancel</button>
          <button
            onClick={submit}
            disabled={!canMerge}
            className="text-xs px-3 py-1.5 rounded-md font-medium text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            style={{ backgroundColor: 'var(--c-accent)' }}
          >
            <GitMerge size={13} />
            {busy ? 'Merging…' : `Merge ${selected.size + 1} & Start`}
          </button>
        </div>
      </div>
    </div>
  )
}
