import { useState, useEffect } from 'react';
import { X, FolderGit2, FileText, Trash2, Plus, Loader2, Pencil } from 'lucide-react';
import { getProjectDoc } from '../hooks/useApi';

// Projects — shared, team-visible groupings of sessions around one piece of work.
// A project is seeded from a session (its "root"), every fork of a session in it
// joins automatically, and it carries a `project_<name>.md` context doc on disk.

const colors = {
  bg: 'var(--c-bg)',
  surface: 'var(--c-surface)',
  surface2: 'var(--c-surface-2)',
  border: 'var(--c-border)',
  text: 'var(--c-text)',
  textSecondary: 'var(--c-text-secondary)',
  textMuted: 'var(--c-text-muted)',
  accent: 'var(--c-accent)',
};

function relativeDate(value) {
  if (!value) return '';
  const then = new Date(value.includes?.('Z') || value.includes?.('+') ? value : `${value}Z`).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// The sidebar's Projects tab: one card per project, newest activity first.
export function ProjectList({ projects, onOpen, onNew, canManage, onEdit, onDelete, isSearching = false }) {
  if (!projects.length) {
    return (
      <div className="px-4 py-8 text-center text-sm" style={{ color: colors.textMuted }}>
        <FolderGit2 size={20} className="mx-auto mb-2 opacity-50" />
        {isSearching ? 'No projects match that search.' : 'No projects yet.'}
        {!isSearching && (
          <div className="mt-1 text-xs">
            Start one from a session's ⋯ menu, or with “New project” below.
          </div>
        )}
        {!isSearching && (
          <button onClick={onNew} className="mt-3 cursor-pointer text-xs font-medium" style={{ color: colors.accent }}>
            + New project
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      {projects.map((project) => (
        <div
          key={project.id}
          onClick={() => onOpen(project)}
          className="group w-full cursor-pointer px-3 py-2.5 text-left transition-colors"
          style={{ borderBottom: `1px solid ${colors.border}` }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.surface)}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <div className="flex items-start gap-2">
            <FolderGit2 size={14} className="mt-0.5 shrink-0" style={{ color: colors.accent }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" style={{ color: colors.text }} title={project.name}>
                {project.name}
              </div>
              {project.description && (
                <div className="mt-0.5 line-clamp-2 text-xs" style={{ color: colors.textSecondary }}>
                  {project.description}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2 font-mono text-[10px]" style={{ color: colors.textMuted }}>
                <span>{(project.session_ids || []).length} session{(project.session_ids || []).length === 1 ? '' : 's'}</span>
                {project.creator_name && <span className="truncate">· {project.creator_name}</span>}
                {project.updated_at && <span>· {relativeDate(project.updated_at)}</span>}
              </div>
            </div>
            {canManage?.(project) && (
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(project); }}
                  className="cursor-pointer p-1"
                  style={{ color: colors.textSecondary }}
                  title="Edit project"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(project); }}
                  className="cursor-pointer p-1"
                  style={{ color: '#ef4444' }}
                  title="Delete project (sessions are kept)"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
      <button
        onClick={onNew}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 py-2.5 text-xs font-medium"
        style={{ color: colors.accent }}
      >
        <Plus size={13} /> New project
      </button>
    </div>
  );
}

// Create / edit a project. When `sessionLabel` is set the project is being started
// from that session, which becomes its root.
export function ProjectFormModal({ project = null, sessionLabel = null, onClose, onSubmit }) {
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, description: description.trim() });
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save the project');
      setBusy(false);
    }
  };

  const field = {
    backgroundColor: colors.bg,
    border: `1px solid ${colors.border}`,
    color: colors.text,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md overflow-hidden rounded-xl shadow-2xl"
        style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: colors.textMuted }}>
              {project ? 'Edit project' : 'New project'}
            </div>
            <div className="mt-0.5 truncate text-[15px] font-semibold" style={{ color: colors.text }}>
              {sessionLabel ? `From: ${sessionLabel}` : project?.name || 'A feature, a migration, a piece of work'}
            </div>
          </div>
          <button type="button" onClick={onClose} className="cursor-pointer p-1" style={{ color: colors.textSecondary }} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="text-[12px] font-medium" style={{ color: colors.textSecondary }} htmlFor="project-name">
            Name
          </label>
          <input
            id="project-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Search service ES → Postgres"
            className="-mt-2 rounded-lg px-3 py-2 text-[13px] outline-none"
            style={field}
          />

          <label className="text-[12px] font-medium" style={{ color: colors.textSecondary }} htmlFor="project-description">
            Context <span style={{ color: colors.textMuted }}>(optional)</span>
          </label>
          <textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="What this project is, and anything the next session should know."
            className="-mt-2 resize-y rounded-lg px-3 py-2 text-[13px] outline-none"
            style={field}
          />

          {!project && (
            <p className="text-[11px] leading-relaxed" style={{ color: colors.textMuted }}>
              Creates a shared project everyone can see, plus a <code>project_&lt;name&gt;.md</code> context
              doc. Sessions forked from anything in the project join it automatically.
            </p>
          )}
          {error && <p className="text-[12px]" style={{ color: '#ef4444' }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${colors.border}` }}>
          <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px]" style={{ color: colors.textSecondary }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: colors.accent }}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {project ? 'Save' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Read-only view of the project's `project_<name>.md` — the reference point the
// sessions in the project read and update.
export function ProjectDocModal({ project, onClose }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getProjectDoc(project.id)
      .then((data) => { if (!cancelled) setDoc(data); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not read the project doc'); });
    return () => { cancelled = true; };
  }, [project.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl shadow-2xl"
        style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: colors.textMuted }}>
              <FileText size={12} /> Project context
            </div>
            <div className="mt-0.5 truncate text-[15px] font-semibold" style={{ color: colors.text }}>{project.name}</div>
            {doc?.path && (
              <div className="truncate font-mono text-[10px]" style={{ color: colors.textMuted }} title={doc.path}>{doc.path}</div>
            )}
          </div>
          <button onClick={onClose} className="cursor-pointer p-1" style={{ color: colors.textSecondary }} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">
          {error && <p className="text-[13px]" style={{ color: '#ef4444' }}>{error}</p>}
          {!error && !doc && <p className="text-[13px]" style={{ color: colors.textMuted }}>Loading…</p>}
          {doc && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed" style={{ color: colors.text }}>
              {doc.content || 'The context doc has not been written yet.'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
