import { useState, useEffect, useCallback } from 'react';
import { X, Copy, Check, Trash2, Loader2, Share2, ExternalLink } from 'lucide-react';
import { createShareLink, listShareLinks, revokeShareLink } from '../hooks/useApi';

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

const URL_PREFIX = window.location.pathname.startsWith('/sessions') ? '/sessions' : '';

function shareUrl(token) {
  return `${window.location.origin}${URL_PREFIX}/share/${token}`;
}

function formatExpiry(iso) {
  if (!iso) return 'Never';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `in ${days}d ${hours}h`;
  return `in ${hours}h`;
}

function statusOf(link) {
  if (link.revoked_at) return 'revoked';
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

export default function ShareSessionModal({ sessionId, onClose }) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [copiedToken, setCopiedToken] = useState(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await listShareLinks(sessionId);
      setLinks(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(e.message || 'Failed to load share links');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await createShareLink(sessionId);
      if (result?.token) {
        const url = shareUrl(result.token);
        try { await navigator.clipboard.writeText(url); setCopiedToken(result.token); } catch (_) { /* clipboard blocked */ }
      }
      refresh();
    } catch (e) {
      setError(e.message || 'Failed to create share link');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (token) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      setCopiedToken(token);
      setTimeout(() => setCopiedToken((cur) => cur === token ? null : cur), 2000);
    } catch (_) { /* ignore */ }
  };

  const handleRevoke = async (linkId) => {
    try {
      await revokeShareLink(sessionId, linkId);
      refresh();
    } catch (e) {
      setError(e.message || 'Failed to revoke share link');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl overflow-hidden shadow-2xl"
        style={{ backgroundColor: colors.surface, border: `1px solid ${colors.border}` }}
      >
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <Share2 size={16} style={{ color: colors.accent }} />
          <h3 className="text-sm font-semibold" style={{ color: colors.text }}>Share session</h3>
          <span className="text-[10px] font-mono" style={{ color: colors.textSecondary }}>{sessionId}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded cursor-pointer hover:opacity-80">
            <X size={14} style={{ color: colors.textSecondary }} />
          </button>
        </div>

        <div className="px-4 py-3">
          <p className="text-xs mb-3" style={{ color: colors.textSecondary }}>
            Anyone signed in who opens a share link gets full access to this session for the next 7 days.
            They won't need to request access.
          </p>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium cursor-pointer disabled:opacity-50"
            style={{ backgroundColor: colors.accent, color: '#fff' }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
            Create share link
          </button>

          {error && (
            <p className="text-xs mt-2" style={{ color: '#ef4444' }}>{error}</p>
          )}
        </div>

        <div className="max-h-[50vh] overflow-y-auto" style={{ borderTop: `1px solid ${colors.border}` }}>
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-4 text-xs" style={{ color: colors.textSecondary }}>
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : links.length === 0 ? (
            <div className="px-4 py-6 text-xs text-center" style={{ color: colors.textSecondary }}>
              No share links yet. Create one to invite collaborators.
            </div>
          ) : (
            links.map((link) => {
              const status = statusOf(link);
              const url = shareUrl(link.token);
              const isActive = status === 'active';
              return (
                <div key={link.id} className="px-4 py-3 flex items-start gap-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded uppercase"
                        style={{
                          backgroundColor: isActive ? 'rgba(34,197,94,0.15)' : status === 'expired' ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                          color: isActive ? '#22c55e' : status === 'expired' ? '#f59e0b' : '#ef4444',
                        }}
                      >
                        {status}
                      </span>
                      <span className="text-[11px]" style={{ color: colors.textSecondary }}>
                        Expires {formatExpiry(link.expires_at)}
                      </span>
                      <span className="text-[11px]" style={{ color: colors.textSecondary }}>
                        · {link.used_count || 0} use{(link.used_count || 0) === 1 ? '' : 's'}
                      </span>
                      {link.creator_name && (
                        <span className="text-[11px] ml-auto" style={{ color: colors.textSecondary }}>
                          by {link.creator_name}
                        </span>
                      )}
                    </div>
                    <div
                      className="text-xs font-mono px-2 py-1.5 rounded truncate"
                      style={{ backgroundColor: colors.surface2, color: colors.text, border: `1px solid ${colors.border}` }}
                      title={url}
                    >
                      {url}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isActive && (
                      <button
                        onClick={() => handleCopy(link.token)}
                        className="p-1.5 rounded cursor-pointer hover:opacity-80"
                        style={{ backgroundColor: colors.surface2, border: `1px solid ${colors.border}` }}
                        title="Copy link"
                      >
                        {copiedToken === link.token ? <Check size={12} style={{ color: '#22c55e' }} /> : <Copy size={12} style={{ color: colors.textSecondary }} />}
                      </button>
                    )}
                    {isActive && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="p-1.5 rounded cursor-pointer hover:opacity-80 inline-flex items-center"
                        style={{ backgroundColor: colors.surface2, border: `1px solid ${colors.border}` }}
                        title="Open link"
                      >
                        <ExternalLink size={12} style={{ color: colors.textSecondary }} />
                      </a>
                    )}
                    {isActive && (
                      <button
                        onClick={() => handleRevoke(link.id)}
                        className="p-1.5 rounded cursor-pointer hover:opacity-80"
                        style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: `1px solid rgba(239,68,68,0.3)` }}
                        title="Revoke"
                      >
                        <Trash2 size={12} style={{ color: '#ef4444' }} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
