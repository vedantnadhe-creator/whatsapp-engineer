import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Plus,
  Play,
  Square,
  Circle,
  CheckCircle2,
  HelpCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Trash2,
  ArrowLeft,
  Zap,
  GripVertical,
  Tag,
  X,
  Paperclip,
} from 'lucide-react';

// SQLite CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' without timezone.
// Append 'Z' so the browser treats it as UTC, then toLocale* converts to local.
function parseUTC(ts) {
  if (!ts) return null;
  const s = String(ts);
  return new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
}

const colors = {
  bg: 'var(--c-bg)',
  surface: 'var(--c-surface)',
  surface2: 'var(--c-surface-2)',
  surface3: 'var(--c-surface-3)',
  border: 'var(--c-border)',
  text: 'var(--c-text)',
  textSecondary: 'var(--c-text-secondary)',
  accent: 'var(--c-accent)',
};

const STATUS_CONFIG = {
  todo: { label: 'Todo', icon: Circle, color: '#6b7280' },
  in_progress: { label: 'In Progress', icon: AlertCircle, color: '#f59e0b' },
  completed: { label: 'Done', icon: CheckCircle2, color: '#22c55e' },
  question: { label: 'Question', icon: HelpCircle, color: '#8b5cf6' },
};

const PRIORITY_CONFIG = {
  urgent: { label: 'Urgent', color: '#ef4444', weight: 0 },
  high: { label: 'High', color: '#f97316', weight: 1 },
  medium: { label: 'Medium', color: '#eab308', weight: 2 },
  low: { label: 'Low', color: '#6b7280', weight: 3 },
};

const STATUS_ORDER = ['todo', 'in_progress', 'completed', 'question'];

function StatusIcon({ status, size = 14 }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.todo;
  const Icon = config.icon;
  return <Icon size={size} style={{ color: config.color }} />;
}

function PriorityDot({ priority }) {
  const config = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.medium;
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ backgroundColor: config.color }}
      title={config.label}
    />
  );
}

