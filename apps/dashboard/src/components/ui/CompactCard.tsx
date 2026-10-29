// A compact card that opens a details dialog — the one pattern for lists of rich items (directives,
// posts to approve, ideas, reviews…): the card shows the key facts and a couple of lines, the dialog has
// everything else and the actions. See apps/dashboard/CLAUDE.md "Compact cards".

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { Icon, type IconName } from './Icon';

export interface CompactDialog {
  title:     string;
  subtitle?: string;
  icon?:     IconName;
  size?:     'md' | 'lg' | 'xl';
  /** The dialog body; `close` closes it (call it after an action that settles the item). */
  body:      (close: () => void) => ReactNode;
  /** Actions pinned at the bottom of the dialog. */
  actions?:  (close: () => void) => ReactNode;
}

interface Props {
  /** Badges and chips on the first line. */
  top?:      ReactNode;
  /** Right-aligned on the first line (usually the time). */
  meta?:     ReactNode;
  title?:    ReactNode;
  /** Text clamped to `lines` lines. */
  body?:     ReactNode;
  lines?:    number;
  /** Anything else under the body (a thumbnail row, chips); keep it to one line. */
  extra?:    ReactNode;
  /** A short line that asks for attention ("Needs your approval"). */
  note?:     ReactNode;
  noteTone?: 'warning' | 'danger';
  /** Ring: attention (warning) when the owner is needed, focus when deep-linked. */
  attention?: boolean;
  /** Deep link: scroll to the card and open its dialog. */
  focused?:  boolean;
  delay?:    number;
  id?:       string;
  /** Hover title of the card button. */
  hint?:     string;
  style?:    CSSProperties;
  dialog:    CompactDialog;
}

export function CompactCard({
  top, meta, title, body, lines = 2, extra, note, noteTone = 'warning', attention = false, focused = false,
  delay = 0, id, hint = 'Open the details', style, dialog,
}: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setOpen(true);
  }, [focused]);

  const close = () => setOpen(false);
  const ring = focused ? 'var(--color-accent)' : attention ? 'var(--color-warning-soft)' : null;
  const noteInk = noteTone === 'danger' ? 'ink-danger' : 'ink-warning';

  return (
    <>
      <button ref={ref} type="button" id={id} className="card row-lift compose-rise compact-card" onClick={() => setOpen(true)}
        aria-haspopup="dialog" title={hint}
        style={{ animationDelay: `${delay}ms`, boxShadow: ring ? `inset 0 0 0 1px ${ring}` : undefined, ...style }}>
        {(top || meta) && (
          <span className="compact-card-top">
            {top}
            {meta && <span className="text-micro ink-dim" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{meta}</span>}
          </span>
        )}
        {title && <span className="compact-card-title">{title}</span>}
        {body && (
          <span className={title ? 'text-body-sm clamp ink-muted' : 'text-body-sm clamp'} style={{ ['--clamp' as string]: lines }}>
            {body}
          </span>
        )}
        {extra}
        {note && (
          <span className={`text-micro ${noteInk}`} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <Icon name="warning" size={12} /> {note}
          </span>
        )}
      </button>
      <Modal open={open} onClose={close} size={dialog.size ?? 'lg'} icon={dialog.icon} title={dialog.title} subtitle={dialog.subtitle}>
        {open && dialog.body(close)}
        {open && dialog.actions && <div className="modal-foot">{dialog.actions(close)}</div>}
      </Modal>
    </>
  );
}

/** Plain text of an HTML preview for a clamped card line (tags dropped, entities decoded, whitespace folded). */
export function plainText(html: string | null | undefined): string {
  if (!html) return '';
  const noTags = html.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|blockquote)>/gi, ' ').replace(/<[^>]+>/g, '');
  return noTags
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
