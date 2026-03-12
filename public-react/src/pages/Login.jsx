import { useState } from 'react';
import { Terminal, Lock, Mail, ArrowRight } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Invalid credentials');
      }

      window.location.href = '/';
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#000000] px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-[#222222] bg-[#0a0a0a] p-8">
          {/* Logo */}
          <div className="flex items-center justify-center gap-2 mb-1">
            <Terminal className="h-5 w-5 text-[#3b82f6]" strokeWidth={2} />
            <span className="font-mono text-2xl font-bold text-white tracking-tight">
              OliBot
            </span>
          </div>

          {/* Subtitle */}
          <p className="text-center text-sm text-[#888888] mb-8">
            Engineering Dashboard
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div className="relative">
              <Mail
                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#555555]"
                strokeWidth={1.5}
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                required
                autoComplete="email"
                className="w-full rounded-lg border border-[#222222] bg-[#111111] py-2.5 pl-10 pr-4 text-sm text-white placeholder-[#555555] outline-none transition-colors focus:border-[#3b82f6]"
              />
            </div>

            {/* Password */}
            <div className="relative">
              <Lock
                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#555555]"
                strokeWidth={1.5}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-[#222222] bg-[#111111] py-2.5 pl-10 pr-4 text-sm text-white placeholder-[#555555] outline-none transition-colors focus:border-[#3b82f6]"
              />
            </div>

            {/* Error */}
            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#3b82f6] py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                'Signing in...'
              ) : (
                <>
                  Sign in
                  <ArrowRight className="h-4 w-4" strokeWidth={2} />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
