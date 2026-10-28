import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Icon } from './ui/Icon';
import { toast } from './ui/Toast';
import { SidebarItem } from './nav/SidebarItem';
import { NavContextMenu, type NavMenuAction } from './nav/NavContextMenu';
import { BudgetCard, OperatorRow } from './nav/SidebarFooter';
import { useNavBadgeCounts, useResolvedNav, useQuickNavEdit } from '../nav/store';
import { badgeFor, badgeText, rollup, shownKeys } from '../nav/badges';
import { canHide, hideItem, togglePin } from '../nav/ops';
import { routerSearch, type ResolvedItem } from '../nav/model';
import { activeItemId, moreTools, showGroupTitle } from '../nav/sidebar-model';
import { ENV_LABEL } from '../lib/env';
import './nav/sidebar.css';

// Spec 027: no menu literals here. The menu is the registry (nav/registry.ts)
// resolved against the owner's saved menu (nav/resolve.ts); "More tools" lists the
// hidden pages of that same resolved menu (nav/sidebar-model.ts moreTools).

/** Whether "More tools" is open (a per-viewer convenience: localStorage, never required). */
const MORE_KEY = 'dashboard:nav-more';
const readMoreOpen = () => { try { return localStorage.getItem(MORE_KEY) === 'open'; } catch { return false; } };

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
  /** Ends the session. Absent when there is none to end (the dev-bypass identity): no Log out button. */
  onLogout?: () => void;
}

