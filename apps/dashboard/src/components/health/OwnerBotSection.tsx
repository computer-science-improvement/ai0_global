// Spec 012 FR-007: the owner bot on /app/health — whether it is on and polling, its cards (open, queued, sent today),
// what waits by kind, when the daily summary and the weekly report last went out; a test card and the reports sent now.
// The settings live in Settings → Configuration → Telegram.

import { Link } from '@tanstack/react-router';
import { SectionCard, StatTile } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useOwnerBot, useOwnerBotReport, useOwnerBotTestCard } from '../../api/owner-bot';
import { botStatus, kindText } from '../../lib/owner-bot';

const when = (iso: string | null) => (iso ? <span title={fmtDate(iso)}>{fmtRelative(iso)}</span> : 'never');

export function OwnerBotSection({ delay }: { delay?: number }) {
  const q = useOwnerBot();
  const test = useOwnerBotTestCard();
  const report = useOwnerBotReport();

  const body = (() => {
    if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
    if (!q.data) return <div style={{ height: 120, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />;
    const s = q.data;
    const st = botStatus(s);
    const ready = s.configured.token && s.configured.owner;
    const waiting = s.waiting.filter((w) => w.count > 0);
    const send = (kind: 'daily' | 'weekly') => report.mutate(kind, {
      onSuccess: () => toast.success(kind === 'daily' ? "Today's summary sent to Telegram" : 'Weekly report sent to Telegram'),
      onError: (e) => toast.error(describeError(e)),
    });
    return (
      <>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <Badge tone={st.tone}>{st.label}</Badge>
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
            Last update from Telegram {when(s.polling.lastUpdateAt)} · polled {when(s.polling.lastPollAt)}
          </span>
        </div>
        {st.note && <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginBottom: 12 }}>{st.note}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 12 }}>
          <StatTile label="Open cards" value={s.cards.open} icon="inbox" />
          <StatTile label="Queued" value={s.cards.queued} icon="clock" />
          <StatTile label="Sent today" value={s.cards.sentToday} icon="telegram" />
          <StatTile label="Not sent today" value={s.cards.failedToday} icon="warning"
            delta={s.cards.failedToday ? 'Telegram refused them 5 times' : undefined} deltaTone={s.cards.failedToday ? 'danger' : 'neutral'} />
        </div>

        <div className="text-micro" style={{ display: 'grid', gap: 4, color: 'var(--color-ink-muted)', marginBottom: 14 }}>
          <div>
            <span style={{ color: 'var(--color-ink-dim)' }}>Waiting for you: </span>
            {waiting.length ? waiting.map((w) => kindText(w.kind, w.count)).join(' · ') : 'nothing'}
          </div>
          <div>
            <span style={{ color: 'var(--color-ink-dim)' }}>Daily summary: </span>
            {s.settings.dailyAt === 'off' ? 'off' : `${s.settings.dailyAt} Kyiv`} · last sent {when(s.reports.dailyAt)}
          </div>
          <div>
            <span style={{ color: 'var(--color-ink-dim)' }}>Weekly report: </span>
            {s.settings.weeklyAt === 'off' ? 'off' : `${s.settings.weeklyAt} Kyiv`} · last sent {when(s.reports.weeklyAt)}
          </div>
          <div>
            <span style={{ color: 'var(--color-ink-dim)' }}>Delivery: </span>
            {s.settings.quietHours === 'off' ? 'no quiet hours' : `quiet hours ${s.settings.quietHours.replace('-', '–')} Kyiv (critical cards still go)`} · up to {s.settings.maxPerHour} cards an hour
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="secondary" style={{ gap: 6 }} disabled={!ready || test.isPending}
            onClick={() => test.mutate(undefined, { onSuccess: () => toast.success('Test card sent: tap its button in Telegram'), onError: (e) => toast.error(describeError(e)) })}>
            <Icon name="telegram" size={14} /> {test.isPending ? 'Sending…' : 'Send a test card'}
          </Button>
          <Button variant="ghost" disabled={!ready || report.isPending} onClick={() => send('daily')}>Send today's summary</Button>
          <Button variant="ghost" disabled={!ready || report.isPending} onClick={() => send('weekly')}>Send the weekly report</Button>
        </div>
      </>
    );
  })();

  return (
    <SectionCard title="Owner bot" icon="bots" delay={delay} style={{ marginBottom: 16 }}
      action={<Link to="/app/settings" search={{ tab: 'configuration', group: 'telegram' } as any} className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>Settings</Link>}>
      {body}
    </SectionCard>
  );
}
