import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { AppSidebar } from './AppSidebar';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { ConfirmProvider } from './ui/ConfirmDialog';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNavBadgeCounts, useResolvedNav } from '../nav/store';
import { rollup } from '../nav/badges';

export function AppShell() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isMobile = useMediaQuery('(max-width: 860px)');
  const [navOpen, setNavOpen] = useState(false);

  // Spec 027 FR-011/FR-014: any counter (hidden pages included) shows as a dot on the hamburger.
  const nav = useResolvedNav();
  const counts = useNavBadgeCounts();
  const attention = isMobile ? rollup([...nav.pinned, ...nav.groups.flatMap((g) => g.items), ...nav.hidden], counts) : null;

  // Collapse the drawer whenever we leave the mobile breakpoint, so resizing
  // a desktop window never leaves a stray overlay open.
  useEffect(() => { if (!isMobile) setNavOpen(false); }, [isMobile]);

  const onLogout = async () => {
    // Revoke the session server-side (spec 028 FR-014), then forget every cached
    // query — including the session — so neither /login's guard nor the Back
    // button shows stale data. `replace` keeps the authed view out of history.
    try { await authApi.logout(); } catch { /* the cookie may already be dead */ }
    qc.clear();
    await navigate({ to: '/login', replace: true });
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
                style={{ width: 38, height: 38, flexShrink: 0, position: 'relative' }}
                aria-label={attention ? `Open menu (needs attention: ${attention.title.replace(/\n/g, '; ')})` : 'Open menu'}
                title={attention?.title}
              >
                <Icon name="menu" size={18} />
                {attention && (
                  <span aria-hidden className="nav-dot" style={{
                    top: 6, right: 6, width: 8, height: 8,
                    background: attention.tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)',
                    boxShadow: '0 0 0 2px var(--color-canvas)',
                  }} />
                )}
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
                onClick={() => navigate({ to: '/app/compose' })}
              >
                <Icon name="plus" size={14} />{!isMobile && ' New post'}
              </Button>
              {/* Hidden only for a server-confirmed dev-bypass identity: there
                  is no session to end then. */}
              {me && me.method !== 'dev' && <Button variant="tiny" onClick={onLogout}>Log out</Button>}
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
