import { useState, useEffect } from 'react'
import { X, UserPlus, Trash2, KeyRound, Phone, Save, Clock, Check, XCircle, ToggleLeft, ToggleRight } from 'lucide-react'

export function AdminModal({ isOpen, onClose, title, children }) {
  if (!isOpen) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm" style={{ backgroundColor: 'var(--c-overlay)' }} onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors cursor-pointer"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}

export function UsersPanel({ users = [], onAdd, onDelete, onResetPassword }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('developer')
  const [isAdmin, setIsAdmin] = useState(false)

  const handleAdd = async () => {
    if (!email) return
    await onAdd({ email, displayName: name, role, isAdmin })
    setEmail(''); setName(''); setRole('developer'); setIsAdmin(false)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent col-span-2" />
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Display name" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent" />
        <select value={role} onChange={e => setRole(e.target.value)} className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent cursor-pointer">
          <option value="developer">Developer</option>
          <option value="tester">Tester</option>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} className="accent-accent" /> Admin privileges
        </label>
        <button onClick={handleAdd} className="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer">
          <UserPlus size={14} /> Add User
        </button>
      </div>
      <div className="divide-y divide-border">
        {users.map(u => (
          <div key={u.id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-text-primary">{u.display_name || u.email}</p>
              <p className="text-xs text-text-muted">{u.email} · <span className="capitalize">{u.role}</span>{u.is_admin ? ' · Admin' : ''}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => onResetPassword(u.id)} className="text-text-muted hover:text-accent text-xs flex items-center gap-1 transition-colors cursor-pointer"><KeyRound size={12} /> Reset</button>
              <button onClick={() => { if (confirm('Delete this user?')) onDelete(u.id) }} className="text-text-muted hover:text-danger text-xs flex items-center gap-1 transition-colors cursor-pointer"><Trash2 size={12} /> Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function PhonesPanel({ phones = [], onAdd, onRemove }) {
  const [phone, setPhone] = useState('')
  const [label, setLabel] = useState('')

  const handleAdd = async () => {
    if (!phone) return
    await onAdd(phone, label)
    setPhone(''); setLabel('')
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone number (e.g. 919970000000)" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent flex-1" />
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent w-32" />
        <button onClick={handleAdd} className="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center gap-2 transition-colors cursor-pointer shrink-0">
          <Phone size={14} /> Add
        </button>
      </div>
      <div className="divide-y divide-border">
        {phones.map(p => (
          <div key={p.phone} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-mono text-text-primary">{p.phone}</p>
              <p className="text-xs text-text-muted">{p.label || 'No label'}{p.user_name ? ` · ${p.user_name}` : ''}</p>
            </div>
            <button onClick={() => onRemove(p.phone)} className="text-text-muted hover:text-danger text-xs flex items-center gap-1 transition-colors cursor-pointer"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function PromptsPanel({ prompt = '', onSave, loading }) {
  const [value, setValue] = useState(prompt)
  return (
    <div className="space-y-4">
      <textarea value={value} onChange={e => setValue(e.target.value)} className="w-full min-h-[300px] bg-surface-2 border border-border rounded-lg px-4 py-3 text-sm font-mono text-text-primary placeholder-text-muted outline-none focus:border-accent resize-y" placeholder="CLAUDE.md content..." />
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">Changes apply to new sessions only.</p>
        <button onClick={() => onSave(value)} disabled={loading} className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center gap-2 transition-colors cursor-pointer">
          <Save size={14} /> {loading ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export function LearningsPanel({ content = '', onSave, loading }) {
  const [value, setValue] = useState(content)
  useEffect(() => { setValue(content) }, [content])
  const lineCount = (value || '').split('\n').length
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">{lineCount} lines — auto-updated after each session</p>
        <span className="text-[10px] text-accent bg-accent/10 px-2 py-0.5 rounded-full">Self-Learning</span>
      </div>
      <textarea value={value} onChange={e => setValue(e.target.value)} className="w-full min-h-[400px] bg-surface-2 border border-border rounded-lg px-4 py-3 text-sm font-mono text-text-primary placeholder-text-muted outline-none focus:border-accent resize-y" placeholder="LEARNINGS.md content..." />
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">Edit to curate learnings. Remove stale entries. New sessions read this file.</p>
        <button onClick={() => onSave(value)} disabled={loading} className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center gap-2 transition-colors cursor-pointer">
          <Save size={14} /> {loading ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

export function CronPanel({ jobs = [], onSave, onDelete }) {
  const [id, setId] = useState('')
  const [schedule, setSchedule] = useState('')
  const [task, setTask] = useState('')

  const handleSave = async () => {
    if (!id || !schedule || !task) return
    await onSave({ id, schedule, task })
    setId(''); setSchedule(''); setTask('')
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <input value={id} onChange={e => setId(e.target.value)} placeholder="Job ID" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent" />
        <input value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="Cron (e.g. 0 9 * * *)" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm font-mono text-text-primary placeholder-text-muted outline-none focus:border-accent" />
        <input value={task} onChange={e => setTask(e.target.value)} placeholder="Task description" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent col-span-2" />
        <button onClick={handleSave} className="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer">
          <Clock size={14} /> Save Job
        </button>
      </div>
      <div className="divide-y divide-border">
        {jobs.map(j => (
          <div key={j.id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-text-primary">{j.id}</p>
              <p className="text-xs text-text-muted font-mono">{j.schedule} · {j.task?.slice(0, 60)}</p>
            </div>
            <button onClick={() => onDelete(j.id)} className="text-text-muted hover:text-danger text-xs flex items-center gap-1 transition-colors cursor-pointer"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SettingsPanel({ settings = {}, onSave }) {
  const [showAll, setShowAll] = useState(settings.show_all_sessions === 'true')
  const [billingMode, setBillingMode] = useState(settings.claude_billing_mode || 'api')

  useEffect(() => {
    setShowAll(settings.show_all_sessions === 'true')
    setBillingMode(settings.claude_billing_mode || 'api')
  }, [settings.show_all_sessions, settings.claude_billing_mode])

  const handleToggle = async () => {
    const newVal = !showAll
    setShowAll(newVal)
    await onSave('show_all_sessions', String(newVal))
  }

  const handleBillingMode = async (mode) => {
    setBillingMode(mode)
    await onSave('claude_billing_mode', mode)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between py-3 px-1">
        <div>
          <p className="text-sm font-medium text-text-primary">Show everyone's sessions</p>
          <p className="text-xs text-text-muted mt-0.5">When enabled, all users can see sessions from every team member.</p>
        </div>
        <button onClick={handleToggle} className="shrink-0 ml-4 cursor-pointer transition-colors" style={{ color: showAll ? 'var(--c-accent)' : 'var(--c-text-muted)' }}>
          {showAll ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
        </button>
      </div>

      <div className="py-3 px-1" style={{ borderTop: '1px solid var(--c-border)' }}>
        <p className="text-sm font-medium text-text-primary mb-1">Claude billing mode</p>
        <p className="text-xs text-text-muted mb-3">Choose based on how Claude is authenticated. API mode shows cost ($), CLI/subscription mode shows token usage instead.</p>
        <div className="flex gap-2">
          <button onClick={() => handleBillingMode('api')}
            className="text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer transition-colors"
            style={{ backgroundColor: billingMode === 'api' ? 'var(--c-accent)' : 'var(--c-surface-2)', color: billingMode === 'api' ? '#fff' : 'var(--c-text-secondary)', border: `1px solid ${billingMode === 'api' ? 'var(--c-accent)' : 'var(--c-border)'}` }}>
            API Key (show cost)
          </button>
          <button onClick={() => handleBillingMode('cli')}
            className="text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer transition-colors"
            style={{ backgroundColor: billingMode === 'cli' ? 'var(--c-accent)' : 'var(--c-surface-2)', color: billingMode === 'cli' ? '#fff' : 'var(--c-text-secondary)', border: `1px solid ${billingMode === 'cli' ? 'var(--c-accent)' : 'var(--c-border)'}` }}>
            CLI Auth (show tokens)
          </button>
        </div>
      </div>
    </div>
  )
}

export function AccessRequestsPanel({ requests = [], onResolve }) {
  return (
    <div className="space-y-1">
      {requests.length === 0 && <p className="text-sm text-text-muted text-center py-8">No pending requests.</p>}
      <div className="divide-y divide-border">
        {requests.map(r => (
          <div key={r.id} className="py-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-medium text-text-primary">{r.requester_name}</p>
                <p className="text-xs text-text-muted">{r.requester_email}</p>
                <p className="text-xs text-text-secondary mt-1">Session: {r.session_task?.slice(0, 60)}</p>
                {r.note && <p className="text-xs text-text-muted mt-1 italic">"{r.note}"</p>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => onResolve(r.id, true)} className="bg-success/20 text-success hover:bg-success/30 text-xs font-medium rounded-lg px-3 py-1.5 flex items-center gap-1 transition-colors cursor-pointer"><Check size={12} /> Approve</button>
                <button onClick={() => onResolve(r.id, false)} className="bg-danger/20 text-danger hover:bg-danger/30 text-xs font-medium rounded-lg px-3 py-1.5 flex items-center gap-1 transition-colors cursor-pointer"><XCircle size={12} /> Reject</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
