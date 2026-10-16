// Shared modal shell. Renders backdrop + surface-2 card with the level-2
// elevation treatment. Clicking the backdrop closes; clicks inside the shell
// bubble up but don't propagate to the backdrop. Press Escape to close.
//
// Pulls all three modals (AddBotModal, AddChannelModal, EditThemesModal) into
// one place — they used three different backdrop alphas, three different
// surfaces, three different radii before.

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Icon as UiIcon, type IconName } from './ui/Icon';

interface Props {
  open:     boolean;
  onClose:  () => void;
  title?:   string;
  /** Optional secondary line under the title (e.g. context). */
  subtitle?: string;
  /** Optional leading glyph in the header — matches the SectionCard headers. */
  icon?:    IconName;
  /** Wider variants: lg for theme-pickers and dense forms, xl for side-by-side editors. */
  size?:    'md' | 'lg' | 'xl';
  children: ReactNode;
}

// Open modals, oldest first: Escape closes only the top one (a confirm opened from a details dialog
// closes alone, not together with the dialog under it).
const openStack: symbol[] = [];

export function Modal({ open, onClose, title, subtitle, icon, size = 'md', children }: Props) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = Symbol('modal');
    openStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = openStack.indexOf(id);
      if (at >= 0) openStack.splice(at, 1);
    };
  }, [open]);

  if (!open) return null;

  // Portal to <body> so the fixed backdrop escapes any transformed ancestor
  // (a CSS transform on a parent — e.g. row hover-lift / entrance animation —
  // would otherwise become the containing block and trap this fixed overlay
  // inside the row instead of covering the viewport).
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={size === 'md' ? 'modal-shell' : `modal-shell modal-shell-${size}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {title !== undefined && (
          <div className="modal-head">
            {icon && <span className="section-glyph"><UiIcon name={icon} size={15} /></span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && (
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-ink)' }}>
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="text-micro" style={{ margin: '3px 0 0', color: 'var(--color-ink-muted)' }}>
                  {subtitle}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="btn-icon"
              style={{ width: 32, height: 32, flexShrink: 0 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
