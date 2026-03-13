import { useState, useRef, useEffect } from 'react';
import {
  Plus,
  Menu,
  LogOut,
  Settings,
  Users,
  Phone,
  FileText,
  Clock,
  ChevronDown,
  Activity,
  DollarSign,
  MessageSquare,
  Sun,
  Moon,
  CircleDot,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

const STATUS_COLORS = {
  running: 'var(--c-status-running)',
  completed: 'var(--c-status-completed)',
  failed: 'var(--c-status-failed)',
  stopped: 'var(--c-text-muted)',
};

function StatusDot({ status }) {
  const color = STATUS_COLORS[status] || 'var(--c-text-muted)';
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {status === 'running' && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

function SessionItem({ session, isActive, onSelect }) {
  return (
    <button
      onClick={() => onSelect(session)}
      className="w-full text-left px-3 py-2.5 transition-colors duration-150 cursor-pointer"
      style={{
        backgroundColor: isActive ? 'var(--c-surface-2)' : 'transparent',
        borderLeft: isActive ? '2px solid var(--c-accent)' : '2px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'var(--c-surface)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <div className="flex items-start gap-2">
        <StatusDot status={session.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
            {session.task || 'Untitled'}
          </div>
          <div className="mt-0.5 font-mono text-xs" style={{ color: 'var(--c-text-muted)' }}>
            {session.id}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="inline-block rounded px-1.5 py-0.5 font-mono uppercase"
              style={{
                fontSize: '10px',
                backgroundColor: 'var(--c-surface-3)',
                border: '1px solid var(--c-border)',
                color: 'var(--c-text-secondary)',
              }}
            >
              {session.model || 'unknown'}
            </span>
            {session.cost_usd != null && (
              <span className="font-mono text-xs" style={{ color: 'var(--c-text-muted)' }}>
                ${Number(session.cost_usd).toFixed(2)}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function AdminDropdown({ onShowAdmin, onClose, pendingRequestsCount = 0 }) {
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const items = [
    { key: 'users', label: 'Users', icon: Users },
    { key: 'phones', label: 'Phones', icon: Phone },
    { key: 'prompts', label: 'Prompts', icon: FileText },
    { key: 'cron', label: 'Cron', icon: Clock },
    { key: 'requests', label: 'Requests', icon: MessageSquare, badge: pendingRequestsCount },
  ];

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-40 rounded border py-1"
      style={{ backgroundColor: 'var(--c-surface)', borderColor: 'var(--c-border)' }}
    >
      {items.map(({ key, label, icon: Icon, badge }) => (
        <button
          key={key}
          onClick={() => {
            onShowAdmin(key);
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors duration-150 cursor-pointer"
          style={{ color: 'var(--c-text)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <Icon size={14} style={{ color: 'var(--c-text-secondary)' }} />
          {label}
          {badge > 0 && (
            <span
              className="ml-auto text-[10px] font-mono font-bold rounded-full px-1.5 py-0.5 leading-none"
              style={{ backgroundColor: 'var(--c-danger, #ef4444)', color: '#fff' }}
            >
              {badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SidebarContent({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  stats,
  user,
  onLogout,
  onShowAdmin,
  onLoadMore,
  hasMore,
  pendingRequestsCount = 0,
  view = 'chat',
  onViewChange,
  issueCount = 0,
}) {
  const [adminOpen, setAdminOpen] = useState(false);
  const { theme, toggle } = useTheme();

  return (
    <div
      className="flex h-full w-72 flex-col"
      style={{ backgroundColor: 'var(--c-bg)', borderRight: '1px solid var(--c-border)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--c-border)' }}
      >
        <span className="font-mono text-lg font-bold" style={{ color: 'var(--c-text)' }}>
          OliBot
        </span>
        <button
          onClick={onNewSession}
          className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-white transition-colors duration-150 cursor-pointer"
          style={{ backgroundColor: 'var(--c-accent)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-accent-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-accent)')}
        >
          <Plus size={14} />
          New Task
        </button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div
          className="flex items-center gap-3 px-4 py-2 font-mono text-xs"
          style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}
        >
          <span className="flex items-center gap-1">
            <DollarSign size={12} />
            {Number(stats.totalCost || 0).toFixed(2)}
          </span>
          <span className="flex items-center gap-1">
            <Activity size={12} />
            {stats.activeCount || 0}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare size={12} />
            {stats.totalSessions || 0}
          </span>
        </div>
      )}

      {/* Nav tabs */}
      <div
        className="flex px-2 py-1.5 gap-1"
        style={{ borderBottom: '1px solid var(--c-border)' }}
      >
        <button
          onClick={() => onViewChange?.('chat')}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: view === 'chat' ? 'var(--c-surface-2)' : 'transparent',
            color: view === 'chat' ? 'var(--c-text)' : 'var(--c-text-secondary)',
          }}
        >
          <MessageSquare size={12} />
          Sessions
        </button>
        <button
          onClick={() => onViewChange?.('issues')}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: view === 'issues' ? 'var(--c-surface-2)' : 'transparent',
            color: view === 'issues' ? 'var(--c-text)' : 'var(--c-text-secondary)',
          }}
        >
          <CircleDot size={12} />
          Issues
          {issueCount > 0 && (
            <span
              className="text-[10px] font-mono px-1 py-0 rounded"
              style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text-muted)' }}
            >
              {issueCount}
            </span>
          )}
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions && sessions.length > 0 ? (
          <>
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={onSelectSession}
              />
            ))}
            {hasMore && (
              <button
                onClick={onLoadMore}
                className="w-full py-2 text-center font-mono text-xs transition-colors duration-150 cursor-pointer"
                style={{ color: 'var(--c-text-secondary)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--c-text)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--c-text-secondary)')}
              >
                Load more
              </button>
            )}
          </>
        ) : (
          <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--c-text-muted)' }}>
            No sessions yet
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className="relative px-4 py-3"
        style={{ borderTop: '1px solid var(--c-border)' }}
      >
        {adminOpen && (
          <AdminDropdown
            onShowAdmin={onShowAdmin}
            onClose={() => setAdminOpen(false)}
            pendingRequestsCount={pendingRequestsCount}
          />
        )}
        <div className="flex items-center gap-3">
          {/* Avatar */}
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--c-surface-3)' }}
          >
            {user?.displayName?.[0]?.toUpperCase() || '?'}
          </div>

          {/* Name + role */}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
              {user?.displayName || 'User'}
            </div>
            <div className="truncate text-xs" style={{ color: 'var(--c-text-secondary)' }}>
              {user?.role || 'user'}
            </div>
          </div>

          {/* Admin gear */}
          {user?.isAdmin && (
            <button
              onClick={() => setAdminOpen((v) => !v)}
              className="relative p-1 transition-colors duration-150 cursor-pointer"
              style={{ color: 'var(--c-text-secondary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--c-text)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--c-text-secondary)')}
            >
              <Settings size={16} />
              {pendingRequestsCount > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: 'var(--c-danger, #ef4444)' }}
                />
              )}
            </button>
          )}

          {/* Theme toggle */}
          <button
            onClick={toggle}
            className="p-1 transition-colors duration-150 cursor-pointer"
            style={{ color: 'var(--c-text-secondary)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--c-text)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--c-text-secondary)')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          {/* Logout */}
          <button
            onClick={onLogout}
            className="p-1 transition-colors duration-150 cursor-pointer"
            style={{ color: 'var(--c-text-secondary)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--c-text)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--c-text-secondary)')}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar(props) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-40 rounded p-2 md:hidden cursor-pointer"
        style={{ backgroundColor: 'var(--c-surface-2)', color: 'var(--c-text)' }}
      >
        <Menu size={20} />
      </button>

      {/* Desktop sidebar */}
      <div className="hidden h-full md:block">
        <SidebarContent {...props} />
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0"
            style={{ backgroundColor: 'var(--c-overlay)' }}
            onClick={() => setMobileOpen(false)}
          />
          {/* Sidebar */}
          <div className="relative h-full" onClick={(e) => e.stopPropagation()}>
            <SidebarContent
              {...props}
              onSelectSession={(session) => {
                props.onSelectSession(session);
                setMobileOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
