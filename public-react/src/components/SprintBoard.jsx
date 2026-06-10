import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Plus, Play, MessageSquare, Bug, FlaskConical, Trash2, ChevronDown, ChevronRight,
  GitFork, Check, X, Loader2, FileText, RefreshCw, CornerDownRight, ArrowLeft, Archive, ArchiveRestore,
  Paperclip, ListTree,
} from 'lucide-react'
import {
  startFeatureSession, getBugs, createBug, updateBug, deleteBug, forkBug,
  getTestCases, createTestCase, updateTestCase, deleteTestCase, generateTestCases,
  getSubtasks, uploadFile,
} from '../hooks/useApi'

// ── Option sets ────────────────────────────────────────────────────────────
const DEV_STATUS = [
  { v: 'todo', label: 'To Do', color: 'var(--c-text-muted)' },
  { v: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { v: 'dev_completed', label: 'Dev Completed', color: '#3b82f6' },
  { v: 'done', label: 'Done', color: '#22c55e' },
]
const QA_STATUS = [
  { v: '', label: '—', color: 'var(--c-text-muted)' },
  { v: 'testing', label: 'Testing', color: '#f59e0b' },
  { v: 'pass', label: 'Pass', color: '#22c55e' },
  { v: 'fail', label: 'Fail', color: '#ef4444' },
  { v: 'not_needed', label: 'Not needed', color: 'var(--c-text-muted)' },
]
const TYPES = [
  { v: 'feature', label: 'Feature' },
  { v: 'task', label: 'Task' },
  { v: 'bug', label: 'Bug' },
  { v: 'improvement', label: 'Improvement' },
]
const PLATFORM_SUGGESTIONS = ['ATS', 'Assessment', 'Both', 'Infra']

const devStatusMeta = (v) => DEV_STATUS.find(s => s.v === v) || DEV_STATUS[0]
const qaStatusMeta = (v) => QA_STATUS.find(s => s.v === (v || '')) || QA_STATUS[0]

// Feature completion %, driven by the QA lifecycle (mirrors session_store.js featureCompletion):
//   QA Pass / Done → 100 · Dev Completed (no open bugs) → 100 · Dev Completed + open QA bug → 50
//   To Do / In Progress → 0
function featureCompletion(f) {
  if (!f) return 0
  const qa = String(f.qa_status || '').toLowerCase()
  if (qa === 'pass' || qa === 'passed' || qa === 'tested') return 100
  if (f.dev_status === 'done') return 100
  if (f.dev_status === 'dev_completed') return (f.open_bugs || 0) > 0 ? 50 : 70
  return 0
}
const completionColor = (pct) => pct >= 100 ? '#4ade80' : pct >= 70 ? '#60a5fa' : pct >= 50 ? '#fbbf24' : 'var(--c-text-muted)'

// Pill foreground colors (dark theme) — backgrounds are derived as a translucent tint.
const TYPE_PILL = {
  feature: '#f472b6',
  task: '#4ade80',
  bug: '#f87171',
  improvement: '#22d3ee',
  story: '#60a5fa', // legacy fallback for older rows
}
const ASSIGNEE_PILL = '#4ade80'
const QA_OWNER_PILL = '#cbd5e1'

// A <select> styled as a soft colored pill (tinted background, colored text) — works on the dark sheet.
function PillSelect({ value, onChange, options, fg, placeholder = '—', disabled }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="text-[11px] font-medium rounded-full px-2 py-0.5 cursor-pointer outline-none border-0 appearance-none text-center disabled:opacity-60"
      style={{ backgroundColor: value ? fg + '22' : 'var(--c-surface-2)', color: value ? fg : 'var(--c-text-muted)', maxWidth: 130 }}
    >
      {!value && <option value="" style={{ color: 'var(--c-text)', backgroundColor: 'var(--c-surface)' }}>{placeholder}</option>}
      {options.map(o => <option key={o.v ?? o.id} value={o.v ?? o.id} style={{ color: 'var(--c-text)', backgroundColor: 'var(--c-surface)' }}>{o.label ?? o.display_name ?? o.email}</option>)}
    </select>
  )
}

// ── Small editable cell helpers ─────────────────────────────────────────────
function EditText({ value, onCommit, placeholder, className = '', mono = false, list }) {
  const [v, setV] = useState(value ?? '')
  const ref = useRef(null)
  useEffect(() => { setV(value ?? '') }, [value])
  const commit = () => { if ((v ?? '') !== (value ?? '')) onCommit(v) }
  return (
    <input
      ref={ref}
      list={list}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ref.current?.blur() } if (e.key === 'Escape') { setV(value ?? ''); ref.current?.blur() } }}
      className={`bg-transparent outline-none w-full text-xs px-1 py-0.5 rounded focus:bg-[var(--c-surface-2)] ${mono ? 'font-mono' : ''} ${className}`}
      style={{ color: 'var(--c-text)' }}
    />
  )
}