function IssueRow({ issue, onSelect, onStatusChange, onGoToSession, selected, onToggleSelect }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 cursor-pointer group transition-colors duration-150"
      style={{ borderBottom: `1px solid ${colors.border}` }}
      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = colors.surface2}
      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
      onClick={() => onSelect(issue)}
    >
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(issue.id); }}
          onClick={(e) => e.stopPropagation()}
          className="flex-shrink-0 w-3.5 h-3.5 rounded cursor-pointer accent-[var(--c-accent)]"
        />
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          const idx = STATUS_ORDER.indexOf(issue.status);
          const next = STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
          onStatusChange(issue.id, next);
        }}
        className="flex-shrink-0 cursor-pointer hover:scale-110 transition-transform"
        title={`Status: ${STATUS_CONFIG[issue.status]?.label}`}
      >
        <StatusIcon status={issue.status} size={16} />
      </button>

      <span
        className="font-mono text-[10px] flex-shrink-0 select-none"
        style={{ color: colors.textSecondary, minWidth: '72px' }}
      >
        {issue.id}
      </span>

      <span
        className="text-sm flex-1 min-w-0 truncate"
        style={{ color: colors.text }}
      >
        {issue.title}
      </span>

      <PriorityDot priority={issue.priority} />

      {issue.labels && JSON.parse(issue.labels || '[]').length > 0 && (
        <div className="flex gap-1 flex-shrink-0">
          {JSON.parse(issue.labels).slice(0, 2).map((label, i) => (
            <span
              key={i}
              className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}
            >
              {label}
            </span>
          ))}
        </div>
      )}

      {issue.session_id && (
        <button
          onClick={(e) => { e.stopPropagation(); onGoToSession?.(issue.session_id); }}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
          style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
          title="Go to session"
        >
          {issue.session_id}
        </button>
      )}

      <div className="relative flex-shrink-0" ref={menuRef}>
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <MoreHorizontal size={14} style={{ color: colors.textSecondary }} />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 py-1 rounded-lg shadow-lg z-50 min-w-[120px]"
            style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
          >
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                onClick={(e) => { e.stopPropagation(); onStatusChange(issue.id, s); setMenuOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 cursor-pointer hover:opacity-80"
                style={{ color: colors.text }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = colors.surface2}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                <StatusIcon status={s} size={12} />
                {STATUS_CONFIG[s].label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilePreview({ file, previewUrl, isImage, onRemove }) {
  return (
    <div
      className="relative flex-shrink-0 rounded-lg overflow-hidden group"
      style={{ border: `1px solid ${colors.border}`, backgroundColor: colors.surface2 }}
    >
      {isImage ? (
        <img src={previewUrl} alt={file.name} className="h-14 w-14 object-cover" />
      ) : (
        <div className="h-14 w-14 flex flex-col items-center justify-center p-1">
          <Paperclip size={16} style={{ color: colors.textSecondary }} />
          <span className="text-[8px] mt-0.5 truncate max-w-full text-center px-0.5" style={{ color: colors.textSecondary }}>
            {file.name.length > 10 ? file.name.slice(0, 8) + '...' : file.name}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 p-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      >
        <X size={8} className="text-white" />
      </button>
    </div>
  );
}

function CreateIssueForm({ onSubmit, onCancel, onUploadFile }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [labelInput, setLabelInput] = useState('');
  const [labels, setLabels] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  const addFiles = useCallback((files) => {
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [...prev, { file, previewUrl, isImage }]);
    }
  }, []);

  const removeAttachment = useCallback((index) => {
    setAttachments((prev) => {
      const item = prev[index];
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  const handleFileSelect = (e) => {
    if (e.target.files?.length) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      // Upload attachments and collect URLs
      let desc = description.trim();
      const uploadedFiles = [];
      if (attachments.length > 0 && onUploadFile) {
        const results = await Promise.allSettled(
          attachments.map(async (att) => {
            const result = await onUploadFile(att.file);
            if (result?.url) {
              return { name: att.file.name, url: result.url, isImage: att.isImage };
            }
            return null;
          })
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) uploadedFiles.push(r.value);
        }
        if (uploadedFiles.length > 0) {
          const lines = uploadedFiles.map((f) =>
            f.isImage ? `![${f.name}](${f.url})` : `[${f.name}](${f.url})`
          );
          desc = (desc ? desc + '\n\n' : '') + lines.join('\n');
        }
      }
      await onSubmit({ title: title.trim(), description: desc, priority, labels });
      // Cleanup
      attachments.forEach((att) => { if (att.previewUrl) URL.revokeObjectURL(att.previewUrl); });
      setTitle('');
      setDescription('');
      setPriority('medium');
      setLabels([]);
      setAttachments([]);
    } finally {
      setSubmitting(false);
    }
  };

  const addLabel = () => {
    const l = labelInput.trim();
    if (l && !labels.includes(l)) setLabels([...labels, l]);
    setLabelInput('');
  };

  return (
    <form onSubmit={handleSubmit} className="p-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Issue title"
        className="w-full text-sm font-medium bg-transparent outline-none mb-2"
        style={{ color: colors.text }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onPaste={handlePaste}
        placeholder="Add description... (paste images here)"
        rows={3}
        className="w-full text-sm bg-transparent outline-none resize-none mb-3"
        style={{ color: colors.textSecondary }}
      />

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
          {attachments.map((att, i) => (
            <FilePreview
              key={i}
              file={att.file}
              previewUrl={att.previewUrl}
              isImage={att.isImage}
              onRemove={() => removeAttachment(i)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="text-xs px-2 py-1 rounded outline-none cursor-pointer font-mono"
          style={{ backgroundColor: colors.surface2, color: colors.textSecondary, border: `1px solid ${colors.border}` }}
        >
          {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        {/* File upload button */}
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-xs px-2 py-1 rounded cursor-pointer flex items-center gap-1"
          style={{ backgroundColor: colors.surface2, color: colors.textSecondary, border: `1px solid ${colors.border}` }}
          title="Attach files"
        >
          <Paperclip size={10} />
          Attach
        </button>

        <div className="flex items-center gap-1">
          <input
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
            placeholder="Add label"
            className="text-xs px-2 py-1 rounded outline-none w-20"
            style={{ backgroundColor: colors.surface2, color: colors.textSecondary, border: `1px solid ${colors.border}` }}
          />
          <button
            type="button"
            onClick={addLabel}
            className="text-xs px-1.5 py-1 rounded cursor-pointer"
            style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}
          >
            <Tag size={10} />
          </button>
        </div>
        {labels.map((l, i) => (
          <span
            key={i}
            className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
            style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}
          >
            {l}
            <button
              type="button"
              onClick={() => setLabels(labels.filter((_, j) => j !== i))}
              className="cursor-pointer hover:opacity-80"
            >
              <X size={8} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!title.trim() || submitting}
          className="text-xs px-3 py-1.5 rounded-md font-medium text-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: colors.accent }}
        >
          {submitting ? 'Creating...' : 'Create Issue'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md cursor-pointer"
          style={{ color: colors.textSecondary }}
        >
          Cancel
        </button>
        {attachments.length > 0 && (
          <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
            {attachments.length} file{attachments.length > 1 ? 's' : ''} attached
          </span>
        )}
      </div>
    </form>
  );
}

// Render description with inline images and file links
function renderDescription(text) {
  // Split by markdown image/link patterns: ![name](url) or [name](url)
  const parts = text.split(/(!\[[^\]]*\]\([^)]+\)|\[[^\]]*\]\([^)]+\))/g);
  return parts.map((part, i) => {
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      return (
        <img
          key={i}
          src={imgMatch[2]}
          alt={imgMatch[1]}
          className="max-w-full rounded-lg my-2"
          style={{ maxHeight: 300, border: `1px solid ${colors.border}` }}
        />
      );
    }
    const linkMatch = part.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={i}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono px-2 py-1 rounded inline-flex items-center gap-1 my-1"
          style={{ backgroundColor: colors.surface2, color: colors.accent, border: `1px solid ${colors.border}` }}
          onClick={(e) => e.stopPropagation()}
        >
          <Paperclip size={10} />
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function IssueDetail({ issue, onBack, onUpdate, onDelete, onGoToSession }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description || '');
  const [priority, setPriority] = useState(issue.priority);

  const handleSave = () => {
    onUpdate(issue.id, { title, description, priority });
    setEditing(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div
        className="h-12 flex items-center gap-3 px-4 flex-shrink-0"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <button
          onClick={onBack}
          className="p-1 rounded cursor-pointer hover:opacity-80"
        >
          <ArrowLeft size={16} style={{ color: colors.textSecondary }} />
        </button>
        <span className="font-mono text-xs" style={{ color: colors.textSecondary }}>
          {issue.id}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => { if (confirm('Delete this issue?')) { onDelete(issue.id); onBack(); } }}
          className="p-1 rounded cursor-pointer hover:opacity-80"
          title="Delete issue"
        >
          <Trash2 size={14} style={{ color: '#ef4444' }} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {editing ? (
          <div className="space-y-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-lg font-semibold bg-transparent outline-none"
              style={{ color: colors.text }}
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={8}
              className="w-full text-sm bg-transparent outline-none resize-none"
              style={{ color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12 }}
            />
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                className="text-xs px-3 py-1.5 rounded-md font-medium text-white cursor-pointer"
                style={{ backgroundColor: colors.accent }}
              >
                Save
              </button>
              <button
                onClick={() => { setTitle(issue.title); setDescription(issue.description || ''); setEditing(false); }}
                className="text-xs px-3 py-1.5 rounded-md cursor-pointer"
                style={{ color: colors.textSecondary }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <h1
              className="text-lg font-semibold cursor-pointer"
              style={{ color: colors.text }}
              onClick={() => setEditing(true)}
            >
              {issue.title}
            </h1>
            <div
              className="text-sm whitespace-pre-wrap cursor-pointer"
              style={{ color: issue.description ? colors.text : colors.textSecondary }}
              onClick={() => setEditing(true)}
            >
              {issue.description ? renderDescription(issue.description) : 'Click to add a description...'}
            </div>
          </div>
        )}

        <div className="mt-8 space-y-3">
          <div className="flex items-center gap-4">
            <span className="text-xs font-mono w-20" style={{ color: colors.textSecondary }}>Status</span>
            <div className="flex gap-1">
              {STATUS_ORDER.map((s) => {
                const cfg = STATUS_CONFIG[s];
                const active = issue.status === s;
                return (
                  <button
                    key={s}
                    onClick={() => onUpdate(issue.id, { status: s })}
                    className="text-xs px-2 py-1 rounded-md flex items-center gap-1.5 cursor-pointer transition-colors"
                    style={{
                      backgroundColor: active ? `${cfg.color}20` : 'transparent',
                      color: active ? cfg.color : colors.textSecondary,
                      border: `1px solid ${active ? cfg.color : colors.border}`,
                    }}
                  >
                    <StatusIcon status={s} size={10} />
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-xs font-mono w-20" style={{ color: colors.textSecondary }}>Priority</span>
            <select
              value={issue.priority}
              onChange={(e) => onUpdate(issue.id, { priority: e.target.value })}
              className="text-xs px-2 py-1 rounded outline-none cursor-pointer font-mono"
              style={{ backgroundColor: colors.surface2, color: colors.textSecondary, border: `1px solid ${colors.border}` }}
            >
              {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>

          {issue.session_id && (
            <div className="flex items-center gap-4">
              <span className="text-xs font-mono w-20" style={{ color: colors.textSecondary }}>Session</span>
              <button
                onClick={() => onGoToSession?.(issue.session_id)}
                className="text-xs font-mono px-2 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity"
                style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
                title="Go to session"
              >
                {issue.session_id}
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            <span className="text-xs font-mono w-20" style={{ color: colors.textSecondary }}>Created</span>
            <span className="text-xs" style={{ color: colors.textSecondary }}>
              {parseUTC(issue.created_at)?.toLocaleString() || ''}
            </span>
          </div>

          {issue.creator_name && (
            <div className="flex items-center gap-4">
              <span className="text-xs font-mono w-20" style={{ color: colors.textSecondary }}>Creator</span>
              <span className="text-xs" style={{ color: colors.textSecondary }}>
                {issue.creator_name}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function IssuesBoard({
  issues = [],
  onCreateIssue,
  onUpdateIssue,
  onDeleteIssue,
  onUploadFile,
  autonomousStatus,
  onStartAutonomous,
  onStopAutonomous,
  onGoToSession,
  onBack,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'board'
  const [filterStatus, setFilterStatus] = useState('all');
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());

  const isAutoRunning = autonomousStatus?.running;

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const toggleGroup = (status) => {
    setCollapsedGroups((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  const handleCreate = async (data) => {
    await onCreateIssue(data);
    setShowCreate(false);
  };

  const handleStatusChange = (id, status) => {
    onUpdateIssue(id, { status });
    if (selectedIssue?.id === id) {
      setSelectedIssue({ ...selectedIssue, status });
    }
  };

  const filteredIssues = filterStatus === 'all'
    ? issues
    : issues.filter((i) => i.status === filterStatus);

  const grouped = STATUS_ORDER.reduce((acc, s) => {
    acc[s] = filteredIssues.filter((i) => i.status === s);
    return acc;
  }, {});

  // If viewing a specific issue detail
  if (selectedIssue) {
    const fresh = issues.find((i) => i.id === selectedIssue.id) || selectedIssue;
    return (
      <div className="flex flex-col h-full" style={{ backgroundColor: colors.bg }}>
        <IssueDetail
          issue={fresh}
          onBack={() => setSelectedIssue(null)}
          onUpdate={(id, updates) => { onUpdateIssue(id, updates); }}
          onDelete={onDeleteIssue}
          onGoToSession={onGoToSession}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: colors.bg }}>
      {/* Header — wraps to two rows on mobile */}
      <div
        className="flex flex-wrap items-center gap-2 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        {onBack && (
          <button onClick={onBack} className="p-1 rounded cursor-pointer hover:opacity-80">
            <ArrowLeft size={16} style={{ color: colors.textSecondary }} />
          </button>
        )}
        <h2 className="text-sm font-semibold" style={{ color: colors.text }}>
          Issues
        </h2>
        <span
          className="text-xs font-mono px-1.5 py-0.5 rounded"
          style={{ backgroundColor: colors.surface2, color: colors.textSecondary }}
        >
          {issues.length}
        </span>
        <div className="flex-1 min-w-[20px]" />

        {/* View toggle — always visible */}
        <div
          className="flex rounded-md overflow-hidden flex-shrink-0"
          style={{ border: `1px solid ${colors.border}` }}
        >
          {['list', 'board'].map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className="text-[11px] font-mono uppercase px-3 py-1.5 cursor-pointer transition-colors"
              style={{
                backgroundColor: viewMode === mode ? colors.surface2 : 'transparent',
                color: viewMode === mode ? colors.text : colors.textSecondary,
              }}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Selection actions */}
        {selectedIds.size > 0 && !isAutoRunning && (
          <>
            <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>
              {selectedIds.size} selected
            </span>
            <button
              onClick={() => { onStartAutonomous([...selectedIds]); clearSelection(); }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer text-white flex-shrink-0"
              style={{ backgroundColor: '#22c55e' }}
            >
              <Play size={12} />
              <span className="hidden sm:inline">Run Selected</span>
              <span className="sm:hidden">Run</span>
            </button>
            <button
              onClick={clearSelection}
              className="text-xs px-2 py-1.5 rounded-md cursor-pointer flex-shrink-0"
              style={{ color: colors.textSecondary }}
              title="Clear selection"
            >
              <X size={12} />
            </button>
          </>
        )}

        {/* Autonomous run button */}
        {isAutoRunning ? (
          <button
            onClick={onStopAutonomous}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer text-white flex-shrink-0"
            style={{ backgroundColor: '#ef4444' }}
          >
            <Square size={12} fill="white" />
            <span className="hidden sm:inline">Stop Run</span>
            <span className="sm:hidden">Stop</span>
          </button>
        ) : selectedIds.size === 0 && (
          <button
            onClick={() => onStartAutonomous()}
            disabled={grouped.todo.length === 0}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer text-white disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            style={{ backgroundColor: '#22c55e' }}
          >
            <Zap size={12} />
            <span className="hidden sm:inline">Run All</span>
            <span className="sm:hidden">Run</span>
          </button>
        )}

        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md font-medium cursor-pointer text-white flex-shrink-0"
          style={{ backgroundColor: colors.accent }}
        >
          <Plus size={12} />
          <span className="hidden sm:inline">New Issue</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* Auto-runner status bar */}
      {isAutoRunning && (
        <div
          className="px-4 py-2 flex items-center gap-2 text-xs"
          style={{ backgroundColor: 'rgba(34,197,94,0.08)', borderBottom: `1px solid ${colors.border}` }}
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span style={{ color: '#22c55e' }} className="font-medium">Autonomous mode active</span>
          {autonomousStatus?.currentIssueId && (
            <span style={{ color: colors.textSecondary }} className="font-mono">
              Working on {autonomousStatus.currentIssueId}
            </span>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div
        className="flex items-center gap-1 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <button
          onClick={() => setFilterStatus('all')}
          className="text-xs px-2.5 py-1 rounded-md cursor-pointer transition-colors"
          style={{
            backgroundColor: filterStatus === 'all' ? colors.surface2 : 'transparent',
            color: filterStatus === 'all' ? colors.text : colors.textSecondary,
          }}
        >
          All ({issues.length})
        </button>
        {STATUS_ORDER.map((s) => {
          const cfg = STATUS_CONFIG[s];
          const count = issues.filter((i) => i.status === s).length;
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className="text-xs px-2.5 py-1 rounded-md cursor-pointer flex items-center gap-1.5 transition-colors"
              style={{
                backgroundColor: filterStatus === s ? `${cfg.color}15` : 'transparent',
                color: filterStatus === s ? cfg.color : colors.textSecondary,
              }}
            >
              <StatusIcon status={s} size={10} />
              {cfg.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Create form */}
      {showCreate && (
        <CreateIssueForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
          onUploadFile={onUploadFile}
        />
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {viewMode === 'list' ? (
          /* ── List View ── */
          filterStatus === 'all' ? (
            STATUS_ORDER.map((s) => {
              const items = grouped[s];
              if (items.length === 0) return null;
              const cfg = STATUS_CONFIG[s];
              const collapsed = collapsedGroups[s];
              return (
                <div key={s}>
                  <button
                    onClick={() => toggleGroup(s)}
                    className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium cursor-pointer"
                    style={{ backgroundColor: colors.surface2, color: colors.textSecondary }}
                  >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <StatusIcon status={s} size={12} />
                    {cfg.label}
                    <span className="font-mono ml-1">({items.length})</span>
                  </button>
                  {!collapsed && items.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      onSelect={setSelectedIssue}
                      onStatusChange={handleStatusChange}
                      onGoToSession={onGoToSession}
                      selected={selectedIds.has(issue.id)}
                      onToggleSelect={toggleSelect}
                    />
                  ))}
                </div>
              );
            })
          ) : (
            filteredIssues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                onSelect={setSelectedIssue}
                onStatusChange={handleStatusChange}
                onGoToSession={onGoToSession}
                selected={selectedIds.has(issue.id)}
                onToggleSelect={toggleSelect}
              />
            ))
          )
        ) : (
          /* ── Board View (Kanban) ── */
          <div className="flex gap-0 h-full overflow-x-auto">
            {STATUS_ORDER.map((s) => {
              const items = grouped[s];
              const cfg = STATUS_CONFIG[s];
              return (
                <div
                  key={s}
                  className="flex-1 min-w-[220px] flex flex-col h-full"
                  style={{ borderRight: `1px solid ${colors.border}` }}
                >
                  <div
                    className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0"
                    style={{ borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.surface2 }}
                  >
                    <StatusIcon status={s} size={12} />
                    <span className="text-xs font-medium" style={{ color: colors.text }}>
                      {cfg.label}
                    </span>
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: colors.surface3, color: colors.textSecondary }}
                    >
                      {items.length}
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                    {items.map((issue) => (
                      <div
                        key={issue.id}
                        onClick={() => setSelectedIssue(issue)}
                        className="p-3 rounded-lg cursor-pointer group transition-colors duration-150"
                        style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
                        onMouseEnter={(e) => e.currentTarget.style.borderColor = colors.accent}
                        onMouseLeave={(e) => e.currentTarget.style.borderColor = colors.border}
                      >
                        <div className="flex items-start gap-2 mb-1.5">
                          <span
                            className="font-mono text-[9px] flex-shrink-0 mt-0.5"
                            style={{ color: colors.textSecondary }}
                          >
                            {issue.id}
                          </span>
                          <PriorityDot priority={issue.priority} />
                        </div>
                        <p className="text-xs font-medium leading-snug mb-1.5" style={{ color: colors.text }}>
                          {issue.title}
                        </p>
                        {issue.session_id && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onGoToSession?.(issue.session_id); }}
                            className="text-[9px] font-mono px-1 py-0.5 rounded inline-block cursor-pointer hover:opacity-80 transition-opacity"
                            style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: '#22c55e' }}
                            title="Go to session"
                          >
                            {issue.session_id}
                          </button>
                        )}
                      </div>
                    ))}
                    {items.length === 0 && (
                      <p className="text-xs text-center py-6" style={{ color: colors.textSecondary }}>
                        No issues
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {filteredIssues.length === 0 && !showCreate && viewMode === 'list' && (
          <div className="flex flex-col items-center justify-center h-full py-20">
            <Circle size={32} style={{ color: colors.textSecondary }} className="mb-3 opacity-30" />
            <p className="text-sm" style={{ color: colors.textSecondary }}>
              No issues yet
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="mt-3 text-xs px-3 py-1.5 rounded-md cursor-pointer"
              style={{ color: colors.accent }}
            >
              Create your first issue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
