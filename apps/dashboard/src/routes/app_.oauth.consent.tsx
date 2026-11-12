import { createFileRoute, redirect } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { connectorsApi } from '../api/connectors';
import { useAuth } from '../auth/use-auth';
import { sessionQuery } from '../auth/session';
import { AuthCheckFailed, AuthPending } from './app';
import { Icon } from '../components/ui/Icon';
import { CONSENT_FAILURE_TEXT, clientKindLabel, consentFailure, safeRedirect, scopeLabel, type ConsentFailure } from '../lib/connector-view';
import '../components/auth/auth.css';

// Spec 103 FR-E: the page the connector's /api/oauth/authorize sends the owner to (`?request=<opaque id>`). It sits
// outside the app shell (no sidebar, no ConfirmProvider: this page is itself the confirmation), under /app so the nginx
// gate, the login redirect and the way back to this page work as for every other page.

const WRITE = 'mcp:write';
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const Route = createFileRoute('/app_/oauth/consent')({
  validateSearch: (s: Record<string, unknown>): { request: string } => ({
    request: typeof s.request === 'string' && REQUEST_ID.test(s.request) ? s.request : '',
  }),
  // Same guard as the /app layout: no session -> /login, back here after signing in.
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData({ ...sessionQuery, revalidateIfStale: true });
    if (!session.me) {
      throw redirect({ to: '/login', search: { next: location.href, ...(session.reason ? { reason: session.reason } : {}) } });
    }
  },
  pendingComponent: AuthPending,
  errorComponent: AuthCheckFailed,
  component: ConsentPage,
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="au-root">
      <div className="panel is-section au-card au-consent compose-rise">{children}</div>
    </div>
  );
}

function Failure({ kind }: { kind: ConsentFailure }) {
  const t = CONSENT_FAILURE_TEXT[kind];
  return (
    <Shell>
      <div className="text-overline au-over">Connect Claude</div>
      <h1 className="page-title au-title" style={{ marginBottom: 8 }}>{t.title}</h1>
      <p className="au-sub" role="alert">{t.text}</p>
    </Shell>
  );
}

function ConsentPage() {
  const { request } = Route.useSearch();
  const { me } = useAuth();
  const [readOnly, setReadOnly] = useState(false);
  const [sent, setSent] = useState<'allow' | 'deny' | null>(null);
  const [badRedirect, setBadRedirect] = useState(false);
  const q = useQuery({
    queryKey: ['oauth', 'request', request],
    queryFn: () => connectorsApi.request(request),
    enabled: !!request,
    retry: false,
    staleTime: Infinity,
  });
  const decide = useMutation({
    meta: { silentError: true },
    mutationFn: (v: { decision: 'allow' | 'deny'; scopes?: string[] }) => connectorsApi.decide(request, v.decision, v.scopes),
    onSuccess: (r, v) => {
      const to = safeRedirect(r.redirect, !!q.data?.client.loopback);
      if (!to) { setBadRedirect(true); return; }
      setSent(v.decision);
      // A full navigation to the client's callback (an external page), not a router move.
      window.location.assign(to);
    },
  });

  if (!request) return <Failure kind="unknown" />;
  if (q.isLoading) {
    return <Shell><div role="status" className="au-pending"><span className="auth-pending-dot" aria-hidden /><span className="text-caption">Loading the request…</span></div></Shell>;
  }
  if (q.error) {
    const e = q.error;
    return <Failure kind={e instanceof ApiError ? consentFailure(e.status, e.message) : 'error'} />;
  }
  const r = q.data;
  if (!r) return <Failure kind="error" />;

  const canWrite = r.scopes.some((s) => s.scope === WRITE);
  const granted = r.scopes.map((s) => s.scope).filter((s) => !(readOnly && s === WRITE));
  const failed = decide.error ? (decide.error instanceof ApiError ? consentFailure(decide.error.status, decide.error.message) : 'error') : null;
  const busy = decide.isPending || sent !== null;
  const who = me ? `${me.firstName}${me.username ? ` @${me.username}` : ''}` : null;

  return (
    <Shell>
      <div className="text-overline au-over">Connect Claude</div>
      <h1 className="page-title au-title au-consent-title">{r.client.name} wants access to ai0</h1>
      <p className="au-sub">
        {clientKindLabel(r.client.kind) ? <>{clientKindLabel(r.client.kind)} · </> : null}
        it will return to <span className="mono au-host">{r.client.redirectHost}</span>
      </p>

      {r.client.loopback && (
        <div role="note" className="inset au-note">
          <Icon name="info" size={15} />
          <span>This app runs on your computer. Allow it only if you just started it there (for example Claude Code).</span>
        </div>
      )}

      <div className="text-overline au-over">It will be able to</div>
      <ul className="au-scopes">
        {r.scopes.map((s) => (
          <li key={s.scope} className={readOnly && s.scope === WRITE ? 'is-off' : undefined}>
            <Icon name={s.scope === WRITE ? 'pencil' : 'eye'} size={14} />
            <span>{s.label || scopeLabel(s.scope)}{readOnly && s.scope === WRITE ? ' (off)' : ''}</span>
          </li>
        ))}
      </ul>
      <p className="au-help au-fine">It can never publish a post directly or change a channel's mode, settings or budgets. You can disconnect it any time in Settings → Connectors.</p>

      {canWrite && (
        <label className="au-check">
          <input type="checkbox" checked={readOnly} disabled={busy} onChange={(e) => setReadOnly(e.target.checked)} />
          <span>Read only: it can look but not plan or prepare posts</span>
        </label>
      )}

      {who && <p className="au-fine au-who">Signed in as {who}</p>}
      {failed && <p role="alert" className="callout-danger au-error">{CONSENT_FAILURE_TEXT[failed].text}</p>}
      {badRedirect && <p role="alert" className="callout-danger au-error">The server returned an address this page will not open. Nothing was sent to the app; start again from Claude.</p>}
      {sent && <p role="status" className="au-help au-fine">{sent === 'allow' ? 'Allowed. Taking you back to the app…' : 'Denied. Taking you back to the app…'}</p>}

      <div className="au-actions">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => decide.mutate({ decision: 'deny' })}>Deny</button>
        <button type="button" className="btn-primary" disabled={busy || granted.length === 0}
          onClick={() => decide.mutate({ decision: 'allow', scopes: granted })}>
          {decide.isPending ? 'Working…' : 'Allow'}
        </button>
      </div>
    </Shell>
  );
}
