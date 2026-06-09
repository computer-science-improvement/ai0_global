import { Link } from '@tanstack/react-router';
import { useState, type CSSProperties } from 'react';
import { Icon, type IconName } from './ui/Icon';

interface NavItem { to: string; label: string; icon: IconName; soon?: boolean; exact?: boolean; search?: Record<string, unknown>; }
interface NavGroup { title: string; items: NavItem[]; }

const GROUPS: NavGroup[] = [
  { title: 'Home', items: [
    { to: '/', label: 'Overview', icon: 'overview' },
  ]},
  { title: 'Publishing', items: [
    { to: '/strategies', label: 'Strategies', icon: 'strategies' },
    { to: '/scheduled',  label: 'Scheduled', icon: 'calendar' },
    { to: '/channels',   label: 'My channels', icon: 'channels', search: { filter: 'mine' } },
  ]},
  { title: 'Analytics', items: [
    { to: '/analytics', label: 'Analytics', icon: 'analytics' },
    { to: '/logs',      label: 'Logs',       icon: 'logs' },
  ]},
  { title: 'Intelligence', items: [
    { to: '/discovery',       label: 'Discovery',     icon: 'discovery' },
    { to: '/tracked',         label: 'Tracked',  icon: 'channels' },
    { to: '/graph',           label: 'Graph',          icon: 'graph' },
    { to: '/recommendations', label: 'Recommendations',  icon: 'recommendations' },
  ]},
  { title: 'Connections', items: [
    { to: '/connections',        label: 'Telegram', icon: 'telegram', exact: true },
    { to: '/connections/meta',   label: 'Meta',     icon: 'facebook' },
    { to: '/connections/tiktok', label: 'TikTok',   icon: 'tiktok', soon: true },
  ]},
  { title: 'System', items: [
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ]},
];

const COLLAPSED_KEY = 'dashboard:sidebar-collapsed';

interface Props {
  /** When true the sidebar renders as an off-canvas drawer (mobile). */
  isMobile?:  boolean;
  /** Drawer open state — only meaningful on mobile. */
  mobileOpen?: boolean;
  /** Called when a nav link is tapped, so the parent can close the drawer. */
  onNavigate?: () => void;
}

export function AppSidebar({ isMobile = false, mobileOpen = false, onNavigate }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1');
  const toggle = () => setCollapsed(prev => {
    const next = !prev;
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  // On mobile the drawer is always full-width (never the collapsed rail).
  const isCollapsed = isMobile ? false : collapsed;
  const width = isMobile ? 264 : (collapsed ? 64 : 234);

  const base: CSSProperties = {
    width, flexShrink: 0,
    background: 'var(--color-surface-1)',
    borderRight: '1px solid var(--color-hairline)',
    display: 'flex', flexDirection: 'column',
  };
  const style: CSSProperties = isMobile
    ? {
        ...base,
        height: '100vh', position: 'fixed', top: 0, left: 0, zIndex: 60,
        transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 220ms cubic-bezier(0.2,0.7,0.2,1)',
        boxShadow: mobileOpen ? '0 12px 48px rgba(0,0,0,0.55)' : 'none',
      }
    : {
        ...base,
        height: '100vh', position: 'sticky', top: 0,
        transition: 'width 160ms cubic-bezier(0.2,0.7,0.2,1)',
      };

  return (
    <aside style={style}>
      <div style={{ padding: '16px 14px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link
          to={'/' as any}
          onClick={onNavigate}
          style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-ink)', fontWeight: 600, letterSpacing: '-0.02em', textDecoration: 'none' }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 999, background: 'var(--color-accent)' }} />
          {!isCollapsed && <span>ai0</span>}
        </Link>
        {isMobile && (
          <button onClick={onNavigate} className="btn-icon" style={{ width: 32, height: 32 }} aria-label="Close menu">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 10px' }}>
        {GROUPS.map(g => (
          <div key={g.title} style={{ marginBottom: 6 }}>
            {!isCollapsed && (
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--color-ink-dim)', margin: '12px 8px 4px' }}>{g.title}</div>
            )}
            {g.items.map(item => (
              <Link
                key={item.to}
                to={item.to as any}
                search={item.search as any}
                onClick={onNavigate}
                activeOptions={item.exact ? { exact: true } : undefined}
                title={isCollapsed ? item.label : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '6px 9px', borderRadius: 'var(--radius-sm)',
                  fontSize: 13, color: 'var(--color-ink-muted)', textDecoration: 'none',
                  justifyContent: isCollapsed ? 'center' : 'flex-start',
                }}
                activeProps={{ style: { background: 'var(--color-surface-3)', color: 'var(--color-ink)' } }}
              >
                <Icon name={item.icon} size={16} />
                {!isCollapsed && <span>{item.label}</span>}
                {!isCollapsed && item.soon && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--color-ink-dim)', border: '1px solid var(--color-hairline-strong)', borderRadius: 999, padding: '0 6px' }}>soon</span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {!isMobile && (
        <div style={{ padding: '10px' }}>
          <button onClick={toggle} className="btn-secondary" style={{ width: '100%', justifyContent: 'center', gap: 8, fontSize: 12, padding: collapsed ? 8 : '8px 12px' }} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      )}
    </aside>
  );
}
