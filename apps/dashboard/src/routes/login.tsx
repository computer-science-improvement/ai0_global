import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { authApi, type TelegramLoginPayload } from '../api/auth';
import { TG_BOT_USERNAME, AUTH_MODE } from '../lib/env';
import { useAuth } from '../auth/use-auth';

export const Route = createFileRoute('/login')({ component: LoginPage });

declare global { interface Window { onTelegramAuth: (u: TelegramLoginPayload) => void; } }

function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const widgetRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitToken = async (value: string) => {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    try {
      await authApi.tokenLogin(t);
      await refresh();
      await navigate({ to: '/' as any });
    } catch {
      setError('Invalid token');
    } finally {
      setBusy(false);
    }
  };

  // Telegram Login Widget (telegram mode only).
  useEffect(() => {
    if (AUTH_MODE !== 'telegram' || !widgetRef.current) return;
    window.onTelegramAuth = async (user) => {
      try {
        await authApi.telegramLogin(user);
        await refresh();
        await navigate({ to: '/channels' as any });
      } catch (e: unknown) {
        alert(`Login failed: ${(e as Error).message}`);
      }
    };
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', TG_BOT_USERNAME);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.setAttribute('data-request-access', 'write');
    widgetRef.current.appendChild(s);
  }, [navigate, refresh]);

  // "Authorization link" — /login?token=… auto-submits in token mode so a
  // bookmarked link signs you straight in.
  useEffect(() => {
    if (AUTH_MODE !== 'token') return;
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) void submitToken(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card-featured" style={{ maxWidth: 400, width: '100%', padding: 32 }}>
        <h1 className="text-display-md" style={{ marginBottom: 8 }}>Channel Tracker</h1>

        {AUTH_MODE === 'telegram' && (
          <>
            <p style={{ marginBottom: 24, fontSize: 15, color: 'var(--color-ink-muted)' }}>
              Sign in with Telegram to continue.
            </p>
            <div ref={widgetRef} />
          </>
        )}

        {AUTH_MODE === 'token' && (
          <>
            <p style={{ marginBottom: 20, fontSize: 15, color: 'var(--color-ink-muted)' }}>
              Enter your access token to continue.
            </p>
            <form
              onSubmit={(e) => { e.preventDefault(); void submitToken(token); }}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <input
                type="password"
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Access token"
                className="input-field"
                style={{ width: '100%' }}
                autoComplete="off"
              />
              <button type="submit" disabled={busy || !token.trim()} className="btn-primary" style={{ width: '100%' }}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
            </form>
            {error && (
              <p style={{ marginTop: 12, fontSize: 13, color: 'var(--color-danger)' }}>{error}</p>
            )}
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--color-ink-dim)' }}>
              The token is checked against <code>TRACKING_TOKEN</code> on the server and stored in the session (cookie).
            </p>
          </>
        )}

        {AUTH_MODE === 'dev' && (
          <>
            <p style={{ marginBottom: 24, fontSize: 15, color: 'var(--color-ink-muted)' }}>
              Dev mode — authorization disabled.
            </p>
            <button
              className="btn-primary"
              style={{ width: '100%' }}
              onClick={async () => { await refresh(); await navigate({ to: '/' as any }); }}
            >
              Continue in dev mode
            </button>
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--color-ink-dim)' }}>
              Set <code>VITE_AUTH_MODE=token</code> (+ <code>TRACKING_TOKEN</code>) for token login, or
              {' '}<code>VITE_TG_BOT_USERNAME</code> for Telegram sign-in.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
