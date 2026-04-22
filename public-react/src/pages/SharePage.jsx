import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, Lock, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { redeemShareLink } from '../hooks/useApi';

const URL_PREFIX = window.location.pathname.startsWith('/sessions') ? '/sessions' : '';

export default function SharePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState('working');
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const next = encodeURIComponent(`${URL_PREFIX}/share/${token}`);
      navigate(`/login?next=${next}`, { replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await redeemShareLink(token);
        if (cancelled) return;
        if (result?.sessionId) {
          navigate(`/s/${result.sessionId}`, { replace: true });
        } else {
          setStatus('error');
          setError('Invalid response from server');
        }
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setError(e.message || 'Failed to redeem share link');
      }
    })();
    return () => { cancelled = true; };
  }, [token, user, authLoading, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-xl p-8 text-center" style={{ backgroundColor: 'var(--c-surface)', border: '1px solid var(--c-border)' }}>
        {status === 'working' ? (
          <>
            <Loader2 className="animate-spin mx-auto mb-3" size={24} style={{ color: 'var(--c-accent)' }} />
            <p className="text-sm" style={{ color: 'var(--c-text)' }}>Joining session…</p>
          </>
        ) : (
          <>
            <Lock className="mx-auto mb-3" size={24} style={{ color: '#ef4444' }} />
            <p className="text-sm mb-1" style={{ color: 'var(--c-text)' }}>Share link unavailable</p>
            <p className="text-xs mb-4" style={{ color: 'var(--c-text-secondary)' }}>{error}</p>
            <button
              onClick={() => navigate('/', { replace: true })}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md cursor-pointer"
              style={{ backgroundColor: 'var(--c-accent)', color: '#fff' }}
            >
              Go to dashboard <ArrowRight size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
