// Shared modal shell. Renders backdrop + surface-2 card with the level-2
// elevation treatment. Clicking the backdrop closes; clicks inside the shell
// bubble up but don't propagate to the backdrop. Press Escape to close.
//
// Pulls all three modals (AddBotModal, AddChannelModal, EditThemesModal) into
// one place — they used three different backdrop alphas, three different
// surfaces, three different radii before.

import { useEffect, type ReactNode } from 'react';
import { Icon } from './Icon';

interface Props {
  open:     boolean;
  onClose:  () => void;
  title?:   string;
  /** Optional secondary line under the title (e.g. context). */
  subtitle?: string;
  /** Wider variant for theme-pickers and similar dense modals. */
  size?:    'md' | 'lg';
  children: ReactNode;
}

export function Modal({ open, onClose, title, subtitle, size = 'md', children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={size === 'lg' ? 'modal-shell modal-shell-lg' : 'modal-shell'}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {title !== undefined && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            marginBottom: subtitle ? 4 : 16, gap: 12,
          }}>
            {title && <h2 className="text-headline" style={{ margin: 0 }}>{title}</h2>}
            <button
              onClick={onClose}
              aria-label="Close"
              className="btn-icon"
              style={{ width: 32, height: 32 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {subtitle && (
          <p className="text-caption" style={{ margin: 0, marginBottom: 16, color: 'var(--color-ink-muted)' }}>
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
