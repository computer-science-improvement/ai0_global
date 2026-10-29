// Spec 078 B1: Today's "Needs you" panel. Card-rows in a flush panel (a row holds buttons, so it is not a CompactCard):
// the critical and action notes (top 4) with the note's own buttons (NoteActions) and Dismiss, then one row for the posts
// waiting for approval and one for cards waiting in a chat. Nothing to do → "All clear".

import { useMemo, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { SeverityPill } from '../ui/Pills';
import { NoteActions } from '../inbox/NoteActions';
import { indexTree } from '../agents/AgentsUi';
import { useAgentTree, type InboxItem } from '../../api/agents';
import { ago } from '../../lib/map-state';
import type { NeedsYou } from './useNeedsYou';
import './today.css';

const NOTE_ICON: Record<InboxItem['severity'], IconName> = { critical: 'warning', action: 'bell', info: 'info' };

function NoteRow({ item, handle, now, onDone, onDismiss }: {
  item: InboxItem; handle: string | null; now: Date; onDone: () => void; onDismiss: () => void;
}) {
  const meta = [item.kind, handle ? `@${handle}` : null, ago(item.createdAt, now)].filter(Boolean).join(' · ');
  return (
    <div className="panel-row need-row" aria-label={`${item.severity} note: ${item.title}`}>
      <span className={`need-icon is-${item.severity}`} aria-hidden="true"><Icon name={NOTE_ICON[item.severity] ?? 'info'} size={18} /></span>
      <div className="need-main">
        <div className="need-meta">
          <SeverityPill severity={item.severity} />
          <span className="mono need-kind">{meta}</span>
        </div>
        <div className="need-title">{item.title}</div>
        {item.body && <div className="need-body clamp">{item.body}</div>}
      </div>
      <div className="need-actions">
        <NoteActions item={item} size="sm" onDone={onDone} />
        <Button type="button" variant="ghost" size="sm" aria-label={`Dismiss: ${item.title}`} onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  );
}

/** A queue the owner works through on another page: posts to approve, cards waiting in a chat. */
function QueueRow({ icon, title, body, action }: { icon: IconName; title: string; body: string; action: ReactNode }) {
  return (
    <div className="panel-row need-row">
      <span className="need-icon is-action" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <div className="need-main">
        <div className="need-title" style={{ marginTop: 0 }}>{title}</div>
        <div className="need-body">{body}</div>
      </div>
      <div className="need-actions">{action}</div>
    </div>
  );
}

export function NeedsYouList({ needs, now, delay }: { needs: NeedsYou; now: Date; delay?: number }) {
  const tree = useAgentTree();
  const byId = useMemo(() => indexTree(tree.data?.agents), [tree.data]);
  const { rows, approvals, chatCards, unreadNotes, inboxCount } = needs;
  const queues = approvals > 0 || chatCards > 0;
  // Only approvals waiting: the Unread list would be empty, so the link goes where the work is.
  const inboxSearch = unreadNotes === 0 && approvals > 0 ? 'approvals' : 'unread';

  return (
    <SectionCard
      title="Needs you"
      flush
      delay={delay}
      action={
        <Link to="/app/agents/inbox" search={{ tab: inboxSearch }} className="panel-link">
          Open inbox{inboxCount > 0 ? ` · ${inboxCount}` : ''} →
        </Link>
      }
    >
      {rows.map((item) => (
        <NoteRow
          key={item.id}
          item={item}
          handle={item.agentId ? byId.get(item.agentId)?.handle ?? null : null}
          now={now}
          onDone={() => needs.hide(item.id)}
          onDismiss={() => { void needs.dismiss(item); }}
        />
      ))}
      {approvals > 0 && (
        <QueueRow
          icon="check"
          title={approvals === 1 ? '1 post to approve' : `${approvals} posts to approve`}
          body="Agents in approval mode wrote these. Read them, then approve, edit or reject."
          action={<Link to="/app/agents/inbox" search={{ tab: 'approvals' }} className="btn-primary btn-sm">Review posts</Link>}
        />
      )}
      {chatCards > 0 && (
        <QueueRow
          icon="chat"
          title={chatCards === 1 ? '1 action waits for your confirmation' : `${chatCards} actions wait for your confirmation`}
          body="An agent proposed a change in a chat and needs your yes or no."
          action={<Link to="/app/chat" className="btn-secondary btn-sm">Open chat</Link>}
        />
      )}

      {rows.length === 0 && !queues && (
        needs.failed ? (
          <EmptyState icon="warning" title="Your notes could not be loaded"
            note="The server did not answer. The rest of the page still works."
            action={<Button type="button" variant="secondary" size="sm" onClick={needs.retry}>Try again</Button>} />
        ) : !needs.loaded ? (
          <p className="text-caption ink-muted" role="status" style={{ margin: 0, padding: '28px 20px', textAlign: 'center' }}>Loading what needs you…</p>
        ) : (
          <EmptyState tone="clear" title="All clear for today" note="Agents keep working. New decisions will show up here." />
        )
      )}
      {needs.failed && queues && (
        <div className="panel-foot text-micro ink-muted">
          Notes could not be loaded.
          <Button type="button" variant="ghost" size="sm" onClick={needs.retry}>Try again</Button>
        </div>
      )}
      {needs.openCount > rows.length && (
        <div className="panel-foot text-micro ink-muted">
          {needs.openCount - rows.length} more {needs.openCount - rows.length === 1 ? 'note needs' : 'notes need'} you in the inbox.
        </div>
      )}
    </SectionCard>
  );
}
