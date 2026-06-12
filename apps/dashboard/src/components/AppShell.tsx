import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { AppSidebar } from './AppSidebar';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { ConfirmProvider } from './ui/ConfirmDialog';
import { useMediaQuery } from '../lib/useMediaQuery';
import { AUTH_MODE } from '../lib/env';

export function AppShell() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 860px)');
  const [navOpen, setNavOpen] = useState(false);

  // Collapse the drawer whenever we leave the mobile breakpoint, so resizing
  // a desktop window never leaves a stray overlay open.
  useEffect(() => { if (!isMobile) setNavOpen(false); }, [isMobile]);

  const onLogout = async () => {
    // Always hard-redirect, even if the request errors — a full reload re-runs
    // the auth check against the (now-cleared) cookie. `replace` keeps the
    // authed view out of history.
    try { await authApi.logout(); } catch { /* ignore */ }
    window.location.replace('/login');
  };

  return (
    <ConfirmProvider>
      <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-canvas)' }}>
        <AppSidebar
          isMobile={isMobile}
          mobileOpen={navOpen}
          onNavigate={() => setNavOpen(false)}
        />

        {isMobile && navOpen && (
          <div
            onClick={() => setNavOpen(false)}
            aria-hidden
            style={{
              position: 'fixed', inset: 0, zIndex: 55,
              background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
            }}
          />
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <header style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: isMobile ? '10px 14px' : '12px 20px',
            borderBottom: '1px solid var(--color-hairline)',
            background: 'var(--color-canvas)', position: 'sticky', top: 0, zIndex: 10,
          }}>
            {isMobile && (
              <button
                onClick={() => setNavOpen(true)}
                className="btn-icon"
                style={{ width: 38, height: 38, flexShrink: 0 }}
                aria-label="Open menu"
              >
                <Icon name="menu" size={18} />
              </button>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12 }}>
              {me && !isMobile && (
                <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>
                  {me.firstName}{me.username ? ` · @${me.username}` : ''}
                </span>
              )}
              <Button
                variant="primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title="New post"
                onClick={() => navigate({ to: '/compose' })}
              >
                <Icon name="plus" size={14} />{!isMobile && ' New post'}
              </Button>
              {/* Logout only when real auth is configured (telegram/token) —
                  in dev-bypass mode there's no session to end. */}
              {me && AUTH_MODE !== 'dev' && <Button variant="tiny" onClick={onLogout}>Log out</Button>}
            </div>
          </header>

          <main style={{
            flex: 1,
            padding: isMobile ? '16px 14px 48px' : '24px 30px 60px',
            maxWidth: 1320, margin: '0 auto', width: '100%',
          }}>
            <Outlet />
          </main>
        </div>
      </div>
    </ConfirmProvider>
  );
}
