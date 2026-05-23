// apps/dashboard/src/components/Layout.tsx
import { Outlet } from '@tanstack/react-router';
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ background: 'var(--color-canvas)' }}>
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              padding: '0 24px',
            }}
          >
            {me && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>
                  {me.firstName}{me.username ? ` · @${me.username}` : ''}
                </span>
                <button onClick={onLogout} className="btn-tiny">Logout</button>
              </div>
            )}
          </div>
        </header>
        <main style={{ flex: 1, padding: '20px 30px 60px', maxWidth: 1280, margin: '0 auto', width: '100%' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
