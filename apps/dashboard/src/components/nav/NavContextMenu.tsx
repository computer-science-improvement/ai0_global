import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../ui/Icon';

export interface NavMenuAction {
  label:     string;
  icon:      IconName;
  onSelect:  () => void;
  disabled?: boolean;
  title?:    string;
}

/**
 * Spec 027 FR-009: the small menu a sidebar item opens on right click or long
 * press. Fixed at the pointer (kept on screen), closes on outside click,
 * Escape, scroll or resize; ↑/↓ move between actions.
 */
export function NavContextMenu({ x, y, title, actions, onClose }: {
  x: number; y: number; title?: string; actions: NavMenuAction[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const onDown = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    };
    const close = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 220));
  const top = Math.max(8, Math.min(y, window.innerHeight - (actions.length * 34 + 44)));

  return createPortal(
    <div ref={ref} role="menu" aria-label={title ?? 'Menu item actions'} className="nav-ctx" style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="nav-ctx-title">{title}</div>}
      {actions.map((a) => (
        <button key={a.label} type="button" role="menuitem" className="nav-ctx-item" disabled={a.disabled} title={a.title}
          onClick={() => { onClose(); a.onSelect(); }}>
          <Icon name={a.icon} size={14} /> {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
