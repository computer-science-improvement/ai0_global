// Spec 078 B2: the selected note of the Inbox page, in the right-hand pane (wide) and in the bottom sheet (narrow):
// severity and kind, who and when, the title, "What happened" (the note's body), "Why it matters" (lib/inbox-kinds), the
// buttons (NoteActions + Mark as done), the earlier notes about the same problem and a "Technical details" toggle.
// Styles: ./inbox.css.

import { useId, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { SeverityPill } from '../ui/Pills';
import { NoteActions } from './NoteActions';
import { fmtDate, fmtRelative } from '../../lib/format';
import { planNote, planSteps } from '../../lib/inbox-kinds';
import { agentLabel, isUnread, notes, techLines, type NoteGroup } from '../../lib/inbox-view';
import type { AgentNode, InboxItem } from '../../api/agents';

export interface InboxDetailProps {
  item:      InboxItem;
  /** The row the note belongs to; more than one note = earlier notes about the same problem. */
  group:     NoteGroup<InboxItem>;
  agent:     AgentNode | null;
  /** The agent tree, for the "why it matters" text and the buttons. */
  tree:      AgentNode[] | undefined;
  /** `pane` shows the title itself; in the `sheet` the dialog head already shows it. */
  variant:   'pane' | 'sheet';
  busy:      boolean;
  /** "Mark as done" of the note's row (every unread note of it). */
  onMarkDone:   (ids: number[]) => void;
  onMarkUnread: (ids: number[]) => void;
  /** NoteActions marked the note read by its own "Got it" (not by a decision): the page offers Undo. */
  onGotIt:      (item: InboxItem) => void;
  /** Select another note of the same row. */
  onPick:       (id: number) => void;
}

export function InboxDetail({ item, group, agent, tree, variant, busy, onMarkDone, onMarkUnread, onGotIt, onPick }: InboxDetailProps) {
  const plan = useMemo(() => planNote(item, { tree }), [item, tree]);
  const unread = isUnread(item);
  // A plan with a "Got it" step already has a way to mark the note done: do not add a second, identical button.
  const hasGotIt = useMemo(() => planSteps(plan).some((s) => s.type === 'read'), [plan]);
  const [techOpen, setTechOpen] = useState(false);
  const techId = useId();
  const unreadIds = group.items.filter(isUnread).map((n) => n.id);

  return (
    <div className="inbox-detail">
      <div className="inbox-detail-meta">
        <SeverityPill severity={item.severity} />
        <span className="inbox-kind mono">{item.kind}</span>
        <span className="inbox-meta-text mono">
          {agent && <><Link to="/app/agents/$handle" params={{ handle: agent.handle }} className="link-accent">{agentLabel(agent, true)}</Link>{' · '}</>}
          <time dateTime={item.createdAt} title={fmtDate(item.createdAt)}>{fmtRelative(item.createdAt)}</time>
        </span>
        {!unread && <Badge tone="neutral">Done</Badge>}
      </div>

      {variant === 'pane' && <h2 className="inbox-detail-title">{item.title}</h2>}

      <div className="inbox-facts">
        <div className="inset">
          <div className="text-overline">What happened</div>
          <p className="inbox-fact-text">{item.body || 'No details.'}</p>
        </div>
        <div className="inset">
          <div className="text-overline">Why it matters</div>
          <p className="inbox-fact-text">{plan.why}</p>
        </div>
      </div>

      <div className="inbox-actions">
        <NoteActions item={item} size="md" onRead={() => onGotIt(item)} />
        {unread && !hasGotIt && (
          <Button variant="ghost" disabled={busy} onClick={() => onMarkDone(unreadIds.length ? unreadIds : [item.id])}>Mark as done</Button>
        )}
        {!unread && (
          <Button variant="ghost" disabled={busy} onClick={() => onMarkUnread([item.id])}>Mark as unread</Button>
        )}
      </div>

      {group.items.length > 1 && (
        <div className="inbox-history">
          <div className="text-overline">{`Same problem, ${notes(group.items.length)}`}</div>
          <div className="inbox-history-list">
            {group.items.slice(0, 8).map((n) => (
              <button key={n.id} type="button" className="inbox-history-row" aria-current={n.id === item.id ? 'true' : undefined} onClick={() => onPick(n.id)}>
                <span className="inbox-history-title clamp" style={{ ['--clamp' as string]: 1 }}>{n.title}</span>
                <span className="mono inbox-history-when" title={fmtDate(n.createdAt)}>{fmtRelative(n.createdAt)}</span>
              </button>
            ))}
          </div>
          {group.items.length > 8 && <div className="text-micro ink-dim" style={{ marginTop: 6 }}>{`and ${group.items.length - 8} older`}</div>}
        </div>
      )}

      <div className="inbox-tech">
        <button type="button" className="inbox-tech-toggle" aria-expanded={techOpen} aria-controls={techId} onClick={() => setTechOpen((v) => !v)}>
          <span className={`inbox-chev${techOpen ? ' is-open' : ''}`}><Icon name="chevron-right" size={14} /></span>
          Technical details
        </button>
        {techOpen && <pre id={techId} className="code-block anim-fade-up">{techLines(item)}</pre>}
      </div>
    </div>
  );
}
