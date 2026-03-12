import { useState, useRef, useEffect } from 'react';
import {
  Plus,
  Menu,
  X,
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
} from 'lucide-react';

const STATUS_COLORS = {
  running: '#22c55e',
  completed: '#3b82f6',
  failed: '#ef4444',
  stopped: '#555555',
};

function StatusDot({ status }) {
  const color = STATUS_COLORS[status] || '#555555';
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
        backgroundColor: isActive ? '#111111' : 'transparent',
        borderLeft: isActive ? '2px solid #3b82f6' : '2px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = '#0a0a0a';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <div className="flex items-start gap-2">
        <StatusDot status={session.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" style={{ color: '#e5e5e5' }}>
            {session.task || 'Untitled'}
          </div>
          <div className="mt-0.5 font-mono text-xs" style={{ color: '#555555' }}>
            {session.id}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="inline-block rounded px-1.5 py-0.5 font-mono uppercase"
              style={{
                fontSize: '10px',
                backgroundColor: '#1a1a1a',
                border: '1px solid #222222',
                color: '#888888',
              }}
            >
              {session.model || 'unknown'}
            </span>
            {session.cost_usd != null && (
              <span className="font-mono text-xs" style={{ color: '#555555' }}>
                ${Number(session.cost_usd).toFixed(2)}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function AdminDropdown({ onShowAdmin, onClose }) {
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
  ];

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-40 rounded border py-1"
      style={{ backgroundColor: '#0a0a0a', borderColor: '#222222' }}
    >
      {items.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => {
            onShowAdmin(key);
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors duration-150 cursor-pointer"
          style={{ color: '#e5e5e5' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#111111')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <Icon size={14} style={{ color: '#888888' }} />
          {label}
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
}) {
  const [adminOpen, setAdminOpen] = useState(false);

  return (
    <div
      className="flex h-full w-72 flex-col"
      style={{ backgroundColor: '#000000', borderRight: '1px solid #222222' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid #222222' }}
      >
        <span className="font-mono text-lg font-bold" style={{ color: '#e5e5e5' }}>
          OliBot
        </span>
        <button
          onClick={onNewSession}
          className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-white transition-colors duration-150 cursor-pointer"
          style={{ backgroundColor: '#3b82f6' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2563eb')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#3b82f6')}
        >
          <Plus size={14} />
          New Task
        </button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div
          className="flex items-center gap-3 px-4 py-2 font-mono text-xs"
          style={{ color: '#888888', borderBottom: '1px solid #222222' }}
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
                style={{ color: '#888888' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#e5e5e5')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#888888')}
              >
                Load more
              </button>
            )}
          </>
        ) : (
          <div className="px-4 py-8 text-center text-sm" style={{ color: '#555555' }}>
            No sessions yet
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className="relative px-4 py-3"
        style={{ borderTop: '1px solid #222222' }}
      >
        {adminOpen && (
          <AdminDropdown
            onShowAdmin={onShowAdmin}
            onClose={() => setAdminOpen(false)}
          />
        )}
        <div className="flex items-center gap-3">
          {/* Avatar */}
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
            style={{ backgroundColor: '#1a1a1a' }}
          >
            {user?.displayName?.[0]?.toUpperCase() || '?'}
          </div>

          {/* Name + role */}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" style={{ color: '#e5e5e5' }}>
              {user?.displayName || 'User'}
            </div>
            <div className="truncate text-xs" style={{ color: '#888888' }}>
              {user?.role || 'user'}
            </div>
          </div>

          {/* Admin gear */}
          {user?.isAdmin && (
            <button
              onClick={() => setAdminOpen((v) => !v)}
              className="p-1 transition-colors duration-150 cursor-pointer"
              style={{ color: '#888888' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#e5e5e5')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#888888')}
            >
              <Settings size={16} />
            </button>
          )}

          {/* Logout */}
          <button
            onClick={onLogout}
            className="p-1 transition-colors duration-150 cursor-pointer"
            style={{ color: '#888888' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#e5e5e5')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#888888')}
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
        style={{ backgroundColor: '#111111', color: '#e5e5e5' }}
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
            style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}
            onClick={() => setMobileOpen(false)}
          />
          {/* Sidebar */}
          <div className="relative h-full">
            <SidebarContent {...props} />
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 p-1 cursor-pointer"
              style={{ color: '#888888' }}
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
