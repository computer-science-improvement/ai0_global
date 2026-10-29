// Spec 012 FR-007: the owner bot on /app/health — whether it is on and polling, its cards (open, queued, sent today),
// what waits by kind, when the daily summary and the weekly report last went out; a test card and the reports sent now.
// The settings live in Settings → Configuration → Telegram.
// Spec 078 C2: a flush panel of rows (status, the four numbers, key / value rows) with the actions in its foot.

import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useOwnerBot, useOwnerBotReport, useOwnerBotTestCard } from '../../api/owner-bot';
import { botStatus, kindText } from '../../lib/owner-bot';
import './health.css';

const when = (iso: string | null) => (iso ? <span title={fmtDate(iso)}>{fmtRelative(iso)}</span> : 'never');

function Kv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="panel-row hl-kv">
      <span className="text-overline hl-kv-key">{label}</span>
      <span className="hl-kv-value">{children}</span>
    </div>
  );
}

function Num({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="hl-num">
      <span className="text-overline">{label}</span>
      <span className="hl-num-value">{value}</span>
      {note && <span className="hl-num-note">{note}</span>}
    </div>
  );
}

export function OwnerBotSection({ delay }: { delay?: number }) {
  const q = useOwnerBot();
  const test = useOwnerBotTestCard();
  const report = useOwnerBotReport();

  const body = (() => {
    if (q.error) return <div className="hl-pad"><div className="callout-danger" role="alert">{describeError(q.error)}</div></div>;
    if (!q.data) return <div className="hl-pad"><div className="hl-skeleton" aria-busy="true" style={{ height: 120 }} /></div>;
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
        <div className="panel-row hl-bot-status">
          <Badge tone={st.tone}>{st.label}</Badge>
          <span className="hl-muted">
            Last update from Telegram {when(s.polling.lastUpdateAt)} · polled {when(s.polling.lastPollAt)}
          </span>
        </div>
        {st.note && (
          <div className="hl-botnote">
            <div className={st.tone === 'danger' ? 'callout-danger' : 'callout-warning'} role={st.tone === 'danger' ? 'alert' : undefined}>{st.note}</div>
          </div>
        )}

        <div className="hl-nums">
          <Num label="Open cards" value={s.cards.open} />
          <Num label="Queued" value={s.cards.queued} />
          <Num label="Sent today" value={s.cards.sentToday} />
          <Num label="Not sent today" value={s.cards.failedToday} note={s.cards.failedToday ? 'Telegram refused them 5 times' : undefined} />
        </div>

        <Kv label="Waiting for you">{waiting.length ? waiting.map((w) => kindText(w.kind, w.count)).join(' · ') : 'nothing'}</Kv>
        <Kv label="Daily summary">{s.settings.dailyAt === 'off' ? 'off' : `${s.settings.dailyAt} Kyiv`} · last sent {when(s.reports.dailyAt)}</Kv>
        <Kv label="Weekly report">{s.settings.weeklyAt === 'off' ? 'off' : `${s.settings.weeklyAt} Kyiv`} · last sent {when(s.reports.weeklyAt)}</Kv>
        <Kv label="Delivery">
          {s.settings.quietHours === 'off' ? 'no quiet hours' : `quiet hours ${s.settings.quietHours.replace('-', '–')} Kyiv (critical cards still go)`} · up to {s.settings.maxPerHour} cards an hour
        </Kv>

        <div className="panel-foot">
          <Button variant="secondary" size="sm" disabled={!ready || test.isPending}
            onClick={() => test.mutate(undefined, { onSuccess: () => toast.success('Test card sent: tap its button in Telegram'), onError: (e) => toast.error(describeError(e)) })}>
            <Icon name="telegram" size={14} /> {test.isPending ? 'Sending…' : 'Send a test card'}
          </Button>
          <Button variant="secondary" size="sm" disabled={!ready || report.isPending} onClick={() => send('daily')}>Send today's summary</Button>
          <Button variant="secondary" size="sm" disabled={!ready || report.isPending} onClick={() => send('weekly')}>Send the weekly report</Button>
        </div>
      </>
    );
  })();

  return (
    <SectionCard title="Owner bot" icon="bots" flush delay={delay} style={{ marginBottom: 16 }}
      action={<Link to="/app/settings" search={{ tab: 'configuration', group: 'telegram' } as any} className="panel-link">Settings →</Link>}>
      {body}
    </SectionCard>
  );
}
