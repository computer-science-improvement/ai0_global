import { createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { authApi, type TelegramLoginPayload } from '../api/auth';
import { TG_BOT_USERNAME, AUTH_MODE } from '../lib/env';
import { sessionQuery, SESSION_KEY } from '../auth/session';
import { loginRedirectTarget, parseNext } from '../auth/next';
import { isLocalHost } from '../lib/auth-mode';

interface LoginSearch { next?: string; reason?: string; token?: string }

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export const Route = createFileRoute('/login')({
  validateSearch: (s: Record<string, unknown>): LoginSearch => ({
    next: str(s.next), reason: str(s.reason), token: str(s.token),
  }),
  // Already signed in (server-confirmed) → straight to the safe `next`. A failed
  // check (server down) just shows the form.
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery).catch(() => null);
    const target = loginRedirectTarget(session, location.searchStr);
    if (target) throw redirect({ href: target, replace: true });
  },
  component: LoginPage,
});

const REASONS: Record<string, string> = {
  session_expired: 'Your session expired. Please sign in again.',
  session_revoked: 'You were signed out from another device.',
  session_legacy:  'Please sign in again after the security update.',
};

declare global { interface Window { onTelegramAuth: (u: TelegramLoginPayload) => void; } }

function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const searchStr = useLocation({ select: (l) => l.searchStr });
  const { reason } = Route.useSearch();
  const widgetRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** After a successful login: drop the cached "signed out" answer, go to `next`. */
  const enter = async () => {
    qc.removeQueries({ queryKey: SESSION_KEY });
    await navigate({ href: parseNext(searchStr), replace: true });
  };

  const submitToken = async (value: string) => {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    try {
      await authApi.tokenLogin(t);
      await enter();
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
        await enter();
      } catch (e: unknown) {
        setError(`Login failed: ${(e as Error).message}`);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Authorization link" — /login?token=… auto-submits in token mode so a
  // bookmarked link signs you straight in.
  const { token: linkToken } = Route.useSearch();
  useEffect(() => {
    if (AUTH_MODE !== 'token' || !linkToken) return;
    void submitToken(linkToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reasonText = reason ? REASONS[reason] : undefined;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card-featured" style={{ maxWidth: 400, width: '100%', padding: 32 }}>
        <h1 className="text-display-md" style={{ marginBottom: 8 }}>Channel Tracker</h1>

        {reasonText && (
          <p role="status" style={{ marginBottom: 16, fontSize: 14, color: 'var(--color-ink-muted)' }}>{reasonText}</p>
        )}

        {AUTH_MODE === 'telegram' && (
          <>
            <p style={{ marginBottom: 24, fontSize: 15, color: 'var(--color-ink-muted)' }}>
              Sign in with Telegram to continue.
            </p>
            <div ref={widgetRef} />
            {error && <p style={{ marginTop: 12, fontSize: 13, color: 'var(--color-danger)' }}>{error}</p>}
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
          </>
        )}

        {AUTH_MODE === 'dev' && (isLocalHost(window.location.hostname) ? (
          <>
            <p style={{ marginBottom: 24, fontSize: 15, color: 'var(--color-ink-muted)' }}>
              Dev mode — the backend's local no-auth bypass decides access.
            </p>
            <button className="btn-primary" style={{ width: '100%' }} onClick={() => void enter()}>
              Continue in dev mode
            </button>
          </>
        ) : <NoSignInMethodBanner />)}
      </div>
    </div>
  );
}

/**
 * A dev build (no sign-in method) served from a real host: there is nothing to
 * sign in with, so say so instead of offering a "Continue" that 401-loops.
 */
function NoSignInMethodBanner() {
  return (
    <div role="alert" style={{
      padding: '12px 14px', borderRadius: 'var(--radius-md)',
      background: 'var(--color-danger-soft)', border: '1px solid var(--color-danger)', color: 'var(--color-ink)',
    }}>
      <strong style={{ display: 'block', marginBottom: 4, color: 'var(--color-danger)' }}>This build has no sign-in method</strong>
      <span style={{ fontSize: 13, color: 'var(--color-ink-muted)' }}>
        The dashboard was built without token or Telegram sign-in. Rebuild it with a sign-in method to use it here.
      </span>
    </div>
  );
}
