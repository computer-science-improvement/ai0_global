import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useState, type CSSProperties } from 'react';
import { Icon } from './ui/Icon';
import { toast } from './ui/Toast';
import { SidebarItem } from './nav/SidebarItem';
import { NavContextMenu } from './nav/NavContextMenu';
import { useNavBadgeCounts, useResolvedNav, useQuickNavEdit } from '../nav/store';
import { badgeFor, rollup, shownKeys } from '../nav/badges';
import { canHide, hideItem, togglePin } from '../nav/ops';
import type { ResolvedItem } from '../nav/model';

// Spec 027: no menu literals here. The menu is the registry (nav/registry.ts)
// resolved against the owner's saved menu (nav/resolve.ts).

interface Props {
  /** When true the sidebar renders as an off-canvas drawer (mobile). */
  isMobile?:  boolean;
  /** Drawer open state — only meaningful on mobile. */
  mobileOpen?: boolean;
  /** Called when a nav link is tapped, so the parent can close the drawer. */
  onNavigate?: () => void;
  /** Desktop rail state (owned by AppShell so ⌘K can toggle it). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function AppSidebar({ isMobile = false, mobileOpen = false, onNavigate, collapsed = false, onToggleCollapsed }: Props) {
  const toggle = () => onToggleCollapsed?.();

  const nav = useResolvedNav();
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  /** FR-008: the constructor, remembering this page for "Add current page". */
  const editMenu = (itemId?: string) => {
    onNavigate?.();
    void navigate({
      to: '/app/settings',
      search: { tab: 'navigation', ...(itemId ? { edit: itemId } : {}), ...(href.startsWith('/app/settings') ? {} : { from: href }) },
    });
  };
  const quick = useQuickNavEdit();
  const [ctx, setCtx] = useState<{ item: ResolvedItem; x: number; y: number } | null>(null);
  const closeCtx = useCallback(() => setCtx(null), []);

  // FR-010: live counters (and the spec 031 approvals count).
  const counts = useNavBadgeCounts();
  // FR-011: counters of hidden pages roll up into a dot on "Edit menu".
  // Pages whose count the menu already shows (e.g. the agent inbox inside Agents) are skipped.
  const hiddenRollup = rollup(nav.hidden, counts, shownKeys([...nav.pinned, ...nav.groups.flatMap((g) => g.items)]));

  const pinnedIds = new Set(nav.pinned.map((i) => i.id));
  const pin = (item: ResolvedItem) => {
    if (!pinnedIds.has(item.id) && pinnedIds.size >= 10) { toast.error('You can pin up to 10 pages. Unpin one first.'); return; }
    quick.apply((c) => togglePin(c, item.id));
  };
  const hide = (item: ResolvedItem) => {
    if (quick.apply((c) => hideItem(c, item.id))) {
      toast.success(`${item.label} is hidden from the menu. The page still works; find it with ⌘K.`);
    }
  };

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

  const renderItem = (item: ResolvedItem, where: string) => (
    <SidebarItem
      key={`${where}:${item.id}`}
      item={item}
      collapsed={isCollapsed}
      pinned={pinnedIds.has(item.id)}
      badge={badgeFor(item.badge, counts)}
      onNavigate={onNavigate}
      onTogglePin={pin}
      onContext={(it, x, y) => setCtx({ item: it, x, y })}
    />
  );

  const groupTitle = (title: string) => !isCollapsed && (
    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--color-ink-dim)', margin: '12px 8px 4px' }}>{title}</div>
  );

  return (
    <aside style={style} aria-label="Main menu">
      <div style={{ padding: '16px 14px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link
          to={'/app' as any}
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
        {nav.pinned.length > 0 && (
          <div style={{ marginBottom: 6, paddingBottom: isCollapsed ? 6 : 0, borderBottom: isCollapsed ? '1px solid var(--color-hairline)' : 'none' }}>
            {groupTitle('Pinned')}
            {nav.pinned.map((item) => renderItem(item, 'pinned'))}
          </div>
        )}
        {nav.groups.map(g => (
          <div key={g.id} style={{ marginBottom: 6 }}>
            {groupTitle(g.title)}
            {g.items.map((item) => renderItem(item, g.id))}
          </div>
        ))}
      </nav>

      <div style={{ padding: '6px 10px 0' }}>
        <button onClick={() => editMenu()} className="btn-ghost"
          title={hiddenRollup ? `Edit menu. Hidden pages need attention:\n${hiddenRollup.title}` : 'Edit menu'}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: isCollapsed ? 'center' : 'flex-start', gap: 8, fontSize: 12 }}>
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Icon name="pencil" size={14} />
            {hiddenRollup && (
              <span className="nav-dot" aria-hidden
                style={{ background: hiddenRollup.tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)' }} />
            )}
          </span>
          {!isCollapsed && <span>Edit menu</span>}
          {hiddenRollup && <span className="sr-only">. Hidden pages need attention: {hiddenRollup.title}</span>}
        </button>
      </div>

      {!isMobile && (
        <div style={{ padding: '10px' }}>
          <button onClick={toggle} className="btn-secondary" style={{ width: '100%', justifyContent: 'center', gap: 8, fontSize: 12, padding: collapsed ? 8 : '8px 12px' }} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      )}

      {ctx && (
        <NavContextMenu
          x={ctx.x} y={ctx.y} title={ctx.item.label} onClose={closeCtx}
          actions={[
            pinnedIds.has(ctx.item.id)
              ? { label: 'Unpin', icon: 'pin-off', onSelect: () => pin(ctx.item) }
              : { label: 'Pin to the top', icon: 'pin', onSelect: () => pin(ctx.item), disabled: !!ctx.item.unavailable },
            {
              label: 'Hide from the menu', icon: 'eye-off', onSelect: () => hide(ctx.item),
              disabled: !canHide(ctx.item.id), title: canHide(ctx.item.id) ? undefined : `${ctx.item.label} is always shown`,
            },
            { label: 'Rename…', icon: 'pencil', onSelect: () => editMenu(ctx.item.id) },
          ]}
        />
      )}
    </aside>
  );
}
