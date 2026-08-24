// ============================================================
// sprintMeta.js — Option sets and pure derivations shared by the Sprint
// table (SprintBoard.jsx) and the Kanban board (SprintKanban.jsx).
//
// One definition per concept so the two views can never disagree about a
// status, a type colour or a completion percentage. Pure module — no React.
// ============================================================

// Prefer a person's display name; fall back to the email's local part, never the raw email.
// (/api/users returns camelCase `displayName`; other shapes use `display_name`.)
export const memberName = (m) => m?.display_name || m?.displayName || (m?.email ? m.email.split('@')[0] : '') || m?.id || ''

// ── Option sets ────────────────────────────────────────────────────────────
export const DEV_STATUS = [
  { v: 'todo', label: 'To Do', color: 'var(--c-text-muted)' },
  { v: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { v: 'dev_completed', label: 'Dev Completed', color: '#3b82f6' },
  { v: 'done', label: 'Done', color: '#22c55e' },
]
export const QA_STATUS = [
  { v: '', label: '—', color: 'var(--c-text-muted)' },
  { v: 'testing', label: 'Testing', color: '#f59e0b' },
  { v: 'pass', label: 'Pass', color: '#22c55e' },
  { v: 'fail', label: 'Fail', color: '#ef4444' },
  { v: 'not_needed', label: 'Not needed', color: 'var(--c-text-muted)' },
]
export const TYPES = [
  { v: 'epic', label: 'Epic' },
  { v: 'feature', label: 'Feature' },
  { v: 'task', label: 'Task' },
  { v: 'bug', label: 'Bug' },
  { v: 'improvement', label: 'Improvement' },
]
export const PLATFORM_SUGGESTIONS = ['ATS', 'Assessment', 'Both', 'Infra']

export const devStatusMeta = (v) => DEV_STATUS.find(s => s.v === v) || DEV_STATUS[0]

// ── Sprint lifecycle ───────────────────────────────────────────────────────
// Mirrors SPRINT_STATUSES in session_store.js. Only a 'active' (running) sprint
// gets the daily 6 AM status email — starting and stopping is what controls that,
// so the board labels these as Not started / Running / Stopped rather than by
// their stored value.
export const SPRINT_STATUS = [
  { v: 'planning', label: 'Not started', color: '#f59e0b' },
  { v: 'active', label: 'Running', color: '#22c55e' },
  { v: 'completed', label: 'Stopped', color: 'var(--c-text-muted)' },
]
export const sprintStatusMeta = (v) => SPRINT_STATUS.find(s => s.v === v) || SPRINT_STATUS[0]
export const isSprintRunning = (sprint) => sprint?.status === 'active'

// Feature completion %, driven by the QA lifecycle (mirrors session_store.js featureCompletion):
//   QA Pass / Done → 100 · Dev Completed (no open bugs) → 100 · Dev Completed + open QA bug → 50
//   To Do / In Progress → 0
export function featureCompletion(f) {
  if (!f) return 0
  const open = f.open_bugs || 0
  const qa = String(f.qa_status || '').toLowerCase()
  // Open bugs cap completion — a feature with live bugs can never read "done".
  if (open > 0) {
    if (f.dev_status === 'todo') return 0
    return (f.critical_bugs || 0) > 0 ? 40 : 50
  }
  if (qa === 'pass' || qa === 'passed' || qa === 'tested') return 100
  if (f.dev_status === 'done') return 100
  if (f.dev_status === 'dev_completed') return 70
  return 0
}
export const completionColor = (pct) => pct >= 100 ? '#4ade80' : pct >= 70 ? '#60a5fa' : pct >= 50 ? '#fbbf24' : 'var(--c-text-muted)'

// A row whose Type is Bug IS a bug: it counts toward the sprint bug totals until resolved,
// alongside the child bugs filed against features. Mirrors SessionStore.isOpenBugRow().
// Kept out of featureCompletion() on purpose — self-counting would cap a bug at 50% forever.
export const isOpenBugRow = (f) => f?.type === 'bug' && featureCompletion(f) < 100

// Total open bugs attributable to a row: its child bugs, plus itself when it is a bug.
export const openBugCount = (f) => (f?.open_bugs || 0) + (isOpenBugRow(f) ? 1 : 0)

// Pill foreground colors (dark theme) — backgrounds are derived as a translucent tint.
export const TYPE_PILL = {
  epic: '#a78bfa',
  feature: '#f472b6',
  task: '#4ade80',
  bug: '#f87171',
  improvement: '#22d3ee',
  story: '#60a5fa', // legacy fallback for older rows
}
// The dev team on a feature. Rows written before multi-assign — or by a single-assign
// screen like the issues board — still answer through assigned_to. Mirrors
// parseAssignees() in session_store.js; keep the two in sync.
export const assigneeIds = (f) => {
  try {
    const list = JSON.parse(f?.assignees || '[]')
    if (Array.isArray(list) && list.length) return list.filter(Boolean).map(String)
  } catch { /* malformed column — fall back to the primary below */ }
  return f?.assigned_to ? [String(f.assigned_to)] : []
}

export const ASSIGNEE_PILL = '#4ade80'
export const QA_OWNER_PILL = '#cbd5e1'
