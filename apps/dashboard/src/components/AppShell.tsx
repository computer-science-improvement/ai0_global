import { Outlet } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { AppSidebar } from './AppSidebar';
import { PlatformFilter } from './PlatformFilter';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

export function AppShell() {
  const { me, refresh } = useAuth();
  const onLogout = async () => {
    await authApi.logout();
    await refresh();
    window.location.href = '/login';
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-canvas)' }}>
      <AppSidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 20px', borderBottom: '1px solid var(--color-hairline)',
          background: 'var(--color-canvas)', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <PlatformFilter />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {me && (
              <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>
                {me.firstName}{me.username ? ` · @${me.username}` : ''}
              </span>
            )}
            <Button variant="primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="plus" size={14} /> Новий пост
            </Button>
            {me && <Button variant="tiny" onClick={onLogout}>Вийти</Button>}
          </div>
        </header>
        <main style={{ flex: 1, padding: '24px 30px 60px', maxWidth: 1320, margin: '0 auto', width: '100%' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
