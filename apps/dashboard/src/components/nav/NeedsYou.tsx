import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavAttention, type NavAttention } from '../../api/nav';
import { usePendingAction } from '../../api/agents';
import { describeError, toast } from '../ui/Toast';
import { ActionCard, FocusedCardContext } from '../chat/ActionCard';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { fmtDate, fmtRelative } from '../../lib/format';

type Source = 'inbox' | 'directives' | 'chatCards';

const SEVERITY_TONE = { critical: 'danger', action: 'warning', info: 'neutral' } as const;
const SEVERITY_LABEL = { critical: 'Critical', action: 'Action', info: 'Info' } as const;

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
          badge={<Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge>}
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
    <section className="panel compose-rise" aria-label="Waiting for you"
      style={{ padding: 12, marginBottom: 16, boxShadow: 'inset 3px 0 0 var(--color-warning)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon name="warning" size={15} />
        <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>Waiting for you</span>
        <Badge tone="warning">{total}</Badge>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{rows}</div>
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
      {[what, handle ? `@${handle}` : null].filter(Boolean).join(' · ')}
      {(what || handle) && ' · '}
      <span title={fmtDate(at)}>{fmtRelative(at)}</span>
    </>
  );
}

function Row({ icon, to, params, search, onClick, badge, title, meta }: {
  icon: IconName; to?: string; params?: Record<string, string>; search?: Record<string, unknown>; onClick?: () => void;
  badge: ReactNode; title: string; meta: ReactNode;
}) {
  const style = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', textDecoration: 'none', color: 'inherit', minWidth: 0 } as const;
  const body = (
    <>
      <span className="section-glyph" style={{ width: 26, height: 26, flexShrink: 0 }}><Icon name={icon} size={13} /></span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {badge}
          <span className="text-body-sm" style={{ color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{title}</span>
        </span>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)', display: 'block', marginTop: 2 }}>{meta}</span>
      </span>
      <Icon name="chevron-right" size={14} />
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="card row-lift" style={{ ...style, width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer' }}>{body}</button>
    : <Link to={to as any} params={params as any} search={search as any} className="card row-lift" style={style}>{body}</Link>;
}

function More({ to, search, n, what }: { to: string; search?: Record<string, unknown>; n: number; what: string }) {
  return (
    <Link to={to as any} search={search as any} className="text-caption" style={{ color: 'var(--color-accent)', padding: '2px 10px' }}>
      +{n} more {what} →
    </Link>
  );
}

/** Chats that hold a card waiting for the owner (the chat list marks them). */
export function chatsWaiting(d: NavAttention | undefined): Set<string> {
  return new Set((d?.chatCards.items ?? []).map((c) => c.chatId).filter((x): x is string => !!x));
}
