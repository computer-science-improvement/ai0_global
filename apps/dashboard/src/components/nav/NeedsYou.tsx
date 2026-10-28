import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavAttention, type NavAttention } from '../../api/nav';
import { usePendingAction } from '../../api/agents';
import { describeError, toast } from '../ui/Toast';
import { ActionCard, FocusedCardContext } from '../chat/ActionCard';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { SeverityPill } from '../ui/Pills';
import { fmtDate, fmtRelative } from '../../lib/format';
import './needs-you.css';
// An ActionCard opened from here (CardOpener) shows its dialog on /app/agents too: its classes live in chat.css.
import '../chat/chat.css';

type Source = 'inbox' | 'directives' | 'chatCards';

/**
 * The items behind a menu counter, on top of the page the counter leads to: the owner sees at once what waits
 * and opens it with one click. Renders nothing when nothing waits.
 */
export function NeedsYou({ show, currentChatId, style }: { show: Source[]; currentChatId?: string; style?: React.CSSProperties }) {
  const q = useNavAttention();
  // `n` remounts the card so a second click opens it again after its dialog was closed.
  const [card, setCard] = useState<{ id: string; n: number } | null>(null);
  const openCard = (id: string) => setCard((c) => ({ id, n: (c?.n ?? 0) + 1 }));
  const d = q.data;
  if (!d) return null;
  const rows: ReactNode[] = [];
  let total = 0;

  if (show.includes('inbox') && d.inbox.total) {
    total += d.inbox.total;
    for (const i of d.inbox.items) {
      rows.push(
        <Row key={`i${i.id}`} icon="inbox" to="/app/agents/inbox" search={{ tab: 'unread' }}
          badge={<SeverityPill severity={i.severity} />}
          title={i.title} meta={meta(i.agentHandle, i.createdAt)} />,
      );
    }
    if (d.inbox.total > d.inbox.items.length) rows.push(<More key="i+" to="/app/agents/inbox" search={{ tab: 'unread' }} n={d.inbox.total - d.inbox.items.length} what="Inbox notes" />);
  }
  if (show.includes('directives') && d.directives.total) {
    total += d.directives.total;
    for (const x of d.directives.items) {
      rows.push(
        <Row key={`d${x.id}`} icon="agents" to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: x.id }}
          badge={<Badge tone="danger">{x.status === 'contested' ? 'Contested' : 'Your decision'}</Badge>}
          title={x.body} meta={meta(x.agentHandle, x.createdAt, `directive · ${x.kind}`)} />,
      );
    }
  }
  if (show.includes('chatCards') && d.chatCards.total) {
    total += d.chatCards.total;
    for (const c of d.chatCards.items) {
      const label = c.chatId === currentChatId ? 'this chat' : c.chatTitle ? `chat «${c.chatTitle}»` : 'chat';
      rows.push(c.chatId
        ? <Row key={`c${c.id}`} icon="chat" to="/app/chat" search={{ c: c.chatId, card: c.id }}
            badge={<Badge tone="warning">Confirm</Badge>} title={c.summary || c.kind.replace(/_/g, ' ')} meta={meta(c.agentHandle, c.createdAt, label)} />
        // A card made outside a chat (@manager, a data suggestion, a migration) has no page of its own: it opens here.
        : <Row key={`c${c.id}`} icon="chat" onClick={() => openCard(c.id)}
            badge={<Badge tone="warning">Confirm</Badge>} title={c.summary || c.kind.replace(/_/g, ' ')} meta={meta(c.agentHandle, c.createdAt)} />);
    }
  }
  const dialog = card && <CardOpener key={card.n} id={card.id} />;
  if (!total) return dialog || null;

  return (
    <>
    {dialog}
    <section className="panel is-section is-flush needs-you compose-rise" aria-label="Waiting for you" style={{ marginBottom: 16, ...style }}>
      <div className="panel-head">
        <Icon name="warning" size={15} />
        <h2 className="text-heading-md" style={{ margin: 0 }}>Waiting for you</h2>
        <Badge tone="warning">{total}</Badge>
      </div>
      {rows}
    </section>
    </>
  );
}

/**
 * A confirmation card opened by id: the card's own dialog (details, Apply / Discard) opens at once — the compact card
 * itself stays hidden, the dialog portals to the page.
 */
function CardOpener({ id }: { id: string }) {
  const q = usePendingAction(id);
  useEffect(() => { if (q.error) toast.error(describeError(q.error)); }, [q.error]);
  if (!q.data) return null;
  return (
    <div hidden>
      <FocusedCardContext.Provider value={id}><ActionCard action={q.data} /></FocusedCardContext.Provider>
    </div>
  );
}

function meta(handle: string | null, at: string, what?: string): ReactNode {
  return (
    <>
      {what && <>{what} · </>}
      {handle && <><span className="mono">@{handle}</span> · </>}
      <span className="mono" title={fmtDate(at)}>{fmtRelative(at)}</span>
    </>
  );
}

function Row({ icon, to, params, search, onClick, badge, title, meta }: {
  icon: IconName; to?: string; params?: Record<string, string>; search?: Record<string, unknown>; onClick?: () => void;
  badge: ReactNode; title: string; meta: ReactNode;
}) {
  const body = (
    <>
      <span className="needs-you-lead" aria-hidden><Icon name={icon} size={15} /></span>
      <span className="needs-you-main">
        <span className="needs-you-line">
          {badge}
          <span className="text-body-sm needs-you-title">{title}</span>
        </span>
        <span className="text-micro needs-you-meta">{meta}</span>
      </span>
      <Icon name="chevron-right" size={14} />
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="panel-row needs-you-row">{body}</button>
    : <Link to={to as any} params={params as any} search={search as any} className="panel-row needs-you-row">{body}</Link>;
}

function More({ to, search, n, what }: { to: string; search?: Record<string, unknown>; n: number; what: string }) {
  return (
    <div className="panel-foot">
      <Link to={to as any} search={search as any} className="panel-link" style={{ padding: 0 }}>
        +{n} more {what} →
      </Link>
    </div>
  );
}

/** Chats that hold a card waiting for the owner (the chat list marks them). */
export function chatsWaiting(d: NavAttention | undefined): Set<string> {
  return new Set((d?.chatCards.items ?? []).map((c) => c.chatId).filter((x): x is string => !!x));
}
