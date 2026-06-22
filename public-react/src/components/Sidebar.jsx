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
  Hash,
  MessageSquare,
  Star,
  Sun,
  Moon,
  CircleDot,
  BookOpen,
  GitBranch,
  GitMerge,
  ClipboardList,
  MoreHorizontal,
  Share2,
  Copy,
  Check,
  Cpu,
  Search,
  X,
  Pencil,
  Bot,
  Trash2,
  Code2,
  Palette,
  FlaskConical,
  ListMusic,
  FolderPlus,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { usePlaylists, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist } from '../hooks/useApi';

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

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function SessionMenu({ session, onClose, onShare, onFork, onMerge, onAddToSprint, onToggleBookmark, onRename, onDelete, playlists = [], isInPlaylist, onTogglePlaylistItem }) {
  const [showPlaylists, setShowPlaylists] = useState(false);
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState(session.name || '');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const renameInputRef = useRef(null);

  const doDelete = async (e) => {
    e?.stopPropagation();
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(session.id);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  useEffect(() => {
    if (renaming) {
      const t = setTimeout(() => renameInputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [renaming]);

  const copyId = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(session.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const submitRename = async (e) => {
    e?.stopPropagation();
    if (!onRename || saving) return;
    setSaving(true);
    try {
      await onRename(session.id, nameValue.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const itemStyle = {
    color: 'var(--c-text)',
  };

  if (renaming) {
    return (
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        className="absolute right-2 top-8 z-20 w-64 rounded border p-2 shadow-lg"
        style={{ backgroundColor: 'var(--c-surface)', borderColor: 'var(--c-border)' }}
      >
        <label className="block text-[10px] uppercase tracking-wide mb-1.5" style={{ color: 'var(--c-text-secondary)' }}>
          Rename session
        </label>
        <input
          ref={renameInputRef}
          type="text"
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename(e);
            else if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          }}
          maxLength={120}
          placeholder="Session name"
          className="w-full px-2 py-1.5 text-sm outline-none rounded"
          style={{
            backgroundColor: 'var(--c-bg)',
            border: '1px solid var(--c-border)',
            color: 'var(--c-text)',
          }}
        />
        <div className="flex justify-end gap-1.5 mt-2">
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="px-2 py-1 text-xs rounded cursor-pointer"
            style={{ color: 'var(--c-text-secondary)' }}
          >
            Cancel
          </button>
          <button
            onClick={submitRename}
            disabled={saving}
            className="px-2.5 py-1 text-xs rounded text-white cursor-pointer disabled:opacity-50"
            style={{ backgroundColor: 'var(--c-accent)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-2 top-8 z-20 w-52 rounded border py-1 shadow-lg"
      style={{ backgroundColor: 'var(--c-surface)', borderColor: 'var(--c-border)' }}
    >
      {/* Model info — read-only */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-xs"
        style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}
      >
        <Cpu size={12} />
        <span className="font-mono truncate" title={session.model}>
          {session.model || 'unknown'}
        </span>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <Pencil size={14} style={{ color: 'var(--c-text-secondary)' }} />
        Rename
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); onShare?.(session); onClose(); }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <Share2 size={14} style={{ color: 'var(--c-text-secondary)' }} />
        Share
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); onFork?.(session); onClose(); }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <GitBranch size={14} style={{ color: 'var(--c-text-secondary)' }} />
        Fork session
      </button>

      {onMerge && (
        <button
          onClick={(e) => { e.stopPropagation(); onMerge?.(session); onClose(); }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
          style={itemStyle}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <GitMerge size={14} style={{ color: 'var(--c-text-secondary)' }} />
          Merge with…
        </button>
      )}

      {onAddToSprint && (
        <button
          onClick={(e) => { e.stopPropagation(); onAddToSprint?.(session); onClose(); }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
          style={itemStyle}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <ClipboardList size={14} style={{ color: 'var(--c-text-secondary)' }} />
          Add to sprint…
        </button>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); onToggleBookmark?.(session.id); onClose(); }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <Star
          size={14}
          style={{ color: session.bookmarked ? 'var(--c-accent)' : 'var(--c-text-secondary)' }}
          fill={session.bookmarked ? 'var(--c-accent)' : 'none'}
        />
        {session.bookmarked ? 'Remove bookmark' : 'Bookmark'}
      </button>

      {onTogglePlaylistItem && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setShowPlaylists((v) => !v); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
            style={itemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <ListMusic size={14} style={{ color: 'var(--c-text-secondary)' }} />
            Add to playlist
          </button>
          {showPlaylists && (
            <div style={{ borderTop: '1px solid var(--c-border)', borderBottom: '1px solid var(--c-border)', maxHeight: 180, overflowY: 'auto' }}>
              {(playlists || []).length === 0 && (
                <div className="px-3 py-1.5 text-xs" style={{ color: 'var(--c-text-muted)' }}>No playlists yet</div>
              )}
              {(playlists || []).map((pl) => (
                <button
                  key={pl.id}
                  onClick={(e) => { e.stopPropagation(); onTogglePlaylistItem(pl, session.id); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
                  style={itemStyle}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <span style={{ width: 14, display: 'inline-flex' }}>{isInPlaylist?.(pl, session.id) ? <Check size={13} style={{ color: 'var(--c-accent)' }} /> : null}</span>
                  <span className="truncate">{pl.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <button
        onClick={copyId}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        {copied
          ? <Check size={14} style={{ color: 'var(--c-status-running)' }} />
          : <Copy size={14} style={{ color: 'var(--c-text-secondary)' }} />
        }
        {copied ? 'Copied' : 'Copy session ID'}
      </button>

      {onDelete && (
        <div style={{ borderTop: '1px solid var(--c-border)' }}>
          {!confirmDelete ? (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
              style={{ color: '#ef4444' }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--c-surface-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Trash2 size={14} style={{ color: '#ef4444' }} />
              Delete session
            </button>
          ) : (
            <div className="px-3 py-2">
              <p className="text-xs mb-2" style={{ color: 'var(--c-text-secondary)' }}>
                Delete this session and all its messages? This can't be undone.
              </p>
              <div className="flex gap-1.5">
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  className="flex-1 px-2 py-1 text-xs rounded cursor-pointer"
                  style={{ color: 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={doDelete}
                  disabled={deleting}
                  className="flex-1 px-2 py-1 text-xs rounded text-white cursor-pointer disabled:opacity-50"
                  style={{ backgroundColor: '#ef4444' }}
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionItem({ session, isActive, onSelect, billingMode = 'api', onToggleBookmark, onShareSession, onForkSession, onMergeSession, onAddToSprintSession, onRenameSession, onDeleteSession, playlists = [], isInPlaylist, onTogglePlaylistItem }) {
  const ownerLabel = session.owner_name || session.owner_email || null;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      onClick={() => onSelect(session)}
      className="relative w-full text-left px-3 py-2.5 transition-colors duration-150 cursor-pointer group"
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
          <div
            className="truncate text-sm font-medium pr-12"
            style={{ color: 'var(--c-text)' }}
            title={session.task || session.name || ''}
          >
            {session.name || session.task || 'Untitled'}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="font-mono text-xs" style={{ color: 'var(--c-text-muted)' }}>
              {session.id}
            </span>
            {ownerLabel && (
              <span
                className="truncate text-[10px] max-w-[80px]"
                style={{ color: 'var(--c-text-secondary)' }}
                title={ownerLabel}
              >
                {ownerLabel}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            {session.mode === 'design' && (
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 uppercase"
                style={{
                  fontSize: '10px',
                  backgroundColor: 'color-mix(in srgb, var(--c-accent) 18%, transparent)',
                  border: '1px solid var(--c-accent)',
                  color: 'var(--c-accent)',
                }}
                title="Design-mode session"
              >
                <Palette size={10} /> Design
              </span>
            )}
            {session.mode === 'tester' && (
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 uppercase"
                style={{
                  fontSize: '10px',
                  backgroundColor: 'color-mix(in srgb, var(--c-accent) 18%, transparent)',
                  border: '1px solid var(--c-accent)',
                  color: 'var(--c-accent)',
                }}
                title="Tester-mode session"
              >
                <FlaskConical size={10} /> Tester
              </span>
            )}
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
            {billingMode === 'api' ? (
              session.cost_usd != null && (
                <span className="font-mono text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  ${Number(session.cost_usd).toFixed(2)}
                </span>
              )
            ) : (
              (session.input_tokens > 0 || session.output_tokens > 0) && (
                <span className="font-mono text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  {formatTokens((session.input_tokens || 0) + (session.output_tokens || 0))} tok
                </span>
              )
            )}
          </div>
        </div>
      </div>

      {/* Top-right icons: bookmark star + 3-dots menu */}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        {session.bookmarked && (
          <span
            onClick={(e) => { e.stopPropagation(); onToggleBookmark?.(session.id); }}
            className="cursor-pointer"
            title="Remove bookmark"
          >
            <Star size={13} style={{ color: 'var(--c-accent)' }} fill="var(--c-accent)" />
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          className="p-1 rounded cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--c-text-secondary)' }}
          title="More options"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      {menuOpen && (
        <SessionMenu
          session={session}
          onClose={() => setMenuOpen(false)}
          onShare={onShareSession}
          onFork={onForkSession}
          onMerge={onMergeSession}
          onAddToSprint={onAddToSprintSession}
          onToggleBookmark={onToggleBookmark}
          onRename={onRenameSession}
          onDelete={onDeleteSession}
          playlists={playlists}
          isInPlaylist={isInPlaylist}
          onTogglePlaylistItem={onTogglePlaylistItem}
        />
      )}
    </div>
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
    { key: 'learnings', label: 'Learnings', icon: BookOpen },
    { key: 'cron', label: 'Cron', icon: Clock },
    { key: 'requests', label: 'Requests', icon: MessageSquare, badge: pendingRequestsCount },
    { key: 'settings', label: 'Settings', icon: Settings },
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
  showAllSessions = false,
  onToggleBookmark,
  onShareSession,
  onForkSession,
  onMergeSession,
  onAddToSprintSession,
  onRenameSession,
  onDeleteSession,
  workMode = 'developer',
  onChangeWorkMode,
  searchQuery = '',
  onSearchChange,
}) {
  const [adminOpen, setAdminOpen] = useState(false);
  const [sessionFilter, setSessionFilter] = useState('all'); // 'all' | 'mine' | 'saved' | 'pl:<id>'
  const { theme, toggle } = useTheme();

  // Playlists — personal session groupings.
  const { playlists, refresh: refreshPlaylists } = usePlaylists();
  const activePlaylist = sessionFilter.startsWith('pl:') ? (playlists || []).find(p => p.id === sessionFilter.slice(3)) : null;
  const isInPlaylist = (pl, sessionId) => (pl.session_ids || []).includes(sessionId);
  const doCreatePlaylist = async () => {
    const name = window.prompt('New playlist name')?.trim();
    if (!name) return;
    const pl = await createPlaylist(name);
    await refreshPlaylists();
    if (pl?.id) setSessionFilter('pl:' + pl.id);
  };
  const doRenamePlaylist = async (pl) => {
    const name = window.prompt('Rename playlist', pl.name)?.trim();
    if (!name || name === pl.name) return;
    await renamePlaylist(pl.id, name); refreshPlaylists();
  };
  const doDeletePlaylist = async (pl) => {
    if (!window.confirm(`Delete playlist "${pl.name}"? (sessions are not deleted)`)) return;
    await deletePlaylist(pl.id);
    if (sessionFilter === 'pl:' + pl.id) setSessionFilter('all');
    refreshPlaylists();
  };
  const onTogglePlaylistItem = async (pl, sessionId) => {
    if (isInPlaylist(pl, sessionId)) await removeFromPlaylist(pl.id, sessionId);
    else await addToPlaylist(pl.id, sessionId);
    refreshPlaylists();
  };

  const filteredSessions = sessionFilter === 'mine'
    ? (sessions || []).filter((s) => s.is_mine)
    : sessionFilter === 'saved'
    ? (sessions || []).filter((s) => s.bookmarked)
    : activePlaylist
    ? (sessions || []).filter((s) => isInPlaylist(activePlaylist, s.id))
    : (sessions || []);

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

      {/* Work mode is now driven by the user's role (Settings → Users), not a manual toggle. */}

      {/* Stats bar */}
      {stats && (
        <div
          className="flex items-center gap-3 px-4 py-2 font-mono text-xs"
          style={{ color: 'var(--c-text-secondary)', borderBottom: '1px solid var(--c-border)' }}
        >
          {stats.billingMode === 'cli' ? (
            <span className="flex items-center gap-1" title={`In: ${formatTokens(stats.totalInputTokens || 0)} / Out: ${formatTokens(stats.totalOutputTokens || 0)}`}>
              <Hash size={12} />
              {formatTokens((stats.totalInputTokens || 0) + (stats.totalOutputTokens || 0))} tok
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <DollarSign size={12} />
              {Number(stats.totalCost || 0).toFixed(2)}
            </span>
          )}
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
          onClick={() => onViewChange?.('sprint')}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: view === 'sprint' ? 'var(--c-surface-2)' : 'transparent',
            color: view === 'sprint' ? 'var(--c-text)' : 'var(--c-text-secondary)',
          }}
        >
          <GitBranch size={12} />
          Sprint
          {issueCount > 0 && (
            <span
              className="text-[10px] font-mono px-1 py-0 rounded"
              style={{ backgroundColor: 'var(--c-surface-3)', color: 'var(--c-text-muted)' }}
            >
              {issueCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onViewChange?.('agents')}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: view === 'agents' ? 'var(--c-surface-2)' : 'transparent',
            color: view === 'agents' ? 'var(--c-text)' : 'var(--c-text-secondary)',
          }}
        >
          <Bot size={12} />
          Agents
        </button>
        <button
          onClick={() => onViewChange?.('cost')}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-medium cursor-pointer transition-colors"
          style={{
            backgroundColor: view === 'cost' ? 'var(--c-surface-2)' : 'transparent',
            color: view === 'cost' ? 'var(--c-text)' : 'var(--c-text-secondary)',
          }}
        >
          <DollarSign size={12} />
          Cost
        </button>
      </div>

      {/* Search sessions */}
      {view === 'chat' && onSearchChange && (
        <div
          className="px-3 py-2"
          style={{ borderBottom: '1px solid var(--c-border)' }}
        >
          <div
            className="relative flex items-center"
            style={{
              backgroundColor: 'var(--c-surface)',
              border: '1px solid var(--c-border)',
              borderRadius: 6,
            }}
          >
            <Search
              size={13}
              className="ml-2 shrink-0"
              style={{ color: 'var(--c-text-muted)' }}
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search sessions…"
              className="w-full bg-transparent outline-none px-2 py-1.5 text-sm"
              style={{ color: 'var(--c-text)' }}
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                className="mr-1 p-1 rounded cursor-pointer"
                style={{ color: 'var(--c-text-muted)' }}
                title="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Session filter: All / Mine — only shown when all sessions are visible */}
      {view === 'chat' && (
        <div
          className="flex px-3 py-1.5 gap-1"
          style={{ borderBottom: '1px solid var(--c-border)' }}
        >
          {[
            { key: 'all', label: `All (${(sessions || []).length})` },
            ...(showAllSessions ? [{ key: 'mine', label: `Mine (${(sessions || []).filter(s => s.is_mine).length})` }] : []),
            { key: 'saved', label: `Saved (${(sessions || []).filter(s => s.bookmarked).length})` },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSessionFilter(key)}
              className="text-[10px] font-mono uppercase px-2 py-1 rounded cursor-pointer transition-colors"
              style={{
                backgroundColor: sessionFilter === key ? 'var(--c-surface-2)' : 'transparent',
                color: sessionFilter === key ? 'var(--c-text)' : 'var(--c-text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Playlists — personal session groupings */}
      {view === 'chat' && (
        <div className="flex items-center gap-1 flex-wrap px-3 py-1.5" style={{ borderBottom: '1px solid var(--c-border)' }}>
          <span className="flex items-center gap-1 text-[10px] font-mono uppercase mr-0.5" style={{ color: 'var(--c-text-muted)' }}>
            <ListMusic size={11} /> Lists
          </span>
          {(playlists || []).map(pl => {
            const active = sessionFilter === 'pl:' + pl.id;
            return (
              <button key={pl.id}
                onClick={() => setSessionFilter(active ? 'all' : 'pl:' + pl.id)}
                onDoubleClick={() => doRenamePlaylist(pl)}
                title="Click to filter · double-click to rename"
                className="text-[10px] font-medium rounded-full px-2 py-0.5 cursor-pointer transition-colors flex items-center gap-1"
                style={{ backgroundColor: active ? 'var(--c-accent)' : 'var(--c-surface-2)', color: active ? '#fff' : 'var(--c-text-secondary)', border: '1px solid var(--c-border)' }}>
                {pl.name} <span style={{ opacity: 0.7 }}>{(pl.session_ids || []).length}</span>
                {active && <X size={10} onClick={(e) => { e.stopPropagation(); doDeletePlaylist(pl); }} />}
              </button>
            );
          })}
          <button onClick={doCreatePlaylist} title="New playlist"
            className="text-[10px] rounded-full px-1.5 py-0.5 cursor-pointer flex items-center gap-0.5"
            style={{ color: 'var(--c-accent)', border: '1px dashed var(--c-border)' }}>
            <FolderPlus size={11} /> New
          </button>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {filteredSessions.length > 0 ? (
          <>
            {filteredSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={onSelectSession}
                billingMode={stats?.billingMode || 'api'}
                onToggleBookmark={onToggleBookmark}
                onShareSession={onShareSession}
                onForkSession={onForkSession}
                onMergeSession={onMergeSession}
                onAddToSprintSession={onAddToSprintSession}
                onRenameSession={onRenameSession}
                onDeleteSession={onDeleteSession}
                playlists={playlists}
                isInPlaylist={isInPlaylist}
                onTogglePlaylistItem={onTogglePlaylistItem}
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
            {sessionFilter === 'mine' ? 'No sessions by you yet' : sessionFilter === 'saved' ? 'No saved sessions yet' : activePlaylist ? 'This playlist is empty — add sessions from the ⋯ menu.' : 'No sessions yet'}
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
          <div className="relative h-full w-72" onClick={(e) => e.stopPropagation()}>
            <SidebarContent
              {...props}
              onSelectSession={(session) => {
                props.onSelectSession(session);
                setMobileOpen(false);
              }}
              onViewChange={(v) => {
                props.onViewChange?.(v);
                setMobileOpen(false);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
