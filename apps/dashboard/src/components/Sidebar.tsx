// apps/dashboard/src/components/Sidebar.tsx
//
// Borderless nav on canvas. Active state = surface-1 lift + ink color +
// 2px accent rail on the left edge. Hover = same surface-1 lift but with
// transition; we put the visual on the Link itself (`.nav-item`) instead of
// an inner <span>, which is what the old hover:text-white was failing to
// reach. Collapse uses a charcoal pill (`.btn-secondary`) — no ghost-bordered
// buttons (spec violation).

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from './Icon';

type IconName = 'channels' | 'discovery' | 'graph' | 'recommendations' | 'bots' | 'strategies';

interface NavItem {
  to:     string;
  label:  string;
  icon:   IconName;
  hint?:  string;
}

const ITEMS: NavItem[] = [
  { to: '/channels',        label: 'Channels',        icon: 'channels'        },
  { to: '/discovery',       label: 'Discovery',       icon: 'discovery'       },
  { to: '/graph',           label: 'Graph',           icon: 'graph'           },
  { to: '/recommendations', label: 'Recommendations', icon: 'recommendations' },
  { to: '/bots',            label: 'Bots',            icon: 'bots'            },
  { to: '/strategies',      label: 'Strategies',      icon: 'strategies'      },
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

  const width = collapsed ? 68 : 224;

  return (
    <aside
      style={{
        width,
        background: 'var(--color-canvas)',
        height: '100vh',
        position: 'sticky',
        top: 0,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 160ms cubic-bezier(0.2, 0.7, 0.2, 1)',
        flexShrink: 0,
      }}
    >
      {/* Wordmark */}
      <div style={{ padding: '20px 16px 12px', overflow: 'hidden' }}>
        <Link to={'/channels' as any} className="wordmark" aria-label="Channel Tracker">
          <span className="dot" />
          {!collapsed && <span>Channel Tracker</span>}
        </Link>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', padding: '8px 10px', gap: 2, flex: 1 }}>
        {ITEMS.map(item => {
          const disabled = !!item.hint;
          if (disabled) {
            return (
              <div key={item.to} className="nav-item is-disabled" title={item.hint}>
                <Icon name={item.icon} />
                {!collapsed && (
                  <>
                    <span>{item.label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.7 }}>{item.hint}</span>
                  </>
                )}
              </div>
            );
          }
          return (
            <Link
              key={item.to}
              to={item.to as any}
              className="nav-item"
              activeProps={{ className: 'nav-item is-active' }}
              title={collapsed ? item.label : undefined}
            >
              <Icon name={item.icon} />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div style={{ padding: '12px 10px 16px' }}>
        <button
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="btn-secondary"
          style={{
            width: '100%',
            padding: collapsed ? '8px' : '8px 12px',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 8,
            fontSize: 12,
          }}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
