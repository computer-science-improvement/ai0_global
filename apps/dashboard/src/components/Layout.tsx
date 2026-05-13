import { Link, Outlet } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';

export function Layout() {
  const { me, refresh } = useAuth();
  const onLogout = async () => { await authApi.logout(); await refresh(); window.location.href = '/login'; };

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-800 bg-neutral-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to={'/channels' as any} className="text-lg font-bold">Channel Tracker</Link>
            <nav className="flex gap-4 text-sm text-neutral-300">
              <Link to={'/channels' as any} className="hover:text-white" activeProps={{ className: 'text-white' }}>Channels</Link>
              <Link to={'/graph' as any} className="hover:text-white" activeProps={{ className: 'text-white' }}>Graph</Link>
              <Link to={'/discovery' as any} className="hover:text-white" activeProps={{ className: 'text-white' }}>Discovery</Link>
            </nav>
          </div>
          {me && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-neutral-400">{me.firstName}{me.username ? ` (@${me.username})` : ''}</span>
              <button onClick={onLogout} className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700">Logout</button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
