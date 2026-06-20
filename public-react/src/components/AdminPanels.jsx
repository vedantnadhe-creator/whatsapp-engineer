import { useState, useEffect, useCallback } from 'react'
import { X, UserPlus, Trash2, KeyRound, Phone, Save, Clock, Check, XCircle, ToggleLeft, ToggleRight, AlertTriangle, RefreshCw, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { apiFetch } from '../hooks/useApi'

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

export function UsersPanel({ users = [], onAdd, onDelete, onResetPassword, onUpdateUser }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('developer')
  const [isAdmin, setIsAdmin] = useState(false)
  // Tester code-edit access. Default OFF (read-only tester) — admin opts in.
  const [canEdit, setCanEdit] = useState(false)
  // Tester access scope: 'chat' = can chat with the bot, 'sprint' = sprint board only.
  const [testerAccess, setTesterAccess] = useState('chat')

  const handleAdd = async () => {
    if (!email) return
    const sprintOnly = role === 'tester' && testerAccess === 'sprint'
    // canEdit only matters for chat-access testers; others always can edit.
    await onAdd({ email, displayName: name, role, isAdmin, canEdit: role === 'tester' ? (sprintOnly ? false : canEdit) : true, sprintOnly })
    setEmail(''); setName(''); setRole('developer'); setIsAdmin(false); setCanEdit(false); setTesterAccess('chat')
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent col-span-2" />
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Display name" className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent" />
        <select value={role} onChange={e => setRole(e.target.value)} className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent cursor-pointer">
          <option value="developer">Developer</option>
          <option value="designer">Designer</option>
          <option value="tester">Tester</option>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={isAdmin} onChange={e => setIsAdmin(e.target.checked)} className="accent-accent" /> Admin privileges
        </label>
        {role === 'tester' && (
          <div className="col-span-2 -mt-1 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">Access:</span>
              <select value={testerAccess} onChange={e => setTesterAccess(e.target.value)} className="bg-surface-2 border border-border rounded-lg px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent cursor-pointer">
                <option value="chat">Chat access (can chat with the bot)</option>
                <option value="sprint">Sprint board only (no chat / no sessions)</option>
              </select>
            </div>
            {testerAccess === 'chat' && (
              <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                <input type="checkbox" checked={canEdit} onChange={e => setCanEdit(e.target.checked)} className="accent-accent" />
                Allow code edits (off = read-only tester: can run tests & write test cases, but can't modify code)
              </label>
            )}
            {testerAccess === 'sprint' && (
              <p className="text-[11px] text-text-muted">Sprint-only testers see just the Sprint board — they can edit the columns but can't start or open sessions.</p>
            )}
          </div>
        )}
        <button onClick={handleAdd} className="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center justify-center gap-2 transition-colors cursor-pointer">
          <UserPlus size={14} /> Add User
        </button>
      </div>
      <div className="divide-y divide-border">
        {users.map(u => (
          <div key={u.id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-text-primary">{u.display_name || u.email}</p>
              <p className="text-xs text-text-muted">{u.email} · <span className="capitalize">{u.role}</span>{u.is_admin ? ' · Admin' : ''}{u.role === 'tester' ? (u.sprint_only ? ' · Sprint only' : (u.can_edit ? ' · Chat · can edit' : ' · Chat · read-only')) : ''}</p>
            </div>
            <div className="flex items-center gap-3">
              {u.role === 'tester' && onUpdateUser && (
                <button
                  onClick={() => onUpdateUser(u.id, { sprintOnly: !u.sprint_only })}
                  className="text-text-muted hover:text-accent text-xs flex items-center gap-1 transition-colors cursor-pointer"
                  title={u.sprint_only ? 'Sprint-only — click to give chat access' : 'Has chat access — click to make sprint-board-only'}
                >
                  {u.sprint_only ? <ToggleRight size={16} style={{ color: 'var(--c-accent)' }} /> : <ToggleLeft size={16} />}
                  {u.sprint_only ? 'Sprint only' : 'Chat'}
                </button>
              )}
              {u.role === 'tester' && !u.sprint_only && onUpdateUser && (
                <button
                  onClick={() => onUpdateUser(u.id, { canEdit: !u.can_edit })}
                  className="text-text-muted hover:text-accent text-xs flex items-center gap-1 transition-colors cursor-pointer"
                  title={u.can_edit ? 'Code edits allowed — click to make read-only' : 'Read-only — click to allow code edits'}
                >
                  {u.can_edit ? <ToggleRight size={16} style={{ color: 'var(--c-accent)' }} /> : <ToggleLeft size={16} />}
                  {u.can_edit ? 'Edits on' : 'Read-only'}
                </button>
              )}
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

function ClaudeAuthSection() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authUrl, setAuthUrl] = useState(null)
  const [token, setToken] = useState('')
  const [step, setStep] = useState('idle') // idle | starting | waiting_token | submitting | done | error
  const [error, setError] = useState(null)

  const checkStatus = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/api/claude/auth-status')
      setStatus(data)
    } catch (e) {
      setStatus({ loggedIn: false, raw: e.message })
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { checkStatus() }, [checkStatus])

  const startAuth = async () => {
    setStep('starting')
    setError(null)
    setAuthUrl(null)
    setToken('')
    try {
      const data = await apiFetch('/api/claude/auth-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (data.authUrl) { setAuthUrl(data.authUrl); setStep('waiting_token') }
      else { setError('No auth URL returned'); setStep('error') }
    } catch (e) { setError(e.message); setStep('error') }
  }

  const submitToken = async () => {
    if (!token.trim()) return
    setStep('submitting')
    setError(null)
    try {
      const data = await apiFetch('/api/claude/auth-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      if (data.success) { setStep('done'); setTimeout(checkStatus, 1000) }
      else { setError(data.output || 'Auth failed'); setStep('error') }
    } catch (e) { setError(e.message); setStep('error') }
  }

  const loggedIn = status?.loggedIn

  return (
    <div className="py-3 px-1" style={{ borderTop: '1px solid var(--c-border)' }}>
      <div className="flex items-center gap-2 mb-1">
        {loading ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--c-text-muted)' }} />
          : loggedIn ? <ShieldCheck size={14} style={{ color: 'var(--c-status-running)' }} />
          : <AlertTriangle size={14} style={{ color: '#ef4444' }} />}
        <p className="text-sm font-medium" style={{ color: 'var(--c-text)' }}>Claude authentication</p>
      </div>

      {!loading && loggedIn && (
        <div className="text-xs mt-1 mb-2 space-y-0.5" style={{ color: 'var(--c-text-secondary)' }}>
          <p>Logged in as <strong style={{ color: 'var(--c-text)' }}>{status.email || 'unknown'}</strong></p>
          {status.orgName && <p>Org: {status.orgName} &middot; {status.subscriptionType || 'unknown plan'}</p>}
        </div>
      )}

      {!loading && !loggedIn && step === 'idle' && (
        <p className="text-xs mt-1 mb-2" style={{ color: '#ef4444' }}>
          Claude is logged out. Sessions will fail with 401 errors until re-authenticated.
        </p>
      )}

      {/* Reconnect button */}
      {(step === 'idle' || step === 'done' || step === 'error') && (
        <button onClick={startAuth} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer mt-1"
          style={{ backgroundColor: loggedIn ? 'var(--c-surface-2)' : 'var(--c-accent)', color: loggedIn ? 'var(--c-text-secondary)' : '#fff', border: `1px solid ${loggedIn ? 'var(--c-border)' : 'var(--c-accent)'}` }}>
          <RefreshCw size={12} /> {loggedIn ? 'Re-authenticate' : 'Reconnect Claude'}
        </button>
      )}

      {step === 'starting' && (
        <div className="flex items-center gap-2 text-xs mt-2" style={{ color: 'var(--c-text-muted)' }}>
          <Loader2 size={12} className="animate-spin" /> Starting auth flow…
        </div>
      )}

      {/* Auth URL + token input */}
      {step === 'waiting_token' && authUrl && (
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-xs font-medium mb-1" style={{ color: 'var(--c-text)' }}>Step 1 — Open this link and authenticate:</p>
            <a href={authUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs break-all"
              style={{ color: 'var(--c-accent)' }}>
              <ExternalLink size={12} className="shrink-0" /> {authUrl}
            </a>
          </div>
          <div>
            <p className="text-xs font-medium mb-1" style={{ color: 'var(--c-text)' }}>Step 2 — Paste the token you receive:</p>
            <div className="flex gap-2">
              <input type="text" value={token} onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitToken() }}
                placeholder="Paste token here…"
                className="flex-1 text-xs px-2.5 py-1.5 rounded outline-none"
                style={{ backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', color: 'var(--c-text)' }} />
              <button onClick={submitToken} disabled={!token.trim()}
                className="text-xs px-3 py-1.5 rounded font-medium cursor-pointer disabled:opacity-40"
                style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'submitting' && (
        <div className="flex items-center gap-2 text-xs mt-2" style={{ color: 'var(--c-text-muted)' }}>
          <Loader2 size={12} className="animate-spin" /> Submitting token…
        </div>
      )}

      {step === 'done' && (
        <p className="text-xs mt-2" style={{ color: 'var(--c-status-running)' }}>Authenticated successfully. Refreshing status…</p>
      )}

      {error && (
        <p className="text-xs mt-2" style={{ color: '#ef4444' }}>{error}</p>
      )}
    </div>
  )
}

function parseModelList(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}

export function SettingsPanel({ settings = {}, onSave }) {
  const [showAll, setShowAll] = useState(settings.show_all_sessions === 'true')
  const [billingMode, setBillingMode] = useState(settings.claude_billing_mode || 'api')
  const [ollamaModels, setOllamaModels] = useState(parseModelList(settings.ollama_custom_models))
  const [newModel, setNewModel] = useState('')
  const [savingModels, setSavingModels] = useState(false)
  const [headroomOn, setHeadroomOn] = useState(settings.headroom_enabled === 'true')
  const [headroomStatus, setHeadroomStatus] = useState(null) // { reachable } | null

  useEffect(() => {
    setShowAll(settings.show_all_sessions === 'true')
    setBillingMode(settings.claude_billing_mode || 'api')
    setOllamaModels(parseModelList(settings.ollama_custom_models))
    setHeadroomOn(settings.headroom_enabled === 'true')
  }, [settings.show_all_sessions, settings.claude_billing_mode, settings.ollama_custom_models, settings.headroom_enabled])

  const refreshHeadroomStatus = useCallback(async () => {
    try { const r = await apiFetch('/api/admin/headroom/status'); setHeadroomStatus(r) } catch { setHeadroomStatus(null) }
  }, [])
  useEffect(() => { refreshHeadroomStatus() }, [refreshHeadroomStatus])

  const handleHeadroom = async () => {
    const newVal = !headroomOn
    setHeadroomOn(newVal)
    await onSave('headroom_enabled', String(newVal))
    refreshHeadroomStatus()
  }

  const handleToggle = async () => {
    const newVal = !showAll
    setShowAll(newVal)
    await onSave('show_all_sessions', String(newVal))
  }

  const handleBillingMode = async (mode) => {
    setBillingMode(mode)
    await onSave('claude_billing_mode', mode)
  }

  const persistModels = async (list) => {
    setOllamaModels(list)
    setSavingModels(true)
    try { await onSave('ollama_custom_models', JSON.stringify(list)) } finally { setSavingModels(false) }
  }

  const addModel = async () => {
    const name = newModel.trim()
    if (!name) return
    if (ollamaModels.includes(name)) { setNewModel(''); return }
    await persistModels([...ollamaModels, name])
    setNewModel('')
  }

  const removeModel = async (name) => {
    await persistModels(ollamaModels.filter(m => m !== name))
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

      <div className="flex items-center justify-between py-3 px-1" style={{ borderTop: '1px solid var(--c-border)' }}>
        <div className="pr-4">
          <p className="text-sm font-medium text-text-primary flex items-center gap-2">
            Headroom compression
            {headroomStatus && (
              <span className="inline-flex items-center gap-1 text-xs" style={{ color: headroomStatus.reachable ? 'var(--c-success, #22c55e)' : 'var(--c-text-muted)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: headroomStatus.reachable ? '#22c55e' : '#9ca3af', display: 'inline-block' }} />
                {headroomStatus.reachable ? 'proxy online' : 'proxy offline'}
              </span>
            )}
          </p>
          <p className="text-xs text-text-muted mt-0.5">Routes Claude sessions through the local Headroom proxy to compress context (fewer tokens, same answers). Doesn't affect Ollama sessions. If the proxy is offline, sessions run normally — the switch is ignored.</p>
        </div>
        <button onClick={handleHeadroom} className="shrink-0 ml-4 cursor-pointer transition-colors" style={{ color: headroomOn ? 'var(--c-accent)' : 'var(--c-text-muted)' }}>
          {headroomOn ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
        </button>
      </div>

      <div className="py-3 px-1" style={{ borderTop: '1px solid var(--c-border)' }}>
        <p className="text-sm font-medium text-text-primary mb-1">Ollama models {savingModels && <Loader2 size={12} className="inline animate-spin ml-1" />}</p>
        <p className="text-xs text-text-muted mb-3">Add an Ollama model tag (e.g. <code>kimi-k2:1t-cloud</code>, <code>gpt-oss:20b-cloud</code>). It appears in the model selector as <b>Ollama · …</b> and routes that session through Ollama. Pull/sign-in to the model in Ollama first.</p>
        <div className="flex gap-2 mb-3">
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addModel() } }}
            placeholder="model tag, e.g. qwen3-coder:480b-cloud"
            className="flex-1 text-sm rounded-md px-3 py-1.5"
            style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text-primary)', border: '1px solid var(--c-border)' }}
          />
          <button onClick={addModel}
            className="text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer transition-colors flex items-center gap-1"
            style={{ backgroundColor: 'var(--c-accent)', color: '#fff', border: '1px solid var(--c-accent)' }}>
            <Save size={12} /> Add
          </button>
        </div>
        {ollamaModels.length === 0 ? (
          <p className="text-xs text-text-muted italic">No custom models added. Built-in fallbacks still show in the selector.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {ollamaModels.map(m => (
              <div key={m} className="flex items-center justify-between rounded-md px-3 py-1.5"
                style={{ backgroundColor: 'var(--c-surface-2)', border: '1px solid var(--c-border)' }}>
                <span className="text-sm font-mono text-text-secondary">{m}</span>
                <button onClick={() => removeModel(m)} className="cursor-pointer text-text-muted hover:text-danger transition-colors" title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ClaudeAuthSection />
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
