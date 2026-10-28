// Spec 078 B2: the left side of the Inbox page, a flush panel of selectable rows: a severity mark, the title, who and
// what kind, the age. Repeats of one problem (same subject) are one row with a "x3" count. Styles: ./inbox.css.

import type { ReactNode } from 'react';
import { SeverityMark } from '../ui/Pills';
import { fmtDate, fmtRelative } from '../../lib/format';
import { isUnread, notes, type NoteGroup } from '../../lib/inbox-view';
import type { InboxItem } from '../../api/agents';

export function InboxList({ groups, selectedKey, onSelect, showUnreadDot, popup, whoOf, footer, label = 'Inbox notes' }: {
  groups:        ReadonlyArray<NoteGroup<InboxItem>>;
  /** The row that is open in the detail pane / sheet, or null. */
  selectedKey:   string | null;
  onSelect:      (head: InboxItem) => void;
  /** Mark the rows that are unread (only useful when read notes are listed too). */
  showUnreadDot: boolean;
  /** The rows open a dialog (the narrow layout). */
  popup:         boolean;
  /** The agent label of a note ("🚀 @space"), or null. */
  whoOf:         (it: InboxItem) => string | null;
  /** A line under the rows ("Showing the 200 newest notes"). */
  footer?:       ReactNode;
  label?:        string;
}) {
  return (
    <section className="panel is-section is-flush inbox-list" aria-label={label}>
      {groups.map((g) => {
        const it = g.head;
        const selected = g.key === selectedKey;
        const unread = g.items.some(isUnread);
        const who = whoOf(it);
        return (
          <button key={g.key} type="button"
            className={`panel-row inbox-row${selected ? ' is-selected' : ''}${unread ? '' : ' is-read'}`}
            aria-current={selected ? 'true' : undefined}
            aria-haspopup={popup ? 'dialog' : undefined}
            onClick={() => onSelect(it)}>
            <span className="inbox-row-mark"><SeverityMark severity={it.severity} /></span>
            <span className="inbox-row-main">
              <span className="inbox-row-title clamp">{it.title}</span>
              <span className="inbox-row-meta mono">{who ? `${who} · ${it.kind}` : it.kind}</span>
            </span>
            <span className="inbox-row-side">
              <span className="inbox-row-when mono" title={fmtDate(it.createdAt)}>{fmtRelative(it.createdAt)}</span>
              {g.items.length > 1 && <span className="inbox-count mono" title={`${notes(g.items.length)} about this`}>{`x${g.items.length}`}</span>}
              {showUnreadDot && unread && <span className="inbox-unread-dot" role="img" aria-label="Unread" title="Unread" />}
            </span>
          </button>
        );
      })}
      {footer && <div className="panel-foot text-micro" style={{ color: 'var(--color-ink-dim)' }}>{footer}</div>}
    </section>
  );
}
