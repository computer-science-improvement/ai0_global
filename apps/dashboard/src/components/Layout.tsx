import { Link, Outlet } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';

export function Layout() {
  const { me, refresh } = useAuth();
  const onLogout = async () => { await authApi.logout(); await refresh(); window.location.href = '/login'; };

  return (
    <div className="min-h-screen" style={{ background: 'var(--color-canvas)' }}>
      <header style={{ borderBottom: '1px solid var(--color-hairline)', background: 'var(--color-canvas)' }}>
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6" style={{ height: 56 }}>
          <div className="flex items-center gap-8">
            <Link to={'/channels' as any} style={{ color: 'var(--color-ink)' }}
              className="text-headline">Channel Tracker</Link>
            <nav className="flex items-center gap-6 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
              <Link to={'/channels' as any}
                className="transition-colors hover:text-white"
                activeProps={{ style: { color: 'var(--color-ink)' } }}>
                Channels
              </Link>
              <Link to={'/graph' as any}
                className="transition-colors hover:text-white"
                activeProps={{ style: { color: 'var(--color-ink)' } }}>
                Graph
              </Link>
              <Link to={'/discovery' as any}
                className="transition-colors hover:text-white"
                activeProps={{ style: { color: 'var(--color-ink)' } }}>
                Discovery
              </Link>
              <Link to={'/recommendations' as any}
                className="transition-colors hover:text-white"
                activeProps={{ style: { color: 'var(--color-ink)' } }}>
                Recommendations
              </Link>
            </nav>
          </div>
          {me && (
            <div className="flex items-center gap-3 text-sm">
              <span style={{ color: 'var(--color-ink-muted)' }}>
                {me.firstName}{me.username ? ` (@${me.username})` : ''}
              </span>
              <button onClick={onLogout} className="btn-secondary">Logout</button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
