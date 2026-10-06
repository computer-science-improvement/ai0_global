import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { AppShell } from '../components/AppShell';
import { AppNotFound } from '../components/NotFound';
import { sessionQuery } from '../auth/session';
import { Button } from '../components/ui/Button';

// Layout route for the entire authenticated app (everything under /app).
// The guard runs in the router, before anything renders (spec 028 FR-011): the
// session comes from `/auth/me` through the ['auth','session'] query. A cached
// session renders instantly (and is revalidated in the background); a cold
// check shows AuthPending. No session → /login?next=<this page>&reason=<why>.
// In production nginx gates the HTML too; this covers client-side navigation
// and the Vite dev server.
export const Route = createFileRoute('/app')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData({ ...sessionQuery, revalidateIfStale: true });
    if (!session.me) {
      throw redirect({
        to: '/login',
        search: { next: location.href, ...(session.reason ? { reason: session.reason } : {}) },
      });
    }
    return { me: session.me };
  },
  pendingComponent: AuthPending,
  errorComponent: AuthCheckFailed,
  // Spec 027 FR-002: unknown /app/* paths render inside the shell.
  notFoundComponent: AppNotFound,
  component: AppShell,
});

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'var(--color-canvas)',
    }}>
      {children}
    </div>
  );
}

function AuthPending() {
  return (
    <Centered>
      <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-ink-muted)' }}>
        <span className="auth-pending-dot" aria-hidden />
        <span className="text-caption">Checking your session…</span>
      </div>
    </Centered>
  );
}

/** `/auth/me` itself failed (server down / 5xx): not a logout, so offer a retry. */
function AuthCheckFailed() {
  const router = useRouter();
  return (
    <Centered>
      <div className="card-featured" style={{ maxWidth: 400, width: '100%', padding: 32 }}>
        <h1 className="text-display-md" style={{ marginBottom: 8 }}>Can't reach the server</h1>
        <p style={{ marginBottom: 20, fontSize: 15, color: 'var(--color-ink-muted)' }}>
          We couldn't check your sign-in. Your session is not affected.
        </p>
        <Button variant="primary" style={{ width: '100%' }} onClick={() => void router.invalidate()}>Try again</Button>
      </div>
    </Centered>
  );
}
