import type { InboxItemInput } from '../editor/agents/owner-inbox';
import { localDate } from '../editor/roles/time';
import type { OpenOrderRow, SponsorOrdersRepository } from './sponsor-orders.repository';

/**
 * Spec 036: paid-but-unpublished ad orders. Read-only listing for the CLI (`ads:stuck-orders`), and a check that
 * runs at startup and daily: every newly stuck order is flagged once (ad_orders.flag_reason) and the new ones
 * are posted as ONE Inbox action (+ admin-bot alert). Nothing is refunded or published automatically.
 */

const KYIV = 'Europe/Kyiv';
const DAY_MS = 86_400_000;

export type StuckReason = 'no_publish_date' | 'day_passed' | 'slot_failed' | 'not_scheduled' | 'approval_pending';

export const STUCK_TEXT: Record<StuckReason, string> = {
  no_publish_date:  'digest sponsor without a publish date — no digest can pick it up',
  day_passed:       'digest sponsor day is over and it was not published (no digest ran with it)',
  slot_failed:      'its reserved slot failed or was skipped',
  not_scheduled:    'paid, the publish time passed more than a day ago and it was never scheduled',
  approval_pending: 'the schedule_post action was never approved (or failed) and the publish time passed',
};

export interface StuckOrder extends OpenOrderRow { reason: StuckReason }

/** Why an open (paid / scheduled, unpublished) order is stuck at `now`; null = it still has a path to publication. */
export function stuckReason(o: OpenOrderRow, now: Date): StuckReason | null {
  if (o.slotStatus === 'failed' || o.slotStatus === 'skipped') return 'slot_failed';
  if (o.editorSlotId) return null; // planned / running: the reserved lane publishes it (or fails it with an alert)
  if (o.format === 'digest_sponsor') {
    if (!o.publishAt) return 'no_publish_date';
    return localDate(o.publishAt, KYIV) < localDate(now, KYIV) ? 'day_passed' : null;
  }
  const due = (o.publishAt ?? o.paidAt ?? o.createdAt).getTime() < now.getTime() - DAY_MS;
  if (o.status === 'paid') return o.publishAt && due ? 'not_scheduled' : null;
  // scheduled without a slot: an approved action went to the scheduled_posts queue (posted, no report — spec 008);
  // a pending / rejected / failed one never will.
  if (o.actionStatus && ['pending', 'rejected', 'failed'].includes(o.actionStatus) && due) return 'approval_pending';
  return null;
}

export async function findStuckOrders(repo: Pick<SponsorOrdersRepository, 'openOrders'>, now: Date): Promise<StuckOrder[]> {
  const out: StuckOrder[] = [];
  for (const o of await repo.openOrders()) {
    const reason = stuckReason(o, now);
    if (reason) out.push({ ...o, reason });
  }
  return out;
}

const fmtTime = (d: Date | null) => (d ? `${localDate(d, KYIV)}` : 'no date');

/** One line per order (owner-facing, English). */
export function stuckLine(o: StuckOrder): string {
  return `• «${o.advertiser}» · ${o.format ?? 'custom'} · ${o.channelKey ?? 'no channel'} · ${o.amount} ${o.currency} · ${o.status} · publish ${fmtTime(o.publishAt)} — ${STUCK_TEXT[o.reason]} [${o.id}]`;
}

export function formatStuck(list: StuckOrder[]): string {
  if (!list.length) return 'No paid ad order is stuck.';
  return [`${list.length} paid ad order(s) not published:`, ...list.map(stuckLine)].join('\n');
}

export interface StuckCheckDeps {
  orders: Pick<SponsorOrdersRepository, 'openOrders' | 'flag'>;
  inbox:  { post(i: InboxItemInput): Promise<number> };
  log?:   (m: string) => void;
}

/** Flag the stuck orders (once per reason) and post the new ones as one Inbox action. Returns the new ones. */
export async function runStuckCheck(d: StuckCheckDeps, now: Date): Promise<StuckOrder[]> {
  const stuck = await findStuckOrders(d.orders, now);
  const fresh: StuckOrder[] = [];
  for (const o of stuck) {
    if (await d.orders.flag(o.id, o.reason)) fresh.push(o);
  }
  if (!fresh.length) return fresh;
  try {
    await d.inbox.post({
      kind: 'ad_orders_stuck', severity: 'action',
      title: `💰 ${fresh.length} paid ad order(s) were not published`,
      body: `${formatStuck(fresh)}\n\nNothing is refunded or published automatically: reschedule, publish by hand or settle with the advertiser on /app/ads.`,
      alert: {
        title: `💰 ${fresh.length} оплачених рекламних замовлень не вийшли`,
        body: 'Список в Inbox. Нічого не повертається і не публікується автоматично — перенеси, опублікуй вручну або домовся з рекламодавцем.',
      },
      refType: 'ad_order', refId: fresh.length === 1 ? fresh[0].id : null,
    });
  } catch (err: any) {
    d.log?.(`stuck ad orders inbox post failed: ${err?.message ?? err}`);
  }
  return fresh;
}
