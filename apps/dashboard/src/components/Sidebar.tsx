// apps/dashboard/src/components/Sidebar.tsx
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

interface NavItem {
  to:     string;
  label:  string;
  icon:   string;
  hint?:  string;
}

const ITEMS: NavItem[] = [
  { to: '/channels',        label: 'Channels',        icon: '🛰' },
  { to: '/discovery',       label: 'Discovery',       icon: '🔎' },
  { to: '/graph',           label: 'Graph',           icon: '🕸' },
  { to: '/recommendations', label: 'Recommendations', icon: '🎯' },
  { to: '/bots',            label: 'Bots',            icon: '🤖' },
  { to: '/strategies',      label: 'Strategies',      icon: '⏱', hint: 'Phase 5c' },
];

const COLLAPSED_KEY = 'dashboard:sidebar-collapsed';

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1',
  );

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const width = collapsed ? 64 : 220;

  return (
    <aside
      style={{
        width,
        borderRight: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)',
        height: '100vh',
        position: 'sticky',
        top: 0,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 150ms ease',
      }}
    >
      <nav
        style={{ display: 'flex', flexDirection: 'column', padding: '12px 8px', gap: 4, flex: 1 }}
      >
        {ITEMS.map(item => {
          const isDisabled = !!item.hint;
          const content = (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '8px 10px', borderRadius: 6,
              color: 'var(--color-ink-muted)',
              opacity: isDisabled ? 0.4 : 1,
              fontSize: 14,
            }}>
              <span style={{ width: 18, textAlign: 'center' }}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
              {!collapsed && item.hint && (
                <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>{item.hint}</span>
              )}
            </span>
          );
          if (isDisabled) {
            return (
              <div key={item.to} title={item.hint} style={{ cursor: 'not-allowed' }}>
                {content}
              </div>
            );
          }
          return (
            <Link
              key={item.to}
              to={item.to as any}
              className="transition-colors hover:text-white"
              activeProps={{ style: { color: 'var(--color-ink)', background: 'var(--color-hairline)' } }}
              style={{ textDecoration: 'none' }}
            >
              {content}
            </Link>
          );
        })}
      </nav>
      <button
        onClick={toggle}
        style={{
          margin: '8px 10px', padding: '8px 10px', borderRadius: 6,
          background: 'transparent', border: '1px solid var(--color-hairline)',
          color: 'var(--color-ink-muted)', cursor: 'pointer', fontSize: 12,
        }}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        {collapsed ? '›' : '‹ Collapse'}
      </button>
    </aside>
  );
}
