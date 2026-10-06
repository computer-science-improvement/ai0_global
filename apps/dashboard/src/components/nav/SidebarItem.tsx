import { Link } from '@tanstack/react-router';
import { useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { Icon } from '../ui/Icon';
import type { ResolvedItem } from '../../nav/model';
import { badgeText, type BadgeView } from '../../nav/badges';

const LONG_PRESS_MS = 500;

/**
 * One menu entry (spec 027 FR-009/FR-011): the link, its counter (a pill, or a
 * dot in the collapsed rail), a "new" dot, the hover star (pin/unpin), and the
 * right-click / long-press context menu. A custom link whose page is gone
 * renders disabled.
 */
export function SidebarItem({ item, collapsed, pinned, badge, onNavigate, onTogglePin, onContext }: {
  item:        ResolvedItem;
  collapsed:   boolean;
  pinned:      boolean;
  badge:       BadgeView | null;
  onNavigate?: () => void;
  onTogglePin?: (item: ResolvedItem) => void;
  onContext?:  (item: ResolvedItem, x: number, y: number) => void;
}) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);

  const openContext = (e: ReactMouseEvent) => {
    if (!onContext) return;
    e.preventDefault();
    onContext(item, e.clientX, e.clientY);
  };
  const touchStart = (e: React.TouchEvent) => {
    if (!onContext) return;
    longPressed.current = false;
    const t = e.touches[0];
    const { clientX, clientY } = t;
    timer.current = window.setTimeout(() => { longPressed.current = true; onContext(item, clientX, clientY); }, LONG_PRESS_MS);
  };
  const touchEnd = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };
  // A long press opened the menu: swallow the click that follows the touch.
  const onClick = (e: ReactMouseEvent) => {
    if (longPressed.current) { e.preventDefault(); longPressed.current = false; return; }
    onNavigate?.();
  };

  const count = badge && badge.count > 0 ? badge.count : 0;
  const shown = badgeText(count);
  const toneVar = badge?.tone === 'danger' ? 'var(--color-danger)' : badge?.tone === 'warning' ? 'var(--color-warning)' : 'var(--color-accent)';
  const title = collapsed
    ? `${item.label}${count ? ` (${badge!.title})` : ''}`
    : item.unavailable ? 'This page no longer exists' : undefined;

  const inner = (
    <>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <Icon name={item.icon} size={16} />
        {collapsed && count > 0 && <span className="nav-dot" aria-hidden style={{ background: toneVar }} />}
        {collapsed && !count && item.isNew && <span className="nav-dot" aria-hidden style={{ background: 'var(--color-accent)' }} />}
      </span>
      {!collapsed && <span className="nav-label">{item.label}</span>}
      {!collapsed && item.isNew && !count && <span className="nav-new" title="New page since you last edited the menu">new</span>}
      {!collapsed && count > 0 && (
        <span className="nav-badge tabular-nums" title={badge!.title} style={{ borderColor: toneVar }}>{shown}</span>
      )}
      {count > 0 && <span className="sr-only">, {badge!.title}</span>}
    </>
  );

  return (
    <div className={`nav-row${collapsed ? ' nav-row-collapsed' : ''}`} onContextMenu={openContext}
      onTouchStart={touchStart} onTouchEnd={touchEnd} onTouchMove={touchEnd} onTouchCancel={touchEnd}>
      {item.unavailable ? (
        <span className="nav-link nav-link-disabled" aria-disabled title={title}>{inner}</span>
      ) : (
        <Link
          to={item.to as any}
          search={item.search as any}
          onClick={onClick}
          activeOptions={item.exact ? { exact: true } : undefined}
          title={title}
          className="nav-link"
          activeProps={{ className: 'nav-link-active' }}
          style={{ justifyContent: collapsed ? 'center' : 'flex-start' }}
        >
          {inner}
        </Link>
      )}
      {!collapsed && onTogglePin && !item.unavailable && (
        <button type="button" className="nav-star" aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label}`} title={pinned ? 'Unpin' : 'Pin to the top'}
          onClick={() => onTogglePin(item)}>
          <Icon name="star" size={13} strokeWidth={pinned ? 2.4 : 1.75} />
        </button>
      )}
    </div>
  );
}