export function AppSidebar({ isMobile = false, mobileOpen = false, onNavigate, collapsed = false, onToggleCollapsed, onLogout }: Props) {
  const toggle = () => onToggleCollapsed?.();

  const nav = useResolvedNav();
  const navigate = useNavigate();
  const loc = useRouterState({ select: (s) => s.location });
  const href = loc.href;
  /** FR-008: the constructor, remembering this page for "Add current page". */
  const editMenu = (itemId?: string) => {
    onNavigate?.();
    void navigate({
      to: '/app/settings',
      search: { tab: 'navigation', ...(itemId ? { edit: itemId } : {}), ...(href.startsWith('/app/settings') ? {} : { from: href }) },
    });
  };
  const quick = useQuickNavEdit();
  const [ctx, setCtx] = useState<{ item: ResolvedItem; x: number; y: number; more: boolean } | null>(null);
  const closeCtx = useCallback(() => setCtx(null), []);
  const [rail, setRail] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null);
  const closeRail = useCallback(() => setRail(null), []);

  // FR-010: live counters (and the spec 031 approvals count).
  const counts = useNavBadgeCounts();
  // FR-011: counters of hidden pages roll up into a dot on "More tools".
  // Pages whose count the menu already shows (e.g. the posts to approve inside the Inbox) are skipped.
  const visible = [...nav.pinned, ...nav.groups.flatMap((g) => g.items)];
  const more = useMemo(() => moreTools(nav), [nav]);
  // The dot speaks for the list it opens: sub-views are not in More tools, so their counters do not light it.
  const hiddenRollup = rollup(more, counts, shownKeys(visible));

  // The longest matching prefix wins, so /app/agents/inbox lights Inbox and not Agents.
  const activeId = activeItemId([...visible, ...more], { pathname: loc.pathname, search: loc.search as Record<string, unknown> });
  const activeInMore = !!activeId && more.some((i) => i.id === activeId) && !visible.some((i) => i.id === activeId);

  const [moreOpen, setMoreOpen] = useState<boolean>(readMoreOpen);
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    try { localStorage.setItem(MORE_KEY, next ? 'open' : 'closed'); } catch { /* ignore */ }
    // The list opens below the fold of a short window: bring it into view.
    if (next) requestAnimationFrame(() => document.getElementById('nav-more-panel')?.scrollIntoView({ block: 'nearest' }));
  };
  // Arriving on one of its pages opens it, so the current page is never hidden in a closed list.
  useEffect(() => { if (activeInMore) setMoreOpen(true); }, [activeId, activeInMore]);

  const pinnedIds = new Set(nav.pinned.map((i) => i.id));
  const pin = (item: ResolvedItem) => {
    if (!pinnedIds.has(item.id) && pinnedIds.size >= 10) { toast.error('You can pin up to 10 pages. Unpin one first.'); return; }
    quick.apply((c) => togglePin(c, item.id));
  };
  const hide = (item: ResolvedItem) => {
    if (quick.apply((c) => hideItem(c, item.id))) {
      toast.success(`${item.label} is hidden from the menu. The page still works; find it under More tools or with ⌘K.`);
    }
  };

  // On mobile the drawer is always full-width (never the collapsed rail).
  const isCollapsed = isMobile ? false : collapsed;
  const width = isMobile ? 264 : (collapsed ? 64 : 248);

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
      active={item.id === activeId}
      pinned={pinnedIds.has(item.id)}
      badge={badgeFor(item.badge, counts)}
      onNavigate={onNavigate}
      onTogglePin={pin}
      onContext={(it, x, y) => setCtx({ item: it, x, y, more: false })}
    />
  );

  const renderChip = (item: ResolvedItem) => {
    const b = badgeFor(item.badge, counts);
    const counter = b && b.count > 0 ? b : null;
    const active = item.id === activeId;
    return (
      <Link
        key={item.id}
        to={item.to as any}
        search={routerSearch(item.search) as any}
        activeOptions={{ exact: true }}
        className={active ? 'nav-chip nav-chip-active' : 'nav-chip'}
        aria-current={active ? 'page' : undefined}
        aria-label={counter ? `${item.label}, ${counter.title}` : undefined}
        title={counter?.title}
        onClick={onNavigate}
        onContextMenu={(e) => { e.preventDefault(); setCtx({ item, x: e.clientX, y: e.clientY, more: true }); }}
      >
        {item.label}
        {counter && <span className={`nav-chip-dot nav-chip-dot-${counter.tone}`} aria-hidden />}
      </Link>
    );
  };

  /** The rail has no room for chips: "More tools" opens a menu of the same pages, with their counters. */
  const railActions: NavMenuAction[] = more.map((item) => {
    const b = badgeFor(item.badge, counts);
    const counter = b && b.count > 0 ? b : null;
    return {
      label: item.label,
      icon: item.icon,
      title: counter?.title,
      meta: counter ? badgeText(counter.count) : undefined,
      onSelect: () => {
        onNavigate?.();
        void navigate({ to: item.to as any, search: routerSearch(item.search) as any });
      },
    };
  });

  const moreTitle = hiddenRollup ? `More tools. Needs attention:\n${hiddenRollup.title}` : 'More tools';
  const moreDot = hiddenRollup && (
    <span className="nav-dot" aria-hidden style={{ background: hiddenRollup.tone === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)' }} />
  );
  const moreSr = hiddenRollup && <span className="sr-only">. Needs attention: {hiddenRollup.title}</span>;

  const groupTitle = (title: string) => !isCollapsed && <div className="nav-group-title">{title}</div>;

  return (
    <aside style={style} aria-label="Main menu">
      <div className={`side-head${isCollapsed ? ' side-head-rail' : ''}`}>
        <div className="side-brand">
          <Link to={'/app' as any} activeOptions={{ exact: true }} onClick={onNavigate} className="side-logo" aria-label="ai0, go to Today">
            <span className="side-logo-dot" />
            {!isCollapsed && <span>ai0</span>}
          </Link>
          {ENV_LABEL && <span className="side-env" title={`Environment: ${ENV_LABEL}`}>{ENV_LABEL}</span>}
        </div>
        {isMobile ? (
          <button onClick={onNavigate} className="btn-icon" style={{ width: 32, height: 32 }} aria-label="Close menu">
            <Icon name="x" size={16} />
          </button>
        ) : (
          <button onClick={toggle} className="btn-icon" style={{ width: 28, height: 28 }}
            aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
          </button>
        )}
      </div>

      <nav className={`side-nav${isCollapsed ? ' side-nav-rail' : ''}`} aria-label="Pages">
        {nav.pinned.length > 0 && (
          <div className="nav-group" role="group" aria-label="Pinned">
            {groupTitle('Pinned')}
            {nav.pinned.map((item) => renderItem(item, 'pinned'))}
          </div>
        )}
        {nav.groups.map((g, i) => (
          <div key={g.id} className="nav-group" role="group" aria-label={g.title}>
            {showGroupTitle(g, i, nav.pinned.length > 0) && groupTitle(g.title)}
            {g.items.map((item) => renderItem(item, g.id))}
          </div>
        ))}

        {more.length > 0 && (isCollapsed ? (
          <div className="nav-group nav-more">
            <button type="button" className="nav-link nav-more-btn" style={{ justifyContent: 'center' }}
              aria-haspopup="menu" aria-expanded={!!rail} aria-label={hiddenRollup ? `More tools. Needs attention: ${hiddenRollup.title.replace(/\n/g, '; ')}` : 'More tools'}
              title={moreTitle}
              onClick={(e) => {
                const anchor = e.currentTarget;
                const r = anchor.getBoundingClientRect();
                setRail((open) => (open ? null : { x: r.right + 8, y: r.top, anchor }));
              }}>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <Icon name="ellipsis" size={16} />
                {moreDot}
              </span>
            </button>
          </div>
        ) : (
          <div className="nav-group nav-more">
            <button type="button" className="nav-link nav-more-btn" aria-expanded={moreOpen} aria-controls="nav-more-panel"
              title={hiddenRollup ? moreTitle : undefined} onClick={toggleMore}>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <Icon name="ellipsis" size={16} />
                {moreDot}
              </span>
              <span className="nav-label">More tools</span>
              {moreSr}
              <Icon name="chevron-right" size={14} className="nav-more-chev" />
            </button>
            <div id="nav-more-panel" className="nav-chips" hidden={!moreOpen}>
              {more.map(renderChip)}
            </div>
          </div>
        ))}
      </nav>

      <div className={`side-foot${isCollapsed ? ' side-foot-rail' : ''}`}>
        {!isCollapsed && <BudgetCard onNavigate={onNavigate} />}
        <OperatorRow collapsed={isCollapsed} onLogout={onLogout} onEditMenu={() => editMenu()} />
      </div>

      {rail && (
        <NavContextMenu x={rail.x} y={rail.y} title="More tools" anchor={rail.anchor} onClose={closeRail} actions={railActions} />
      )}
      {ctx && (
        <NavContextMenu
          x={ctx.x} y={ctx.y} title={ctx.item.label} onClose={closeCtx}
          actions={[
            pinnedIds.has(ctx.item.id)
              ? { label: 'Unpin', icon: 'pin-off', onSelect: () => pin(ctx.item) }
              : { label: 'Pin to the top', icon: 'pin', onSelect: () => pin(ctx.item), disabled: !!ctx.item.unavailable },
            // A page under More tools is already hidden: the menu settings are where it gets a place.
            ctx.more
              ? { label: 'Edit in menu settings…', icon: 'pencil', onSelect: () => editMenu(ctx.item.id) }
              : {
                  label: 'Hide from the menu', icon: 'eye-off', onSelect: () => hide(ctx.item),
                  disabled: !canHide(ctx.item.id), title: canHide(ctx.item.id) ? undefined : `${ctx.item.label} is always shown`,
                },
            ...(ctx.more ? [] : [{ label: 'Rename…', icon: 'pencil' as const, onSelect: () => editMenu(ctx.item.id) }]),
          ]}
        />
      )}
    </aside>
  );
}