function StatusSelect({ value, options, onChange }) {
  const meta = options.find(o => o.v === (value || '')) || options[0]
  const tinted = meta.color.startsWith('#')
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="text-[12px] font-medium rounded-full px-2 py-0.5 cursor-pointer outline-none border-0 appearance-none"
      style={{ backgroundColor: tinted ? meta.color + '22' : 'var(--c-surface-2)', color: meta.color }}
    >
      {options.map(o => <option key={o.v} value={o.v} style={{ color: 'var(--c-text)', backgroundColor: 'var(--c-surface)' }}>{o.label}</option>)}
    </select>
  )
}

// ── Component ────────────────────────────────────────────────────────────────
export default function SprintBoard({
  onBack,
  issues, refreshIssues, onCreateIssue, onUpdateIssue, onDeleteIssue,
  sprints, onCreateSprint, onUpdateSprint, onDeleteSprint,
  members, user, model, onGoToSession,
  onGetChangelog, onRequestIssueSummary, onGetIssueLastResponse, onGenerateChangelog,
}) {
  const [activeSprintId, setActiveSprintId] = useState(null) // null = all
  const [expandedId, setExpandedId] = useState(null)
  const [showNewSprint, setShowNewSprint] = useState(false)
  const [newSprintName, setNewSprintName] = useState('')
  const [newSprintStart, setNewSprintStart] = useState('')
  const [newSprintEnd, setNewSprintEnd] = useState('')
  const [busyStart, setBusyStart] = useState(null) // issue id currently spawning a session
  const [startFor, setStartFor] = useState(null)   // feature whose start-session composer is open
  const [startText, setStartText] = useState('')
  const [startFiles, setStartFiles] = useState([]) // [{ token, name }]
  const [uploadingFile, setUploadingFile] = useState(false)

  const isTester = user?.role === 'tester'

  // Default to the first active sprint on first load.
  useEffect(() => {
    if (activeSprintId === null && sprints.length > 0) {
      const active = sprints.find(s => s.status === 'active') || sprints[0]
      if (active) setActiveSprintId(active.id)
    }
  }, [sprints])

  const isBacklogView = activeSprintId === '__backlog__'
  const features = useMemo(() => {
    return (issues || [])
      .filter(i => i.category !== 'chat' && !i.parent_issue_id) // subtasks show under their parent, not as top-level rows
      .filter(i => {
        if (activeSprintId === '__backlog__') return !!i.is_backlog
        if (activeSprintId === '__all__') return !i.is_backlog
        return i.sprint_id === activeSprintId && !i.is_backlog
      })
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  }, [issues, activeSprintId])
  const backlogCount = useMemo(() => (issues || []).filter(i => i.category !== 'chat' && i.is_backlog).length, [issues])

  const progress = useMemo(() => {
    const total = features.length
    if (!total) return { total: 0, done: 0, passed: 0, percent: 0, openBugs: 0, criticalBugs: 0 }
    const done = features.filter(f => f.dev_status === 'done').length
    const passed = features.filter(f => featureCompletion(f) === 100).length
    // Sprint % = average of each feature's lifecycle completion (QA-driven).
    const percent = Math.round(features.reduce((s, f) => s + featureCompletion(f), 0) / total)
    const openBugs = features.reduce((s, f) => s + (f.open_bugs || 0), 0)
    const criticalBugs = features.reduce((s, f) => s + (f.critical_bugs || 0), 0)
    return { total, done, passed, percent, openBugs, criticalBugs }
  }, [features])

  const activeSprint = sprints.find(s => s.id === activeSprintId)

  const handleCreateSprint = async () => {
    if (!newSprintName.trim()) return
    const sprint = await onCreateSprint({ name: newSprintName.trim(), startDate: newSprintStart || null, endDate: newSprintEnd || null })
    setNewSprintName(''); setNewSprintStart(''); setNewSprintEnd(''); setShowNewSprint(false)
    if (sprint?.id) setActiveSprintId(sprint.id)
  }

  // Clicking ▶ on a feature opens a small composer where the dev types what to do this session.
  const handleStartSession = (issue) => { setStartFor(issue); setStartText(''); setStartFiles([]) }

  const attachStartFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setUploadingFile(true)
    try {
      for (const file of files) {
        const r = await uploadFile(file)
        if (r?.token) setStartFiles(prev => [...prev, { token: r.token, name: file.name }])
      }
    } finally { setUploadingFile(false) }
  }

  const confirmStart = async () => {
    const issue = startFor
    if (!issue) return
    const tokens = startFiles.map(f => f.token)
    setStartFor(null)
    setBusyStart(issue.id)
    try {
      const r = await startFeatureSession(issue.id, model, startText.trim(), tokens)
      setStartText(''); setStartFiles([])
      refreshIssues()
      if (r?.sessionId) onGoToSession(r.sessionId)
    } finally { setBusyStart(null) }
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)' }}>
      {/* Header */}
      <div className="px-4 py-3 flex flex-col gap-3" style={{ borderBottom: '1px solid var(--c-border)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          {onBack && (
            <button
              onClick={onBack}
              className="flex items-center gap-1 px-2 py-1 rounded text-[12px] font-medium cursor-pointer hover:bg-[var(--c-surface-2)]"
              style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
              title="Back to sessions"
            ><ArrowLeft size={14} /> Back</button>
          )}
          <span className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>Sprint Board</span>
          {/* Sprint tabs */}
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setActiveSprintId('__all__')}
              className="text-[11px] px-2 py-1 rounded cursor-pointer"
              style={{ backgroundColor: activeSprintId === '__all__' ? 'var(--c-surface-2)' : 'transparent', color: activeSprintId === '__all__' ? 'var(--c-text)' : 'var(--c-text-secondary)' }}
            >All</button>
            <button
              onClick={() => setActiveSprintId('__backlog__')}
              className="text-[11px] px-2 py-1 rounded cursor-pointer flex items-center gap-1"
              style={{ backgroundColor: activeSprintId === '__backlog__' ? 'var(--c-surface-2)' : 'transparent', color: activeSprintId === '__backlog__' ? 'var(--c-text)' : 'var(--c-text-secondary)' }}
            ><Archive size={11} /> Backlog{backlogCount > 0 ? ` (${backlogCount})` : ''}</button>
            {sprints.map(s => (
              <button
                key={s.id}
                onClick={() => setActiveSprintId(s.id)}
                className="text-[11px] px-2 py-1 rounded cursor-pointer flex items-center gap-1"
                style={{ backgroundColor: activeSprintId === s.id ? 'var(--c-surface-2)' : 'transparent', color: activeSprintId === s.id ? 'var(--c-text)' : 'var(--c-text-secondary)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: s.status === 'active' ? '#22c55e' : s.status === 'completed' ? 'var(--c-text-muted)' : '#f59e0b' }} />
                {s.name}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowNewSprint(v => !v)}
            disabled={isTester}
            className="text-[11px] px-2 py-1 rounded cursor-pointer flex items-center gap-1 disabled:opacity-40"
            style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
          ><Plus size={12} /> New Sprint</button>
          <div className="flex-1" />
          {activeSprint && (
            <>
              <button
                onClick={() => onUpdateSprint(activeSprint.id, { status: activeSprint.status === 'active' ? 'completed' : 'active' })}
                disabled={isTester}
                className="text-[11px] px-2 py-1 rounded cursor-pointer disabled:opacity-40"
                style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
              >{activeSprint.status === 'active' ? 'Mark complete' : 'Reactivate'}</button>
              <ChangelogButton sprint={activeSprint} features={features} onGetChangelog={onGetChangelog} onRequestIssueSummary={onRequestIssueSummary} onGetIssueLastResponse={onGetIssueLastResponse} onGenerateChangelog={onGenerateChangelog} />
              {!isTester && (
                <button
                  onClick={() => { if (confirm(`Delete sprint "${activeSprint.name}"? Features are kept (unlinked).`)) { onDeleteSprint(activeSprint.id); setActiveSprintId('__all__') } }}
                  className="text-[11px] px-2 py-1 rounded cursor-pointer"
                  style={{ color: '#ef4444', border: '1px solid var(--c-border)' }}
                ><Trash2 size={12} /></button>
              )}
            </>
          )}
        </div>

        {showNewSprint && (
          <div className="flex items-center gap-2 flex-wrap">
            <input autoFocus value={newSprintName} onChange={e => setNewSprintName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreateSprint()} placeholder="Sprint name (e.g. Sprint — 09 Jun)" className="text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)', minWidth: 240 }} />
            <label className="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>Start</label>
            <input type="date" value={newSprintStart} onChange={e => setNewSprintStart(e.target.value)} className="text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
            <label className="text-[10px]" style={{ color: 'var(--c-text-muted)' }}>End</label>
            <input type="date" value={newSprintEnd} onChange={e => setNewSprintEnd(e.target.value)} className="text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
            <button onClick={handleCreateSprint} className="text-xs px-3 py-1.5 rounded cursor-pointer font-medium" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>Create</button>
            <button onClick={() => setShowNewSprint(false)} className="text-xs px-2 py-1.5 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}>Cancel</button>
          </div>
        )}

        {/* Progress bar */}
        {features.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--c-surface-2)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${progress.percent}%`, backgroundColor: '#22c55e' }} />
            </div>
            <span className="text-[11px] font-mono" style={{ color: 'var(--c-text-secondary)' }}>{progress.percent}% · {progress.done}/{progress.total} done</span>
            {progress.openBugs > 0 && <span className="text-[11px] font-mono" style={{ color: '#f59e0b' }}>{progress.openBugs} open bug{progress.openBugs > 1 ? 's' : ''}</span>}
            {progress.criticalBugs > 0 && <span className="text-[11px] font-mono" style={{ color: '#ef4444' }}>{progress.criticalBugs} critical</span>}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto" style={{ backgroundColor: 'var(--c-bg)' }}>
        <table className="w-full border-collapse" style={{ minWidth: 1500, borderTop: '1px solid var(--c-border)', borderLeft: '1px solid var(--c-border)' }}>
          <thead className="sticky top-0 z-10">
            <tr className="text-left" style={{ color: 'var(--c-text-secondary)', backgroundColor: 'var(--c-surface)' }}>
              {['S.NO', 'Platform', 'Feature / Story', 'Type', 'Dev', 'QA Owner', 'Dev Status', 'Deadline', 'TC', 'TC Done', 'QA Status', 'Bugs', 'Crit', 'Done %', 'QA Comments', ''].map((h, i) => (
                <th key={i} className="px-2.5 py-2 font-semibold whitespace-nowrap text-[11px]" style={{ borderBottom: '1px solid var(--c-border)', borderRight: '1px solid var(--c-border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {features.map((f, idx) => (
              <FeatureRow
                key={f.id} f={f} idx={idx} members={members} isTester={isTester}
                expanded={expandedId === f.id} isBacklogView={isBacklogView}
                onToggle={() => setExpandedId(expandedId === f.id ? null : f.id)}
                onUpdate={onUpdateIssue} onDelete={onDeleteIssue} onCreateIssue={onCreateIssue}
                onStartSession={handleStartSession} busyStart={busyStart === f.id}
                onGoToSession={onGoToSession} model={model} refreshIssues={refreshIssues}
              />
            ))}
            {features.length === 0 && (
              <tr><td colSpan={16} className="px-4 py-10 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                {isBacklogView ? 'Backlog is empty — move features here with the archive icon.' : activeSprintId === '__all__' ? 'No features yet.' : 'No features in this sprint yet — add one below.'}
              </td></tr>
            )}
          </tbody>
        </table>

        {/* Quick add */}
        {activeSprintId && activeSprintId !== '__all__' && !isBacklogView && !isTester && (
          <QuickAddFeature
            sprintId={activeSprintId} members={members}
            onCreate={async (data) => { await onCreateIssue({ ...data, sprintId: activeSprintId, category: 'issue' }); refreshIssues() }}
          />
        )}
      </div>

      {/* Start-session composer — dev types what to do; the feature title is the session name */}
      {startFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={() => setStartFor(null)}>
          <div className="w-full max-w-lg rounded-xl shadow-2xl overflow-hidden" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }} onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3.5" style={{ borderBottom: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
              <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--c-text-muted)' }}>Start dev session</div>
              <div className="text-[15px] font-semibold mt-0.5" style={{ color: 'var(--c-text)' }}>{startFor.title}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--c-text-muted)' }}>This becomes the session name · status flips to In Progress</div>
            </div>
            <div className="px-5 py-4">
              <label className="text-[12px] font-medium" style={{ color: 'var(--c-text-secondary)' }}>What do you want to do in this session?</label>
              <textarea
                autoFocus
                value={startText}
                onChange={e => setStartText(e.target.value)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') confirmStart(); if (e.key === 'Escape') setStartFor(null) }}
                placeholder="e.g. Add a Skip option on the institute pick step for edit-role, and disable Republish when no colleges are selected…"
                rows={4}
                className="mt-1.5 w-full text-[13px] rounded-lg px-3 py-2 outline-none resize-y"
                style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)', minHeight: 96 }}
              />
              <div className="text-[11px] mt-1.5" style={{ color: 'var(--c-text-muted)' }}>Leave blank to let the session derive the work from the feature title, linked PRD, and knowledge base.</div>
              {/* Attached files */}
              {startFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {startFiles.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded" style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text-secondary)' }}>
                      <FileText size={11} /> {f.name}
                      <button onClick={() => setStartFiles(prev => prev.filter((_, j) => j !== i))} className="cursor-pointer hover:opacity-80"><X size={11} /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="px-5 py-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--c-border)', backgroundColor: 'var(--c-bg)' }}>
              <label className="text-[13px] px-2 py-1.5 rounded-lg cursor-pointer flex items-center gap-1.5" style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} title="Attach files">
                {uploadingFile ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                <input type="file" multiple className="hidden" onChange={e => { attachStartFiles(e.target.files); e.target.value = '' }} />
              </label>
              <div className="flex-1" />
              <button onClick={() => setStartFor(null)} className="text-[13px] px-3 py-1.5 rounded-lg cursor-pointer" style={{ color: 'var(--c-text-secondary)' }}>Cancel</button>
              <button onClick={confirmStart} className="text-[13px] px-3.5 py-1.5 rounded-lg cursor-pointer font-medium flex items-center gap-1.5" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>
                <Play size={13} /> Start session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Feature row ──────────────────────────────────────────────────────────────
function FeatureRow({ f, idx, members, isTester, expanded, isBacklogView, onToggle, onUpdate, onDelete, onCreateIssue, onStartSession, busyStart, onGoToSession, model, refreshIssues }) {
  const dev = devStatusMeta(f.dev_status)
  const upd = (patch) => onUpdate(f.id, patch)
  const cellBorder = { borderBottom: '1px solid var(--c-border)', borderRight: '1px solid var(--c-border)' }
  const rowBg = idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.025)'
  // Dev column lists developers/designers; QA Owner lists testers.
  const devMembers = (members || []).filter(m => m.role !== 'tester')
  const testerMembers = (members || []).filter(m => m.role === 'tester')

  return (
    <>
      <tr className="group" style={{ verticalAlign: 'middle', backgroundColor: rowBg }}>
        <td className="px-2 py-2 whitespace-nowrap" style={cellBorder}>
          <div className="flex items-center gap-1">
            {/* Testers can edit columns but can't start or open sessions from the board. */}
            {isTester ? null : f.session_id ? (
              <button onClick={() => onGoToSession(f.session_id)} title="Open dev session" className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)]" style={{ color: 'var(--c-accent)' }}><MessageSquare size={15} /></button>
            ) : (
              <button onClick={() => onStartSession(f)} disabled={busyStart} title="Start dev session" className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)] disabled:opacity-40" style={{ color: '#4ade80' }}>{busyStart ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}</button>
            )}
            <button onClick={onToggle} className="inline-flex items-center gap-1 cursor-pointer" style={{ color: 'var(--c-text-muted)' }}>
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span className="font-mono text-[12px]" style={{ color: 'var(--c-text-secondary)' }}>{idx + 1}</span>
            </button>
          </div>
        </td>
        <td className="px-2 py-2" style={cellBorder}><EditText value={f.platform} list="platform-suggestions" onCommit={(v) => upd({ platform: v })} placeholder="—" /></td>
        <td className="px-2 py-2 min-w-[280px]" style={cellBorder}><EditText value={f.title} onCommit={(v) => v.trim() && upd({ title: v.trim() })} placeholder="Feature title" /></td>
        <td className="px-2 py-2" style={cellBorder}>
          <PillSelect value={f.type || 'feature'} onChange={(v) => upd({ type: v })} options={TYPES} fg={TYPE_PILL[f.type || 'feature'] || TYPE_PILL.feature} />
        </td>
        <td className="px-2 py-2" style={cellBorder}>
          <PillSelect value={f.assigned_to || ''} onChange={(v) => upd({ assigned_to: v || null })} options={devMembers} fg={ASSIGNEE_PILL} placeholder="—" />
        </td>
        <td className="px-2 py-2" style={cellBorder}>
          <PillSelect value={f.qa_owner || ''} onChange={(v) => upd({ qa_owner: v || '' })} options={testerMembers} fg={QA_OWNER_PILL} placeholder="—" />
        </td>
        <td className="px-2 py-2 whitespace-nowrap" style={cellBorder}>
          <StatusSelect value={f.dev_status} options={DEV_STATUS} onChange={(v) => upd({ dev_status: v })} />
        </td>
        <td className="px-2 py-2" style={cellBorder}><DateCell value={f.deadline} onChange={(v) => upd({ deadline: v })} /></td>
        <td className="px-2 py-2 text-center font-mono text-[12px]" style={{ ...cellBorder, color: 'var(--c-text-secondary)' }}>{f.test_cases_count || 0}</td>
        <td className="px-2 py-2" style={cellBorder}><DateCell value={f.test_cases_done_date} onChange={(v) => upd({ test_cases_done_date: v })} /></td>
        <td className="px-2 py-2 whitespace-nowrap" style={cellBorder}>
          {/* QA Pass → mark the feature Done (100%) automatically */}
          <StatusSelect value={f.qa_status} options={QA_STATUS} onChange={(v) => upd(v === 'pass' ? { qa_status: v, dev_status: 'done' } : { qa_status: v })} />
        </td>
        <td className="px-2 py-2 text-center font-mono text-[12px]" style={{ ...cellBorder, color: (f.open_bugs || 0) > 0 ? '#fbbf24' : 'var(--c-text-muted)' }}>{f.open_bugs || 0}</td>
        <td className="px-2 py-2 text-center font-mono text-[12px]" style={{ ...cellBorder, color: (f.critical_bugs || 0) > 0 ? '#f87171' : 'var(--c-text-muted)' }}>{f.critical_bugs || 0}</td>
        <td className="px-2 py-2" style={cellBorder}>
          {(() => { const pct = featureCompletion(f); const c = completionColor(pct); return (
            <div className="flex items-center gap-2 min-w-[78px]" title="Auto: QA Pass 100% · Dev Done 70% · open bug 50%">
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--c-surface-2)' }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: c }} />
              </div>
              <span className="font-mono text-[12px] font-semibold tabular-nums" style={{ color: c }}>{pct}%</span>
            </div>
          ) })()}
        </td>
        <td className="px-2 py-2 min-w-[180px]" style={cellBorder}><EditText value={f.qa_comments} onCommit={(v) => upd({ qa_comments: v })} placeholder="—" /></td>
        <td className="px-2 py-2 whitespace-nowrap" style={cellBorder}>
          <div className="flex items-center gap-1">
            {!isTester && (
              isBacklogView
                ? <button onClick={() => upd({ is_backlog: 0 })} title="Restore from backlog to its sprint" className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)]" style={{ color: '#4ade80' }}><ArchiveRestore size={14} /></button>
                : <button onClick={() => upd({ is_backlog: 1 })} title="Move to backlog" className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)] opacity-0 group-hover:opacity-100" style={{ color: 'var(--c-text-muted)' }}><Archive size={14} /></button>
            )}
            {!isTester && <button onClick={() => { if (confirm('Delete this feature?')) onDelete(f.id) }} title="Delete" className="p-1 rounded cursor-pointer hover:bg-[var(--c-surface-2)] opacity-0 group-hover:opacity-100" style={{ color: '#f87171' }}><Trash2 size={14} /></button>}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={17} style={{ borderBottom: '2px solid var(--c-border)', borderRight: '1px solid var(--c-border)', backgroundColor: 'var(--c-surface)' }}>
            <FeatureDetail f={f} isTester={isTester} members={members} onCreateIssue={onCreateIssue} onGoToSession={onGoToSession} model={model} refreshIssues={refreshIssues} />
          </td>
        </tr>
      )}
    </>
  )
}

function DateCell({ value, onChange }) {
  // value may be a plain date "YYYY-MM-DD" or an auto-stamped IST datetime "YYYY-MM-DD HH:MM".
  const datePart = (value || '').slice(0, 10)
  const timePart = value && value.length > 10 ? value.slice(11, 16) : ''
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <input type="date" value={datePart} onChange={e => onChange(e.target.value || null)} className="text-[12px] bg-transparent outline-none rounded px-1 py-0.5 focus:bg-[var(--c-surface-2)] w-[118px]" style={{ color: value ? 'var(--c-text)' : 'var(--c-text-muted)' }} />
      {timePart && <span className="text-[10px] font-mono" style={{ color: 'var(--c-text-muted)' }} title="Recorded time (IST)">{timePart}</span>}
    </span>
  )
}

// ── Detail drawer: subtasks + bugs + test cases ─────────────────────────────
function FeatureDetail({ f, isTester, members, onCreateIssue, onGoToSession, model, refreshIssues }) {
  return (
    <div className="px-6 py-4 flex flex-col gap-6">
      <SubtasksPanel f={f} isTester={isTester} members={members} onCreateIssue={onCreateIssue} onGoToSession={onGoToSession} model={model} refreshIssues={refreshIssues} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BugsPanel f={f} isTester={isTester} onGoToSession={onGoToSession} model={model} refreshIssues={refreshIssues} />
        <TestCasesPanel f={f} isTester={isTester} onGoToSession={onGoToSession} model={model} refreshIssues={refreshIssues} />
      </div>
    </div>
  )
}

function SubtasksPanel({ f, isTester, members, onCreateIssue, onGoToSession, model, refreshIssues }) {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => { setLoading(true); try { setSubs(await getSubtasks(f.id) || []) } finally { setLoading(false) } }, [f.id])
  useEffect(() => { load() }, [load])

  const add = async () => {
    if (!title.trim() || !onCreateIssue) return
    await onCreateIssue({ title: title.trim(), parentIssueId: f.id, category: 'issue', type: 'task' })
    setTitle(''); load(); refreshIssues()
  }
  const start = async (sub) => {
    setBusy(sub.id)
    try { const r = await startFeatureSession(sub.id, model); load(); refreshIssues(); if (r?.sessionId) onGoToSession(r.sessionId) }
    finally { setBusy(null) }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <ListTree size={14} style={{ color: 'var(--c-accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--c-text)' }}>Subtasks</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--c-text-muted)' }}>{subs.length}</span>
      </div>
      {!isTester && (
        <div className="flex items-center gap-2 mb-2">
          <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="Add a subtask…" className="flex-1 text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
          <button onClick={add} className="text-xs px-2 py-1.5 rounded cursor-pointer" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}><Plus size={12} /></button>
        </div>
      )}
      {loading ? <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>Loading…</div> : (
        <div className="flex flex-col gap-1">
          {subs.length === 0 && <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>No subtasks yet.</div>}
          {subs.map(s => (
            <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)' }}>
              <span className="flex-1 text-xs" style={{ color: 'var(--c-text)' }}>{s.title}</span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: devStatusMeta(s.dev_status).color + '22', color: devStatusMeta(s.dev_status).color }}>{devStatusMeta(s.dev_status).label}</span>
              <span className="text-[10px] font-mono tabular-nums" style={{ color: completionColor(featureCompletion(s)) }}>{featureCompletion(s)}%</span>
              {isTester ? null : s.session_id ? (
                <button onClick={() => onGoToSession(s.session_id)} title="Open subtask session" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-accent)' }}><MessageSquare size={12} /></button>
              ) : (
                <button onClick={() => start(s)} disabled={busy === s.id} title="Start session for this subtask" className="p-1 rounded cursor-pointer disabled:opacity-40" style={{ color: '#4ade80' }}>{busy === s.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BugsPanel({ f, isTester, onGoToSession, model, refreshIssues }) {
  const [bugs, setBugs] = useState([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [critical, setCritical] = useState(false)
  const [forking, setForking] = useState(null)

  const load = useCallback(async () => { setLoading(true); try { setBugs(await getBugs(f.id) || []) } finally { setLoading(false) } }, [f.id])
  useEffect(() => { load() }, [load])

  const add = async () => {
    if (!title.trim()) return
    await createBug(f.id, { title: title.trim(), severity: critical ? 'critical' : 'normal' })
    setTitle(''); setCritical(false); load(); refreshIssues()
  }
  const setStatus = async (b, status) => { await updateBug(b.id, { status }); load(); refreshIssues() }
  const remove = async (b) => { await deleteBug(b.id); load(); refreshIssues() }
  // action: 'fork' → new session off the dev session · 'send' → add to the current dev session
  const sendToFix = async (b, action) => {
    setForking(b.id)
    try { const r = await forkBug(b.id, model, action); load(); refreshIssues(); if (r?.sessionId) onGoToSession(r.sessionId) }
    finally { setForking(null) }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Bug size={14} style={{ color: '#f59e0b' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--c-text)' }}>QA Bugs</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--c-text-muted)' }}>{bugs.filter(b => b.status !== 'fixed' && b.status !== 'wont_fix').length} open</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="Describe a bug QA found…" className="flex-1 text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
        <label className="flex items-center gap-1 text-[10px] cursor-pointer" style={{ color: critical ? '#ef4444' : 'var(--c-text-muted)' }}>
          <input type="checkbox" checked={critical} onChange={e => setCritical(e.target.checked)} /> Critical
        </label>
        <button onClick={add} className="text-xs px-2 py-1.5 rounded cursor-pointer" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}><Plus size={12} /></button>
      </div>
      {loading ? <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>Loading…</div> : (
        <div className="flex flex-col gap-1">
          {bugs.length === 0 && <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>No bugs logged.</div>}
          {bugs.map(b => {
            const fixed = b.status === 'fixed' || b.status === 'wont_fix'
            return (
              <div key={b.id} className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)' }}>
                {b.severity === 'critical' && <span className="text-[9px] px-1 rounded font-bold" style={{ backgroundColor: '#ef444422', color: '#ef4444' }}>CRIT</span>}
                <span className="flex-1 text-xs" style={{ color: 'var(--c-text)', textDecoration: fixed ? 'line-through' : 'none', opacity: fixed ? 0.5 : 1 }}>{b.title}</span>
                <select value={b.status} onChange={e => setStatus(b, e.target.value)} className="text-[10px] rounded px-1 py-0.5 outline-none cursor-pointer" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
                  <option value="open">Open</option>
                  <option value="fixing">Fixing</option>
                  <option value="fixed">Fixed</option>
                  <option value="wont_fix">Won't fix</option>
                </select>
                {b.fix_session_id ? (
                  <button onClick={() => onGoToSession(b.fix_session_id)} title="Open fix session" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-accent)' }}><MessageSquare size={12} /></button>
                ) : forking === b.id ? (
                  <span className="p-1"><Loader2 size={12} className="animate-spin" style={{ color: 'var(--c-text-secondary)' }} /></span>
                ) : (
                  <>
                    {f.session_id && (
                      <button onClick={() => sendToFix(b, 'send')} title="Add to the current dev session (keep one session)" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-accent)' }}><CornerDownRight size={12} /></button>
                    )}
                    <button onClick={() => sendToFix(b, 'fork')} title="Fork a new session to fix this bug" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-secondary)' }}><GitFork size={12} /></button>
                  </>
                )}
                <button onClick={() => remove(b)} title="Delete" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={12} /></button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TestCasesPanel({ f, isTester, onGoToSession, model, refreshIssues }) {
  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => { setLoading(true); try { setCases(await getTestCases(f.id) || []) } finally { setLoading(false) } }, [f.id])
  useEffect(() => { load() }, [load])

  const add = async () => {
    if (!title.trim()) return
    await createTestCase(f.id, { title: title.trim() })
    setTitle(''); load(); refreshIssues()
  }
  const cycle = async (tc) => {
    const next = tc.status === 'pending' ? 'pass' : tc.status === 'pass' ? 'fail' : 'pending'
    await updateTestCase(tc.id, { status: next }); load()
  }
  const remove = async (tc) => { await deleteTestCase(tc.id); load(); refreshIssues() }
  const generate = async () => {
    setGenerating(true)
    try { const r = await generateTestCases(f.id, model); if (r?.sessionId) onGoToSession(r.sessionId) }
    finally { setGenerating(false) }
  }

  const statusColor = (s) => s === 'pass' ? '#22c55e' : s === 'fail' ? '#ef4444' : 'var(--c-text-muted)'

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical size={14} style={{ color: 'var(--c-accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--c-text)' }}>Test Cases</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--c-text-muted)' }}>{cases.length}</span>
        <div className="flex-1" />
        <button onClick={generate} disabled={generating} title="Generate test cases via the bot (forks the feature session)" className="text-[10px] px-2 py-1 rounded cursor-pointer flex items-center gap-1 disabled:opacity-40" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
          {generating ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Generate via bot
        </button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="Add a test case manually…" className="flex-1 text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
        <button onClick={add} className="text-xs px-2 py-1.5 rounded cursor-pointer" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}><Plus size={12} /></button>
      </div>
      {loading ? <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>Loading…</div> : (
        <div className="flex flex-col gap-1">
          {cases.length === 0 && <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>No test cases yet — add manually or generate via the bot.</div>}
          {cases.map(tc => (
            <div key={tc.id} className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)' }}>
              <button onClick={() => cycle(tc)} title={tc.status} className="w-4 h-4 rounded-full flex items-center justify-center cursor-pointer shrink-0" style={{ border: `1.5px solid ${statusColor(tc.status)}` }}>
                {tc.status === 'pass' && <Check size={10} style={{ color: '#22c55e' }} />}
                {tc.status === 'fail' && <X size={10} style={{ color: '#ef4444' }} />}
              </button>
              <span className="flex-1 text-xs" style={{ color: 'var(--c-text)' }}>{tc.title}</span>
              {tc.source === 'generated' && <span className="text-[9px] px-1 rounded" style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text-muted)' }}>bot</span>}
              <button onClick={() => remove(tc)} title="Delete" className="p-1 rounded cursor-pointer" style={{ color: 'var(--c-text-muted)' }}><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Quick add feature row ────────────────────────────────────────────────────
function QuickAddFeature({ sprintId, members, onCreate }) {
  const [platform, setPlatform] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [deadline, setDeadline] = useState('')
  const [type, setType] = useState('feature')
  const [assignedTo, setAssignedTo] = useState('')
  const [qaOwner, setQaOwner] = useState('')

  const submit = async () => {
    if (!title.trim()) return
    await onCreate({ title: title.trim(), description: description.trim(), deadline: deadline || null, platform, type, assignedTo: assignedTo || null, qaOwner, priority: 'medium' })
    setTitle(''); setDescription(''); setDeadline(''); setPlatform(''); setQaOwner(''); setAssignedTo('')
  }

  return (
    <div className="flex items-start gap-2 px-3 py-3 flex-wrap" style={{ borderTop: '1px solid var(--c-border)' }}>
      <Plus size={14} className="mt-2" style={{ color: 'var(--c-text-muted)' }} />
      <input value={platform} onChange={e => setPlatform(e.target.value)} list="platform-suggestions" placeholder="Platform" className="text-xs px-2 py-1.5 rounded outline-none w-28" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
      <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
        <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="Title — new feature / story…" className="w-full text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
        <input value={description} onChange={e => setDescription(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="Description (optional)…" className="w-full text-xs px-2 py-1.5 rounded outline-none" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }} />
      </div>
      <select value={type} onChange={e => setType(e.target.value)} className="text-xs px-2 py-1.5 rounded outline-none cursor-pointer" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}>
        {TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
      </select>
      <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className="text-xs px-2 py-1.5 rounded outline-none cursor-pointer max-w-[120px]" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}>
        <option value="">Dev…</option>
        {(members || []).map(m => <option key={m.id} value={m.id}>{m.display_name || m.email}</option>)}
      </select>
      <input value={qaOwner} onChange={e => setQaOwner(e.target.value)} placeholder="QA Owner" className="text-xs px-2 py-1.5 rounded outline-none w-28" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }} />
      <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} title="Deadline" className="text-xs px-2 py-1.5 rounded outline-none w-36" style={{ backgroundColor: 'var(--c-surface)', color: deadline ? 'var(--c-text)' : 'var(--c-text-muted)', border: '1px solid var(--c-border)' }} />
      <button onClick={submit} className="text-xs px-3 py-1.5 rounded cursor-pointer font-medium" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>Add</button>
      <datalist id="platform-suggestions">{PLATFORM_SUGGESTIONS.map(p => <option key={p} value={p} />)}</datalist>
    </div>
  )
}

// ── Changelog button + modal ─────────────────────────────────────────────────
function ChangelogButton({ sprint, features, onGetChangelog, onRequestIssueSummary, onGetIssueLastResponse, onGenerateChangelog }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')

  const generate = async () => {
    setBusy(true)
    try {
      // Collect a short summary from each feature's linked session, then ask the bot to build the changelog.
      const withSessions = features.filter(f => f.session_id)
      const summaries = []
      for (const f of withSessions) {
        setPhase(`Summarizing ${f.title.slice(0, 30)}…`)
        try {
          await onRequestIssueSummary(f.id)
          // brief poll
          for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 1500))
            const resp = await onGetIssueLastResponse(f.id)
            if (resp?.content && resp.status !== 'running') { summaries.push({ issueId: f.id, title: f.title, summary: resp.content }); break }
          }
        } catch (_) { /* skip */ }
      }
      // Always include a structured fallback line per feature.
      for (const f of features) {
        if (!summaries.find(s => s.issueId === f.id)) {
          summaries.push({ issueId: f.id, title: f.title, summary: `Status: ${devStatusMeta(f.dev_status).label}, ${featureCompletion(f)}% done${(f.open_bugs || 0) ? `, ${f.open_bugs} open bugs` : ''}.` })
        }
      }
      setPhase('Generating changelog…')
      await onGenerateChangelog(sprint.id, summaries)
      setOpen(false)
    } finally { setBusy(false); setPhase('') }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="text-[11px] px-2 py-1 rounded cursor-pointer flex items-center gap-1" style={{ backgroundColor: 'var(--c-surface)', color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
        <FileText size={12} /> Changelog
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }} onClick={() => !busy && setOpen(false)}>
          <div className="rounded-lg p-5 max-w-md w-full mx-4" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <FileText size={16} style={{ color: 'var(--c-accent)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>Generate Sprint Changelog</span>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--c-text-secondary)' }}>
              Collects a summary from each feature's linked session and asks the bot to produce a structured changelog for <strong>{sprint.name}</strong> ({features.length} features). The changelog opens as a new session.
            </p>
            {busy && <div className="text-[11px] mb-3 flex items-center gap-2" style={{ color: 'var(--c-text-muted)' }}><Loader2 size={12} className="animate-spin" /> {phase}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={busy} className="text-xs px-3 py-1.5 rounded cursor-pointer disabled:opacity-40" style={{ color: 'var(--c-text-muted)' }}>Cancel</button>
              <button onClick={generate} disabled={busy} className="text-xs px-3 py-1.5 rounded cursor-pointer font-medium disabled:opacity-40" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>{busy ? 'Working…' : 'Generate'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
