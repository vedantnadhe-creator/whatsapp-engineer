import { useState, useEffect, useCallback } from 'react'
import { BrowserRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import SharePage from './pages/SharePage'
import TerminalPage from './pages/TerminalPage'
import { useSessions, useStats, useCostStats, useSessionMessages, useModels, usePhones, useUsers, useCron, useAccessRequests, useIssues, useAutonomous, useSprints, useTeamMembers, useAction, useAgents, runAgent, startSession, sendMessage, stopSession, forkSession, testForkSession, mergeSessions, toggleBookmark, updateSessionSprint, getSprintChangelog, requestIssueSummary, getIssueLastResponse, generateSprintChangelog, uploadFile, transcribeAudio, requestAccess, getClaudePrompt, saveClaudePrompt, getLearnings, saveLearnings, getAdminSettings, saveAdminSetting, renameSession, deleteSession, sessionToIssue, apiFetch } from './hooks/useApi'
import useWebSocket from './hooks/useWebSocket'
import Sidebar from './components/Sidebar'
import Workspace from './components/Workspace'
import SprintBoard from './components/SprintBoard'
import AgentsView from './components/AgentsView'
import CostView from './components/CostView'
import Login from './pages/Login'
import ShareSessionModal from './components/ShareSessionModal'
import MergeDialog from './components/MergeDialog'
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
  const [selectedModel, setSelectedModel] = useState('claude-opus-4-8')
  const [claudePrompt, setClaudePrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(false)
  const [learningsContent, setLearningsContent] = useState('')
  const [learningsLoading, setLearningsLoading] = useState(false)
  const [adminSettings, setAdminSettings] = useState({})
  const [view, setView] = useState('chat') // 'chat' or 'issues'
  const [notification, setNotification] = useState(null)
  const [authError, setAuthError] = useState(false)
  const [shareSessionId, setShareSessionId] = useState(null)
  const [forkTriggerId, setForkTriggerId] = useState(null)
  const [addToSprintSession, setAddToSprintSession] = useState(null)
  const [sessionSearch, setSessionSearch] = useState('')
  // Work mode is driven by the user's ROLE (set in Settings → Users), not a manual toggle:
  // designer → design, tester → tester, everyone else → developer.
  const [workMode, setWorkMode] = useState('developer')

  const { stats, refresh: refreshStats } = useStats()
  const { cost, loading: costLoading, refresh: refreshCost } = useCostStats()
  const { sessions, total, totalPages, showAllSessions, refresh: refreshSessions } = useSessions(page, sessionSearch)
  const { messages, refresh: refreshMessages } = useSessionMessages(activeSession?.id)
  const { models } = useModels()
  const { phones, refresh: refreshPhones, addPhone, removePhone } = usePhones()
  const { users, refresh: refreshUsers, addUser, deleteUser, resetPassword, updateUser } = useUsers()
  const { jobs, refresh: refreshCron, saveJob, deleteJob } = useCron()
  const { requests, refresh: refreshRequests, resolve } = useAccessRequests()
  const { issues, refresh: refreshIssues, createIssue, updateIssue, deleteIssue, getStagePrompt, advanceStage } = useIssues()
  const { status: autonomousStatus, refresh: refreshAutonomous, start: startAutonomous, stop: stopAutonomous, toggleSelfDecisions } = useAutonomous()
  const { sprints, refresh: refreshSprints, createSprint, updateSprint, deleteSprint } = useSprints()
  const { members } = useTeamMembers()
  const { agents, refresh: refreshAgents, loading: agentsLoading } = useAgents()
  const { connected: wsConnected, typing: wsTyping, on: wsOn } = useWebSocket()

  // Work mode follows the user's role (no manual toggle).
  useEffect(() => {
    if (!user?.id) return
    const m = user.role === 'designer' ? 'design' : (user.role === 'tester' ? 'tester' : 'developer')
    setWorkMode(m)
  }, [user?.id, user?.role])

  // Sprint-only testers are locked to the Sprint board — no chat / sessions. Re-pin them
  // to the sprint view if anything (notifications, redirects) tries to navigate away.
  useEffect(() => {
    if (user?.sprintOnly && view !== 'sprint') setView('sprint')
  }, [user?.sprintOnly, view])

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
      // Claude auth errors
      wsOn('auth_error', () => { setAuthError(true) }),
      // Session deleted elsewhere
      wsOn('session_deleted', ({ sessionId }) => {
        if (activeSession?.id === sessionId) { setActiveSession(null); setIsNewSession(true); navigate('/') }
        refreshSessions()
      }),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [activeSession?.id, wsOn, refreshMessages, refreshSessions, refreshStats, refreshIssues, refreshAutonomous, refreshSprints])

  // Fallback polling — slower interval (30s) since WebSocket handles most updates
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStats()
      refreshSessions()
      if (activeSession?.id) refreshMessages()
      if (view === 'sprint') { refreshIssues() }
    }, 30000)
    return () => clearInterval(interval)
  }, [activeSession?.id, view])

  const handleSelectSession = useCallback((session) => {
    setActiveSession(session)
    setIsNewSession(false)
    setSelectedModel(session.model || 'claude-opus-4-8')
    if (session?.id) navigate(`/s/${session.id}`)
  }, [navigate])

  const handleNewSession = useCallback(() => {
    setActiveSession(null)
    setIsNewSession(true)
    setSelectedModel('claude-opus-4-8')
    navigate('/')
  }, [navigate])

  const _startSession = useCallback(async (text, model, imageTokens = [], sprintId = null, type = null, labels = [], name = null) => {
    const result = await startSession(text, model, imageTokens, sprintId, type, labels, name, workMode)
    if (result.sessionId) {
      const newSession = {
        id: result.sessionId,
        task: text,
        name: (name && name.trim()) || text.slice(0, 60),
        model: model || 'claude-opus-4-8',
        status: 'running',
        is_mine: true,
        sprint_id: sprintId,
        type,
        labels,
        mode: workMode,
      }
      setActiveSession(newSession)
      setIsNewSession(false)
      setSelectedModel(model || 'claude-opus-4-8')
      navigate(`/s/${result.sessionId}`)
      setTimeout(() => {
        refreshSessions()
        refreshStats()
        refreshMessages()
      }, 1500)
    }
  }, [navigate, workMode])
  const [handleStartSession, startingSession] = useAction(_startSession)

  const _sendMessage = useCallback(async (text, model, imageTokens = []) => {
    if (!activeSession?.id) return
    const useModel = model || selectedModel || activeSession.model || 'claude-opus-4-8'
    await sendMessage(activeSession.id, text, imageTokens, useModel)
    // Reflect the (possibly switched) model locally so the dropdown doesn't snap back.
    if (useModel !== activeSession.model) {
      setActiveSession(s => s ? { ...s, model: useModel } : s)
    }
    setSelectedModel(useModel)
    setTimeout(() => refreshMessages(), 1000)
  }, [activeSession?.id, activeSession?.model, selectedModel])
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
        model: selectedModel || activeSession.model || 'claude-opus-4-8',
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
        model: model || activeSession.model || 'claude-opus-4-8',
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

  // Tester "Test it": fork the shared session into a tester-mode session and open it.
  const _testFork = useCallback(async (text = null) => {
    if (!activeSession?.id) return
    const result = await testForkSession(activeSession.id, text)
    if (result?.sessionId) {
      setActiveSession({ id: result.sessionId, task: activeSession.task, status: 'running', mode: 'tester', is_mine: true })
      setIsNewSession(false)
      navigate(`/s/${result.sessionId}`)
      setTimeout(() => { refreshSessions(); refreshMessages() }, 1500)
    }
    return result
  }, [activeSession?.id, activeSession?.task, navigate, refreshSessions, refreshMessages])
  const [handleTestFork, testForking] = useAction(_testFork)

  // Merge: combine 2+ sessions (each compacted) into one new session.
  const [mergePrimaryId, setMergePrimaryId] = useState(null)
  const _mergeSessions = useCallback(async (ids, text) => {
    if (!Array.isArray(ids) || ids.length < 2) return
    const result = await mergeSessions(ids, text || null, null)
    if (result?.sessionId) {
      setMergePrimaryId(null)
      setActiveSession({ id: result.sessionId, task: text || 'Merged session', status: 'running', is_mine: true })
      setIsNewSession(false)
      setView('chat')
      navigate(`/s/${result.sessionId}`)
      setTimeout(() => { refreshSessions(); refreshStats(); refreshMessages() }, 1500)
    }
    return result
  }, [navigate, refreshSessions, refreshStats, refreshMessages])
  const [handleMergeSessions, merging] = useAction(_mergeSessions)

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
      {view !== 'sprint' && (
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
        onMergeSession={(s) => setMergePrimaryId(s.id)}
        onAddToSprintSession={(s) => setAddToSprintSession(s)}
        onRenameSession={async (sessionId, name) => {
          await renameSession(sessionId, name)
          if (activeSession?.id === sessionId) {
            setActiveSession((prev) => prev ? { ...prev, name: name || null } : prev)
          }
          refreshSessions()
        }}
        onDeleteSession={user?.isAdmin ? async (sessionId) => {
          await deleteSession(sessionId)
          if (activeSession?.id === sessionId) {
            setActiveSession(null)
            setIsNewSession(true)
            navigate('/')
          }
          refreshSessions()
          refreshStats()
        } : null}
        searchQuery={sessionSearch}
        onSearchChange={(v) => { setSessionSearch(v); setPage(1); }}
      />
      )}
      <div className="flex-1 min-w-0 min-h-0 h-full overflow-hidden">
        {view === 'cost' ? (
          <CostView
            cost={cost}
            loading={costLoading}
            onRefresh={refreshCost}
            onGoToSession={(sessionId) => {
              if (!sessionId) return
              const found = sessions.find(s => s.id === sessionId)
              if (found) handleSelectSession(found)
              else { setActiveSession({ id: sessionId }); setIsNewSession(false); navigate(`/s/${sessionId}`) }
              setView('chat')
            }}
          />
        ) : view === 'agents' ? (
          <AgentsView
            agents={agents}
            loading={agentsLoading}
            onRunAgent={async (agentId, note) => {
              const result = await runAgent(agentId, note)
              if (result?.sessionId) {
                setActiveSession({ id: result.sessionId })
                setIsNewSession(false)
                setView('chat')
                navigate(`/s/${result.sessionId}`)
                setTimeout(() => { refreshSessions(); refreshMessages(); refreshAgents(); }, 800)
              }
              return result
            }}
          />
        ) : view === 'sprint' ? (
          <SprintBoard
            onBack={user?.sprintOnly ? null : () => setView('chat')}
            issues={issues}
            refreshIssues={refreshIssues}
            onCreateIssue={(data) => createIssue({ mode: workMode, ...data })}
            onUpdateIssue={updateIssue}
            onDeleteIssue={deleteIssue}
            sprints={sprints}
            onCreateSprint={createSprint}
            onUpdateSprint={updateSprint}
            onDeleteSprint={deleteSprint}
            members={members}
            user={user}
            model={selectedModel}
            onGoToSession={(sessionId) => {
              if (!sessionId) return
              const found = sessions.find(s => s.id === sessionId)
              if (found) handleSelectSession(found)
              else { setActiveSession({ id: sessionId }); setIsNewSession(false); navigate(`/s/${sessionId}`) }
              setView('chat')
            }}
            onGetChangelog={getSprintChangelog}
            onRequestIssueSummary={requestIssueSummary}
            onGetIssueLastResponse={getIssueLastResponse}
            onGenerateChangelog={async (sprintId, summaries) => {
              const result = await generateSprintChangelog(sprintId, summaries)
              if (result?.sessionId) {
                setActiveSession({ id: result.sessionId })
                setIsNewSession(false)
                setView('chat')
                navigate(`/s/${result.sessionId}`)
                setTimeout(() => { refreshSessions(); refreshMessages(); refreshIssues() }, 1000)
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
            user={user}
            onTestFork={handleTestFork}
            testForking={testForking}
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

      {mergePrimaryId && (
        <MergeDialog
          sessions={sessions}
          primaryId={mergePrimaryId}
          busy={merging}
          onClose={() => setMergePrimaryId(null)}
          onMerge={handleMergeSessions}
        />
      )}

      {addToSprintSession && (
        <AddToSprintDialog
          session={addToSprintSession}
          sprints={sprints}
          issues={issues}
          onClose={() => setAddToSprintSession(null)}
          onConfirm={async ({ sprintId, parentIssueId }) => {
            await sessionToIssue(addToSprintSession.id, { sprintId, parentIssueId })
            setAddToSprintSession(null)
            refreshIssues()
          }}
        />
      )}

      {adminPanel === 'users' && (
        <AdminModal isOpen onClose={() => setAdminPanel(null)} title="Team Members">
          <UsersPanel users={users} onAdd={async (data) => { await addUser(data); refreshUsers() }} onDelete={async (id) => { await deleteUser(id); refreshUsers() }} onResetPassword={async (id) => { await resetPassword(id) }} onUpdateUser={async (id, changes) => { await updateUser(id, changes) }} />
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

      {/* Claude auth error banner */}
      {authError && (
        <div
          className="fixed top-0 left-0 right-0 z-50 px-4 py-2.5 flex items-center justify-center gap-3 text-sm"
          style={{ backgroundColor: '#dc2626', color: '#fff' }}
        >
          <span>Claude is logged out — sessions will fail. Open <strong>Settings</strong> to reconnect.</span>
          <button
            onClick={() => { setAdminPanel('settings'); setAuthError(false) }}
            className="px-3 py-1 rounded text-xs font-medium cursor-pointer"
            style={{ backgroundColor: 'rgba(255,255,255,0.2)', color: '#fff' }}
          >
            Open Settings
          </button>
          <button
            onClick={() => setAuthError(false)}
            className="ml-1 opacity-70 hover:opacity-100 cursor-pointer text-xs"
          >
            &times;
          </button>
        </div>
      )}

      {/* Assignment notification toast */}
      {notification && (
        <div
          className="fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 text-sm animate-in slide-in-from-bottom cursor-pointer max-w-sm"
          style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-accent)', color: 'var(--c-text)' }}
          onClick={() => { setView('sprint'); setNotification(null) }}
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
            <Route path="/v2" element={<TerminalPage />} />
            <Route path="/s/:id" element={<Dashboard />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}

// Add a session to the sprint board — as a standalone feature, or a subtask of an existing feature.
function AddToSprintDialog({ session, sprints, issues, onClose, onConfirm }) {
  const activeSprints = (sprints || []).filter(s => s.status !== 'completed')
  const [sprintId, setSprintId] = useState(activeSprints[0]?.id || (sprints || [])[0]?.id || '')
  const [asSubtask, setAsSubtask] = useState(false)
  const [parentIssueId, setParentIssueId] = useState('')
  const [busy, setBusy] = useState(false)

  // Top-level features in the chosen sprint, eligible to be a parent.
  const parentOptions = (issues || []).filter(i => i.category !== 'chat' && !i.parent_issue_id && i.sprint_id === sprintId)

  const confirm = async () => {
    if (asSubtask && !parentIssueId) return
    setBusy(true)
    try { await onConfirm({ sprintId: sprintId || null, parentIssueId: asSubtask ? parentIssueId : null }) }
    finally { setBusy(false) }
  }

  const card = { backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }
  const field = { backgroundColor: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl shadow-2xl overflow-hidden" style={card} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--c-text-muted)' }}>Add to sprint</div>
          <div className="text-[15px] font-semibold mt-0.5 truncate" style={{ color: 'var(--c-text)' }}>{session.name || session.task || session.id}</div>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <label className="text-[12px] font-medium" style={{ color: 'var(--c-text-secondary)' }}>Sprint</label>
          <select value={sprintId} onChange={e => { setSprintId(e.target.value); setParentIssueId('') }} className="text-[13px] rounded-lg px-3 py-2 outline-none -mt-2" style={field}>
            {(sprints || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            {(sprints || []).length === 0 && <option value="">No sprints — create one first</option>}
          </select>

          <div className="flex items-center gap-4 text-[13px]" style={{ color: 'var(--c-text)' }}>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" checked={!asSubtask} onChange={() => setAsSubtask(false)} /> Individual issue</label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" checked={asSubtask} onChange={() => setAsSubtask(true)} /> Subtask of…</label>
          </div>

          {asSubtask && (
            <select value={parentIssueId} onChange={e => setParentIssueId(e.target.value)} className="text-[13px] rounded-lg px-3 py-2 outline-none" style={field}>
              <option value="">Select parent feature…</option>
              {parentOptions.map(i => <option key={i.id} value={i.id}>{i.title}</option>)}
            </select>
          )}
          {asSubtask && parentOptions.length === 0 && <div className="text-[11px]" style={{ color: 'var(--c-text-muted)' }}>No features in this sprint to attach to.</div>}
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--c-border)' }}>
          <button onClick={onClose} className="text-[13px] px-3 py-1.5 rounded-lg cursor-pointer" style={{ color: 'var(--c-text-secondary)' }}>Cancel</button>
          <button onClick={confirm} disabled={busy || !sprintId || (asSubtask && !parentIssueId)} className="text-[13px] px-3.5 py-1.5 rounded-lg cursor-pointer font-medium disabled:opacity-40" style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}>{busy ? 'Adding…' : 'Add to sprint'}</button>
        </div>
      </div>
    </div>
  )
}
