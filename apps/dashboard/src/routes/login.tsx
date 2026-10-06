import { createFileRoute, redirect, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { authApi, LoginError, type TelegramLoginPayload } from '../api/auth';
import { TG_BOT_USERNAME, AUTH_MODE, TOKEN_LOGIN } from '../lib/env';
import { isLocalHost } from '../lib/auth-mode';
import { sessionQuery, SESSION_KEY } from '../auth/session';
import { loginRedirectTarget, parseNext } from '../auth/next';
import { loginErrorMessage, reasonMessage, stripTokenParam } from '../auth/messages';
import { Icon } from '../components/ui/Icon';

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

declare global { interface Window { onTelegramAuth: (u: TelegramLoginPayload) => void; } }

interface FormError { code: string; until?: number }

/** Re-render every second while a rate-limit countdown is running. */
function useCountdown(until: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : undefined;
}

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const qc = useQueryClient();
  const searchStr = useLocation({ select: (l) => l.searchStr });
  const { reason, token: linkToken } = Route.useSearch();
  const widgetRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(AUTH_MODE === 'token');
  const remaining = useCountdown(error?.until);
  const locked = remaining !== undefined && remaining > 0;

  const fail = (e: unknown) => {
    const err = e instanceof LoginError ? e : new LoginError('unknown', 0);
    setError({ code: err.code, until: err.retryAfterSec ? Date.now() + err.retryAfterSec * 1000 : undefined });
  };

  /** After a successful login: drop the cached "signed out" answer, go to `next`. */
  const enter = async () => {
    qc.removeQueries({ queryKey: SESSION_KEY });
    await navigate({ href: parseNext(searchStr), replace: true });
  };

  const submitToken = async (value: string, via: 'form' | 'link' = 'form') => {
    const t = value.trim();
    if (!t || busy) return;
    setBusy(true); setError(null);
    try {
      await authApi.tokenLogin(t, via);
      await enter();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Telegram Login Widget. Errors show inline under the widget.
  useEffect(() => {
    if (AUTH_MODE !== 'telegram' || !widgetRef.current) return;
    window.onTelegramAuth = async (user) => {
      setError(null);
      try {
        await authApi.telegramLogin(user);
        await enter();
      } catch (e) {
        fail(e);
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

  // Authorization link `/login?token=…`: take the token OUT of the address bar
  // (history.replaceState via the router's history) before submitting it, so
  // the secret never stays in history; audited as method `link`.
  useEffect(() => {
    if (!linkToken) return;
    router.history.replace(`/login${stripTokenParam(searchStr)}`);
    if (TOKEN_LOGIN) void submitToken(linkToken, 'link');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reasonText = reasonMessage(reason);
  const errorText = error ? loginErrorMessage(error.code, remaining) : null;
  const devHere = AUTH_MODE === 'dev' && isLocalHost(window.location.hostname);

  return (
    <div style={{
      display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'var(--color-canvas)',
    }}>
      <div className="card-featured compose-rise" style={{ maxWidth: 400, width: '100%', padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <img src="/favicon.svg" alt="" width={28} height={28} style={{ borderRadius: 'var(--radius-md)' }} />
          <h1 className="text-display-md" style={{ margin: 0 }}>ai0</h1>
        </div>
        <p style={{ margin: '0 0 22px', fontSize: 15, color: 'var(--color-ink-muted)' }}>Sign in to the dashboard.</p>

        {reasonText && (
          <div role="status" style={{
            display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 18, padding: '10px 12px',
            borderRadius: 'var(--radius-md)', background: 'var(--color-surface-3)', fontSize: 13, color: 'var(--color-ink)',
          }}>
            <Icon name="info" size={15} />
            <span>{reasonText}</span>
          </div>
        )}

        {AUTH_MODE === 'telegram' && <div ref={widgetRef} style={{ minHeight: 40 }} />}

        {AUTH_MODE === 'telegram' && TOKEN_LOGIN && !showToken && (
          <button
            type="button"
            className="btn-tiny"
            style={{ marginTop: 18 }}
            onClick={() => setShowToken(true)}
            aria-expanded={false}
          >
            Use access token
          </button>
        )}

        {TOKEN_LOGIN && showToken && (
          <form
            onSubmit={(e) => { e.preventDefault(); void submitToken(token); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: AUTH_MODE === 'telegram' ? 18 : 0 }}
          >
            <input
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Access token"
              aria-label="Access token"
              className="input-field"
              style={{ width: '100%' }}
              autoComplete="off"
            />
            <button type="submit" disabled={busy || locked || !token.trim()} className="btn-primary" style={{ width: '100%' }}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        )}

        {errorText && (
          <p role="alert" style={{ marginTop: 12, marginBottom: 0, fontSize: 13, color: 'var(--color-danger)' }}>{errorText}</p>
        )}

        {AUTH_MODE === 'dev' && (devHere ? (
          <>
            <p style={{ marginBottom: 20, fontSize: 14, color: 'var(--color-ink-muted)' }}>
              Local dev build — the backend's local no-auth bypass decides access.
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
