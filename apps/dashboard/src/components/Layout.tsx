// apps/dashboard/src/components/Layout.tsx
import { Link, Outlet } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { Sidebar } from './Sidebar';

export function Layout() {
  const { me, refresh } = useAuth();
  const onLogout = async () => {
    await authApi.logout();
    await refresh();
    window.location.href = '/login';
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-canvas)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            borderBottom: '1px solid var(--color-hairline)',
            background: 'var(--color-canvas)',
          }}
        >
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 24px',
            }}
          >
            <Link
              to={'/channels' as any}
              style={{ color: 'var(--color-ink)', textDecoration: 'none' }}
              className="text-headline"
            >
              Channel Tracker
            </Link>
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
        <main style={{ flex: 1, padding: '40px 24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
