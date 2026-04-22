import { useState, useEffect, useCallback } from 'react'
import { BrowserRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import SharePage from './pages/SharePage'
import { useSessions, useStats, useSessionMessages, useModels, usePhones, useUsers, useCron, useAccessRequests, useIssues, useAutonomous, useSprints, useTeamMembers, useAction, startSession, sendMessage, stopSession, forkSession, toggleBookmark, updateSessionSprint, getSprintChangelog, requestIssueSummary, getIssueLastResponse, generateSprintChangelog, uploadFile, transcribeAudio, requestAccess, getClaudePrompt, saveClaudePrompt, getLearnings, saveLearnings, getAdminSettings, saveAdminSetting, apiFetch } from './hooks/useApi'
import useWebSocket from './hooks/useWebSocket'
import Sidebar from './components/Sidebar'
import Workspace from './components/Workspace'
import IssuesBoard from './components/IssuesBoard'
import Pipeline from './components/Pipeline'
import Login from './pages/Login'
import ShareSessionModal from './components/ShareSessionModal'
import { AdminModal, UsersPanel, PhonesPanel, PromptsPanel, LearningsPanel, CronPanel, AccessRequestsPanel, SettingsPanel } from './components/AdminPanels'
import { ThemeProvider } from './context/ThemeContext'

function Dashboard() {
  const { user, loading, logout } = useAuth()
  const { id: urlSessionId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  const [page, setPage] = useState(1)
  const [activeSession, setActiveSession] = useState(urlSessionId ? { id: urlSessionId } : null)
  const [isNewSession, setIsNewSession] = useState(!urlSessionId)
  const [adminPanel, setAdminPanel] = useState(null)
  const [selectedModel, setSelectedModel] = useState('claude-opus-4-7')
  const [claudePrompt, setClaudePrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [learningsContent, setLearningsContent] = useState('')
  const [learningsLoading, setLearningsLoading] = useState(false)
  const [adminSettings, setAdminSettings] = useState({})
  const [view, setView] = useState('chat') // 'chat' or 'issues'
  const [notification, setNotification] = useState(null)
  const [shareSessionId, setShareSessionId] = useState(null)
  const [forkTriggerId, setForkTriggerId] = useState(null)

  const { stats, refresh: refreshStats } = useStats()
  const { sessions, total, totalPages, showAllSessions, refresh: refreshSessions } = useSessions(page)
  const { messages, refresh: refreshMessages } = useSessionMessages(activeSession?.id)
  const { models } = useModels()
  const { phones, refresh: refreshPhones, addPhone, removePhone } = usePhones()
  const { users, refresh: refreshUsers, addUser, deleteUser, resetPassword } = useUsers()
  const { jobs, refresh: refreshCron, saveJob, deleteJob } = useCron()
  const { requests, refresh: refreshRequests, resolve } = useAccessRequests()
  const { issues, refresh: refreshIssues, createIssue, updateIssue, deleteIssue, getStagePrompt, advanceStage } = useIssues()
  const { status: autonomousStatus, refresh: refreshAutonomous, start: startAutonomous, stop: stopAutonomous, toggleSelfDecisions } = useAutonomous()
  const { sprints, refresh: refreshSprints, createSprint, updateSprint, deleteSprint } = useSprints()
  const { members } = useTeamMembers()
  const { connected: wsConnected, typing: wsTyping, on: wsOn } = useWebSocket()

  // Keep activeSession in sync with refreshed sessions list
  useEffect(() => {
    if (activeSession?.id && sessions.length > 0) {
      const updated = sessions.find(s => s.id === activeSession.id)
      if (updated && (updated.status !== activeSession.status || !activeSession.task)) {
        setActiveSession(updated)
      }
    }
  }, [sessions])

  // Sync URL → activeSession when URL changes (e.g. browser back/forward, share redirect)
  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSession?.id) {
      const found = sessions.find(s => s.id === urlSessionId)
      setActiveSession(found || { id: urlSessionId })
      setIsNewSession(false)
      setView('chat')
    } else if (!urlSessionId && activeSession && location.pathname === '/') {
      setActiveSession(null)
      setIsNewSession(true)
    }
  }, [urlSessionId])

  // WebSocket event handlers — instant updates
  useEffect(() => {
    const unsubs = [
      // Claude output / session events → refresh messages + sessions
      wsOn('assistant_message', ({ sessionId }) => {
        if (activeSession?.id === sessionId) refreshMessages()
      }),
      wsOn('result', ({ sessionId }) => {
        if (activeSession?.id === sessionId) refreshMessages()
        refreshSessions()
        refreshStats()
      }),
      wsOn('session_end', ({ sessionId }) => {
        if (activeSession?.id === sessionId) refreshMessages()
        refreshSessions()
        refreshStats()
      }),
      wsOn('session_error', ({ sessionId }) => {
        if (activeSession?.id === sessionId) refreshMessages()
        refreshSessions()
      }),
      // Issue events
      wsOn('issue_created', () => { refreshIssues() }),
      wsOn('issue_updated', () => { refreshIssues() }),
      wsOn('issue_deleted', () => { refreshIssues() }),
      // Autonomous engine
      wsOn('autonomous_update', () => { refreshAutonomous() }),
      // Assignment notifications
      wsOn('issue_assigned', ({ issue, assigneeId, assignedBy, totalAssigned }) => {
        if (assigneeId === user?.id) {
          setNotification({
            message: `${assignedBy} assigned you "${issue.title}" (${totalAssigned} active)`,
            type: issue.type || 'task',
            issueId: issue.id,
          })
          setTimeout(() => setNotification(null), 6000)
        }
        refreshIssues()
      }),
      // Sprints
      wsOn('sprint_created', () => { refreshSprints() }),
      wsOn('sprint_updated', () => { refreshSprints() }),
      wsOn('sprint_deleted', () => { refreshSprints() }),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [activeSession?.id, wsOn, refreshMessages, refreshSessions, refreshStats, refreshIssues, refreshAutonomous, refreshSprints])

  // Fallback polling — slower interval (30s) since WebSocket handles most updates
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStats()
      refreshSessions()
      if (activeSession?.id) refreshMessages()
      if (view === 'issues') { refreshIssues(); refreshAutonomous() }
    }, 30000)
    return () => clearInterval(interval)
  }, [activeSession?.id, view])

  const handleSelectSession = useCallback((session) => {
    setActiveSession(session)
    setIsNewSession(false)
    setSelectedModel(session.model || 'claude-opus-4-7')
    if (session?.id) navigate(`/s/${session.id}`)
  }, [navigate])

  const handleNewSession = useCallback(() => {
    setActiveSession(null)
    setIsNewSession(true)
    setSelectedModel('claude-opus-4-7')
    navigate('/')
  }, [navigate])

  const _startSession = useCallback(async (text, model, imageTokens = [], sprintId = null, type = null, labels = []) => {
    const result = await startSession(text, model, imageTokens, sprintId, type, labels)
    if (result.sessionId) {
      const newSession = {
        id: result.sessionId,
        task: text,
        model: model || 'claude-opus-4-7',
        status: 'running',
        is_mine: true,
        sprint_id: sprintId,
        type,
        labels,
      }
      setActiveSession(newSession)
      setIsNewSession(false)
      setSelectedModel(model || 'claude-opus-4-7')
      navigate(`/s/${result.sessionId}`)
      setTimeout(() => {
        refreshSessions()
        refreshStats()
        refreshMessages()
      }, 1500)
    }
  }, [navigate])
  const [handleStartSession, startingSession] = useAction(_startSession)

  const _sendMessage = useCallback(async (text, model, imageTokens = []) => {
    if (!activeSession?.id) return
    await sendMessage(activeSession.id, text, imageTokens)
    setTimeout(() => refreshMessages(), 1000)
  }, [activeSession?.id])
  const [handleSendMessage, sendingMessage] = useAction(_sendMessage)

  const handleAdvanceStage = useCallback(async (toStage) => {
    if (!activeSession?.id) return
    const result = await apiFetch(`/api/sessions/${activeSession.id}/advance-stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStage, model: selectedModel }),
    })
    refreshSessions()
    if (result?.sessionId && result.sessionId !== activeSession.id) {
      const spawned = {
        id: result.sessionId,
        task: `[${toStage}] ${activeSession.task || ''}`.trim(),
        model: selectedModel || activeSession.model || 'claude-opus-4-7',
        status: 'running',
        stage: toStage,
        is_mine: true,
      }
      setActiveSession(spawned)
      setIsNewSession(false)
      navigate(`/s/${result.sessionId}`)
      setTimeout(() => { refreshSessions(); refreshMessages() }, 1500)
    } else {
      setActiveSession(prev => prev ? { ...prev, stage: toStage } : prev)
    }
  }, [activeSession?.id, activeSession?.task, activeSession?.model, selectedModel, refreshSessions, refreshMessages, navigate])

  const _forkSession = useCallback(async (text, model) => {
    if (!activeSession?.id) return
    const result = await forkSession(activeSession.id, text, model)
    if (result.sessionId) {
      const newSession = {
        id: result.sessionId,
        task: text,
        model: model || activeSession.model || 'claude-opus-4-7',
        status: 'running',
        is_mine: true,
      }
      setActiveSession(newSession)
      setIsNewSession(false)
      navigate(`/s/${result.sessionId}`)
      setTimeout(() => {
        refreshSessions()
        refreshStats()
        refreshMessages()
      }, 1500)
    }
  }, [activeSession?.id, activeSession?.model, navigate])
  const [handleForkSession, forkingSession] = useAction(_forkSession)

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
    if (panel === 'learnings') {
      setLearningsLoading(true)
      try {
        const data = await getLearnings()
        setLearningsContent(data.content || '')
      } catch (e) { }
      setLearningsLoading(false)
    }
    if (panel === 'settings') {
      try {
        const data = await getAdminSettings()
        setAdminSettings(data || {})
      } catch (e) { }
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

  const handleSaveLearnings = useCallback(async (content) => {
    setLearningsLoading(true)
    try {
      await saveLearnings(content)
      setLearningsContent(content)
    } catch (e) { }
    setLearningsLoading(false)
  }, [])

  // Early returns AFTER all hooks
  if (loading) return <div className="h-screen flex items-center justify-center bg-bg text-text-secondary font-mono text-sm">Loading...</div>
  if (!user) return <Login />

  const hasAccess = activeSession ? (activeSession.is_mine || activeSession.has_access || user?.isAdmin) : true

  return (
    <div className="flex bg-bg font-sans overflow-hidden" style={{ height: '100dvh' }}>
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSession?.id}
        onSelectSession={(s) => { handleSelectSession(s); setView('chat') }}
        onNewSession={() => { handleNewSession(); setView('chat') }}
        stats={stats}
        user={user}
        onLogout={logout}
        onShowAdmin={handleShowAdmin}
        onLoadMore={() => setPage(p => Math.min(p + 1, totalPages || 1))}
        hasMore={page < (totalPages || 1)}
        pendingRequestsCount={requests?.length || 0}
        view={view}
        onViewChange={setView}
        issueCount={issues.length}
        showAllSessions={showAllSessions}
        onToggleBookmark={async (sessionId) => {
          await toggleBookmark(sessionId)
          refreshSessions()
        }}
        onShareSession={(s) => setShareSessionId(s.id)}
        onForkSession={(s) => {
          handleSelectSession(s)
          setView('chat')
          navigate(`/s/${s.id}`)
          setForkTriggerId(s.id)
        }}
      />
      <div className="flex-1 min-w-0 min-h-0 h-full overflow-hidden">
        {view === 'pipeline' ? (
          <Pipeline
            onGoToSession={(sessionId) => {
              const found = sessions.find(s => s.id === sessionId)
              if (found) handleSelectSession(found)
              else { setActiveSession({ id: sessionId }); setIsNewSession(false); navigate(`/s/${sessionId}`) }
              setView('chat')
            }}
            onOpenIssue={() => setView('issues')}
            onBack={() => setView('chat')}
          />
        ) : view === 'issues' ? (
          <IssuesBoard
            issues={issues}
            onCreateIssue={createIssue}
            onUpdateIssue={updateIssue}
            onDeleteIssue={deleteIssue}
            onUploadFile={uploadFile}
            autonomousStatus={autonomousStatus}
            onStartAutonomous={(issueIds) => startAutonomous('claude-opus-4-7', issueIds)}
            onStopAutonomous={stopAutonomous}
            onToggleSelfDecisions={toggleSelfDecisions}
            sessions={sessions}
            userRole={user?.role || 'developer'}
            userId={user?.id}
            members={members}
            sprints={sprints}
            onCreateSprint={createSprint}
            onUpdateSprint={updateSprint}
            onDeleteSprint={deleteSprint}
            onGoToSession={(sessionId) => {
              const found = sessions.find(s => s.id === sessionId)
              if (found) {
                handleSelectSession(found)
              } else {
                setActiveSession({ id: sessionId })
                setIsNewSession(false)
                navigate(`/s/${sessionId}`)
              }
              setView('chat')
            }}
            onGetChangelog={getSprintChangelog}
            onRequestIssueSummary={requestIssueSummary}
            onGetIssueLastResponse={getIssueLastResponse}
            onGetStagePrompt={getStagePrompt}
            onAdvanceStage={async (issueId, payload) => {
              const result = await advanceStage(issueId, payload)
              if (result?.sessionId) {
                setActiveSession({ id: result.sessionId })
                setIsNewSession(false)
                setView('chat')
                navigate(`/s/${result.sessionId}`)
                setTimeout(() => { refreshSessions(); refreshMessages(); refreshIssues(); }, 500)
              }
              return result
            }}
            onGenerateChangelog={async (sprintId, summaries) => {
              const result = await generateSprintChangelog(sprintId, summaries)
              if (result?.sessionId) {
                // Navigate to the new changelog session
                setActiveSession({ id: result.sessionId })
                setIsNewSession(false)
                setView('chat')
                navigate(`/s/${result.sessionId}`)
                // Refresh to hydrate full session data
                setTimeout(() => {
                  refreshSessions()
                  refreshMessages()
                  refreshIssues()
                }, 1000)
              }
              return result
            }}
          />
        ) : (
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
            busy={startingSession || sendingMessage || stoppingSession || forkingSession}
            onForkSession={handleForkSession}
            onAdvanceStage={handleAdvanceStage}
            sprints={sprints}
            typing={wsTyping?.sessionId === activeSession?.id}
            wsConnected={wsConnected}
            forkTriggerId={forkTriggerId}
            onForkTriggerConsumed={() => setForkTriggerId(null)}
          />
        )}
      </div>

      {shareSessionId && (
        <ShareSessionModal
          sessionId={shareSessionId}
          onClose={() => setShareSessionId(null)}
        />
      )}

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
      {adminPanel === 'learnings' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Learnings (Self-Improving Knowledge)">
          <LearningsPanel content={learningsContent} onSave={handleSaveLearnings} loading={learningsLoading} />
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
      {adminPanel === 'settings' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Settings">
          <SettingsPanel settings={adminSettings} onSave={async (key, value) => {
            await saveAdminSetting(key, value)
            setAdminSettings(prev => ({ ...prev, [key]: value }))
            if (key === 'show_all_sessions') refreshSessions()
          }} />
        </AdminModal>
      )}

      {/* Assignment notification toast */}
      {notification && (
        <div
          className="fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 text-sm animate-in slide-in-from-bottom cursor-pointer max-w-sm"
          style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-accent)', color: 'var(--c-text)' }}
          onClick={() => { setView('issues'); setNotification(null) }}
        >
          <span className="text-lg">
            {notification.type === 'bug' ? '\uD83D\uDC1B' : notification.type === 'feature' ? '\uD83D\uDCA1' : '\uD83D\uDCCB'}
          </span>
          <span>{notification.message}</span>
          <button onClick={(e) => { e.stopPropagation(); setNotification(null) }} className="ml-2 opacity-50 hover:opacity-100 cursor-pointer text-xs">&times;</button>
        </div>
      )}
    </div>
  )
}

const ROUTER_BASENAME = window.location.pathname.startsWith('/sessions') ? '/sessions' : '/'

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter basename={ROUTER_BASENAME}>
          <Routes>
            <Route path="/share/:token" element={<SharePage />} />
            <Route path="/s/:id" element={<Dashboard />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
