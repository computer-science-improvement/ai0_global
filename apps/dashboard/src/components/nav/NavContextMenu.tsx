import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../ui/Icon';

export interface NavMenuAction {
  label:     string;
  icon:      IconName;
  onSelect:  () => void;
  disabled?: boolean;
  title?:    string;
  /** A short right-aligned note, e.g. a counter ("3"); its meaning goes in `title`. */
  meta?:     string;
}

/**
 * Spec 027 FR-009: the small menu a sidebar item opens on right click or long
 * press. Fixed at the pointer (kept on screen), closes on outside click,
 * Escape, page scroll or resize; ↑/↓ move between actions. `anchor`: the button
 * that opened it (a press on it is its own toggle, not an outside click). Focus
 * goes back to the anchor, or to what had it before, when the menu closes.
 */
export function NavContextMenu({ x, y, title, actions, onClose, anchor }: {
  x: number; y: number; title?: string; actions: NavMenuAction[]; onClose: () => void; anchor?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const back = anchor ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    const first = ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const inside = (t: EventTarget | null) => t instanceof Node && (!!ref.current?.contains(t) || !!anchor?.contains(t));
    const onDown = (e: Event) => { if (!inside(e.target)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    };
    const close = () => onClose();
    // A long list scrolls inside the menu; only a scroll of the page around it closes the menu.
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
      // The focused item is gone with the menu; put focus back where the owner was, unless they clicked somewhere else.
      const now = document.activeElement;
      if (back?.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
    };
  }, [onClose, anchor]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 220));
  // A long list (the rail's "More tools") scrolls inside the viewport instead of running off it.
  const room = window.innerHeight - 16;
  const top = Math.max(8, Math.min(y, window.innerHeight - Math.min(actions.length * 34 + 44, room) - 8));

  return createPortal(
    <div ref={ref} role="menu" aria-label={title ?? 'Menu item actions'} className="nav-ctx" style={{ left, top, maxHeight: room, overflowY: 'auto' }}
      onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="nav-ctx-title">{title}</div>}
      {actions.map((a) => (
        <button key={a.label} type="button" role="menuitem" className="nav-ctx-item" disabled={a.disabled} title={a.title}
          onClick={() => { onClose(); a.onSelect(); }}>
          <Icon name={a.icon} size={14} /> {a.label}
          {a.meta && <span className="nav-ctx-meta tabular-nums">{a.meta}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
