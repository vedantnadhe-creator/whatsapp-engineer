import { useState, useEffect, useCallback } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { useSessions, useStats, useSessionMessages, useModels, usePhones, useUsers, useCron, useAccessRequests, useAction, startSession, sendMessage, stopSession, uploadFile, transcribeAudio, requestAccess, getClaudePrompt, saveClaudePrompt } from './hooks/useApi'
import Sidebar from './components/Sidebar'
import Workspace from './components/Workspace'
import Login from './pages/Login'
import { AdminModal, UsersPanel, PhonesPanel, PromptsPanel, CronPanel, AccessRequestsPanel } from './components/AdminPanels'
import { ThemeProvider } from './context/ThemeContext'

function Dashboard() {
  const { user, loading, logout } = useAuth()

  const [page, setPage] = useState(1)
  const [activeSession, setActiveSession] = useState(null)
  const [isNewSession, setIsNewSession] = useState(true)
  const [adminPanel, setAdminPanel] = useState(null)
  const [selectedModel, setSelectedModel] = useState('opus')
  const [claudePrompt, setClaudePrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)

  const { stats, refresh: refreshStats } = useStats()
  const { sessions, total, totalPages, refresh: refreshSessions } = useSessions(page)
  const { messages, refresh: refreshMessages } = useSessionMessages(activeSession?.id)
  const { models } = useModels()
  const { phones, refresh: refreshPhones, addPhone, removePhone } = usePhones()
  const { users, refresh: refreshUsers, addUser, deleteUser, resetPassword } = useUsers()
  const { jobs, refresh: refreshCron, saveJob, deleteJob } = useCron()
  const { requests, refresh: refreshRequests, resolve } = useAccessRequests()

  // Keep activeSession in sync with refreshed sessions list
  useEffect(() => {
    if (activeSession?.id && sessions.length > 0) {
      const updated = sessions.find(s => s.id === activeSession.id)
      if (updated && updated.status !== activeSession.status) {
        setActiveSession(updated)
      }
    }
  }, [sessions])

  // Poll for updates
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStats()
      refreshSessions()
      if (activeSession?.id) refreshMessages()
    }, 5000)
    return () => clearInterval(interval)
  }, [activeSession?.id])

  const handleSelectSession = useCallback((session) => {
    setActiveSession(session)
    setIsNewSession(false)
    setSelectedModel(session.model || 'opus')
  }, [])

  const handleNewSession = useCallback(() => {
    setActiveSession(null)
    setIsNewSession(true)
    setSelectedModel('opus')
  }, [])

  const _startSession = useCallback(async (text, model) => {
    const result = await startSession(text, model)
    if (result.sessionId) {
      const newSession = {
        id: result.sessionId,
        task: text,
        model: model || 'opus',
        status: 'running',
        is_mine: true,
      }
      setActiveSession(newSession)
      setIsNewSession(false)
      setSelectedModel(model || 'opus')
      setTimeout(() => {
        refreshSessions()
        refreshStats()
        refreshMessages()
      }, 1500)
    }
  }, [])
  const [handleStartSession, startingSession] = useAction(_startSession)

  const _sendMessage = useCallback(async (text, model) => {
    if (!activeSession?.id) return
    await sendMessage(activeSession.id, text)
    setTimeout(() => refreshMessages(), 1000)
  }, [activeSession?.id])
  const [handleSendMessage, sendingMessage] = useAction(_sendMessage)

  const _stopSession = useCallback(async () => {
    if (!activeSession?.id) return
    await stopSession(activeSession.id)
    refreshSessions()
    refreshStats()
  }, [activeSession?.id])
  const [handleStop, stoppingSession] = useAction(_stopSession)

  const handleShowAdmin = useCallback(async (panel) => {
    setAdminPanel(panel)
    if (panel === 'users') refreshUsers()
    if (panel === 'phones') refreshPhones()
    if (panel === 'cron') refreshCron()
    if (panel === 'requests') refreshRequests()
    if (panel === 'prompts') {
      setPromptLoading(true)
      try {
        const data = await getClaudePrompt()
        setClaudePrompt(data.prompt || '')
      } catch (e) { }
      setPromptLoading(false)
    }
  }, [])

  const handleSavePrompt = useCallback(async (prompt) => {
    setPromptLoading(true)
    try {
      await saveClaudePrompt(prompt)
      setClaudePrompt(prompt)
    } catch (e) { }
    setPromptLoading(false)
  }, [])

  // Early returns AFTER all hooks
  if (loading) return <div className="h-screen flex items-center justify-center bg-bg text-text-secondary font-mono text-sm">Loading...</div>
  if (!user) return <Login />

  const hasAccess = activeSession ? (activeSession.is_mine || activeSession.has_access || user?.isAdmin) : true

  return (
    <div className="h-screen flex bg-bg font-sans overflow-hidden">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSession?.id}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        stats={stats}
        user={user}
        onLogout={logout}
        onShowAdmin={handleShowAdmin}
        onLoadMore={() => setPage(p => Math.min(p + 1, totalPages || 1))}
        hasMore={page < (totalPages || 1)}
        pendingRequestsCount={requests?.length || 0}
      />
      <div className="flex-1 min-w-0 h-full">
        <Workspace
          session={activeSession}
          messages={messages}
          onSendMessage={handleSendMessage}
          onStop={handleStop}
          onRequestAccess={async (note) => {
            if (!activeSession?.id) return
            await requestAccess(activeSession.id, note)
          }}
          isNewSession={isNewSession}
          onStartSession={handleStartSession}
          onUploadFile={uploadFile}
          onTranscribe={transcribeAudio}
          models={models}
          hasAccess={hasAccess}
          busy={startingSession || sendingMessage || stoppingSession}
        />
      </div>

      {adminPanel === 'users' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Team Members">
          <UsersPanel users={users} onAdd={async (data) => { await addUser(data); refreshUsers() }} onDelete={async (id) => { await deleteUser(id); refreshUsers() }} onResetPassword={async (id) => { await resetPassword(id) }} />
        </AdminModal>
      )}
      {adminPanel === 'phones' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Allowed Phones">
          <PhonesPanel phones={phones} onAdd={async (phone, label) => { await addPhone(phone, label); refreshPhones() }} onRemove={async (phone) => { await removePhone(phone); refreshPhones() }} />
        </AdminModal>
      )}
      {adminPanel === 'prompts' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="System Prompt (CLAUDE.md)">
          <PromptsPanel prompt={claudePrompt} onSave={handleSavePrompt} loading={promptLoading} />
        </AdminModal>
      )}
      {adminPanel === 'cron' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Cron Jobs">
          <CronPanel jobs={jobs} onSave={async (job) => { await saveJob(job); refreshCron() }} onDelete={async (id) => { await deleteJob(id); refreshCron() }} />
        </AdminModal>
      )}
      {adminPanel === 'requests' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Access Requests">
          <AccessRequestsPanel requests={requests} onResolve={async (id, approve) => { await resolve(id, approve); refreshRequests() }} />
        </AdminModal>
      )}
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Dashboard />
      </AuthProvider>
    </ThemeProvider>
  )
}
