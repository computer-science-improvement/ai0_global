import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { AppSidebar } from './AppSidebar';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { ConfirmProvider } from './ui/ConfirmDialog';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNavBadgeCounts, useQuickNavEdit, useResolvedNav } from '../nav/store';
import { rollup } from '../nav/badges';
import { CommandPalette } from './CommandPalette';
import { toast } from './ui/Toast';
import { isTypingTarget } from '../nav/palette';
import { guessLabel, newNavId, parseNavTarget } from '../nav/config';
import { hrefOf } from '../nav/model';
import { menuEntries } from '../nav/registry';
import { pinPage } from '../nav/ops';
import { liveAgentCount, liveAgentsLabel } from '../nav/sidebar-model';
import { useEditorChannels } from '../api/editor';
import './nav/shell.css';

const COLLAPSED_KEY = 'dashboard:sidebar-collapsed';
/** Spec 048 FR-004: on the chat page the menu is the icon rail unless the viewer opened it there (kept apart from the global choice). */
const CHAT_NAV_KEY = 'dashboard:chat-nav';

export const isChatPath = (pathname: string) => pathname === '/app/chat' || pathname.startsWith('/app/chat/');
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function AppShell() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isMobile = useMediaQuery('(max-width: 860px)');
  const [navOpen, setNavOpen] = useState(false);
  const router = useRouter();
  const quick = useQuickNavEdit();

  // Desktop rail state (BR-CORE-13), here so the ⌘K "Collapse sidebar" action can flip it.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleGlobal = useCallback(() => setCollapsed((prev) => {
    const next = !prev;
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  }), []);
  const onChat = isChatPath(useRouterState({ select: (s) => s.location.pathname }));
  const [chatNavOpen, setChatNavOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(CHAT_NAV_KEY) === 'open'; } catch { return false; }
  });
  const toggleChatNav = useCallback(() => setChatNavOpen((prev) => {
    const next = !prev;
    try { localStorage.setItem(CHAT_NAV_KEY, next ? 'open' : 'rail'); } catch { /* ignore */ }
    return next;
  }), []);
  const railCollapsed = onChat ? !chatNavOpen : collapsed;
  const toggleCollapsed = onChat ? toggleChatNav : toggleGlobal;
  // The chat fills the window below the header: its columns scroll on their own (FR-004).
  // Spec 056: the network map fills the window as well (its HUD floats over it).
  const onMap = useRouterState({ select: (s) => s.location.pathname === '/app/map' });
  const fullBleed = onChat || onMap;

  // Spec 027 FR-012: ⌘K / Ctrl+K anywhere in /app, except while typing in a field.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      if (isTypingTarget(e.target) && !paletteOpen) return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const editMenu = () => {
    const href = router.state.location.href;
    void navigate({ to: '/app/settings', search: { tab: 'navigation', ...(href.startsWith('/app/settings') ? {} : { from: href }) } });
  };
  /** ⌘K "Pin current page": the registry page at this exact address, or a pin-only custom link. */
  const pinCurrentPage = () => {
    const target = parseNavTarget(router.state.location.href);
    if (!target) { toast.error("This page can't be pinned."); return; }
    const entry = menuEntries().find((e) => hrefOf(e) === hrefOf(target));
    const heading = typeof document !== 'undefined' ? document.querySelector('main h1')?.textContent?.trim() : '';
    const label = entry?.label ?? (heading || guessLabel(target.to));
    const ok = quick.apply((c) => pinPage(c, target, label, entry?.id ?? null, newNavId('c_')));
    if (ok) toast.success(`Pinned ${label}`);
    else if (!quick.isPending) toast.error('Already pinned, or the 10 pins are taken.');
  };
  const onPaletteAction = (a: 'new-post' | 'pin-page' | 'edit-menu' | 'collapse-sidebar') => {
    if (a === 'new-post') void navigate({ to: '/app/compose' });
    else if (a === 'pin-page') pinCurrentPage();
    else if (a === 'edit-menu') editMenu();
    else if (isMobile) setNavOpen(true);
    else toggleCollapsed();
  };

  // Spec 027 FR-011/FR-014: any counter (hidden pages included) shows as a dot on the hamburger.
  const nav = useResolvedNav();
  const counts = useNavBadgeCounts();
  const attention = isMobile ? rollup([...nav.pinned, ...nav.groups.flatMap((g) => g.items), ...nav.hidden], counts) : null;
  // Spec 078: the "N agents live" pill counts the channels whose editor agent is in live mode.
  const live = liveAgentCount(useEditorChannels().data?.channels);

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
      <div style={{ display: 'flex', minHeight: '100vh', ...(fullBleed ? { height: '100dvh' } : {}), background: 'var(--color-canvas)' }}>
        <AppSidebar
          isMobile={isMobile}
          mobileOpen={navOpen}
          onNavigate={() => setNavOpen(false)}
          collapsed={railCollapsed}
          onToggleCollapsed={toggleCollapsed}
          // Hidden only for a server-confirmed dev-bypass identity: there is no session to end then.
          onLogout={me && me.method !== 'dev' ? onLogout : undefined}
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

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <header className="topbar">
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
            <button type="button" className="cmdk-trigger" onClick={() => setPaletteOpen(true)}
              aria-label={`Search pages and actions (${IS_MAC ? '⌘' : 'Ctrl'} K)`} title={`Search (${IS_MAC ? '⌘' : 'Ctrl'} K)`}>
              <Icon name="search" size={15} />
              {!isMobile && <span>Search pages and actions…</span>}
              {!isMobile && <kbd className="kbd">{IS_MAC ? '⌘' : 'Ctrl'} K</kbd>}
            </button>
            <div className="topbar-end">
              {live > 0 && (
                <span className="shell-live" title="Channels whose agent publishes on its own (live mode)">
                  <span className="shell-live-dot" aria-hidden />
                  {liveAgentsLabel(live)}
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
            </div>
          </header>

          <main style={fullBleed ? { flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' } : {
            flex: 1,
            padding: isMobile ? '16px 16px 48px' : '32px 32px 48px',
            maxWidth: 1240, margin: '0 auto', width: '100%',
          }}>
            <Outlet />
          </main>
          <CommandPalette open={paletteOpen} onClose={closePalette} onAction={onPaletteAction} />
        </div>
      </div>
    </ConfirmProvider>
  );
}
