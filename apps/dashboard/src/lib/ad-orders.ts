// Pure helpers of /app/ads (spec 078 C6): names and tones of an ad order's status, why a paid order is flagged, and the
// counts above the order list. Ad orders are their own domain, so their tones are not in lib/status-tone.ts (which
// covers editor slots and scheduled publications). Node-tested in ad-orders.test.ts.

import type { Tone } from '../components/ui/primitives';
import type { AdOrder, AdOrderStatus } from '../api/types';

/** Owner-facing names of the order states, in the order a deal goes through them. */
export const ORDER_STATUS_LABEL: Record<AdOrderStatus, string> = {
  draft: 'Draft', awaiting_payment: 'Awaiting payment', paid: 'Paid', scheduled: 'Scheduled',
  published: 'Published', reported: 'Reported', canceled: 'Canceled',
};

export const ORDER_STATUS_TONE: Record<AdOrderStatus, Tone> = {
  draft: 'neutral', awaiting_payment: 'neutral', paid: 'success', scheduled: 'accent',
  published: 'success', reported: 'accent', canceled: 'warning',
};

/** Spec 036: why a paid order is flagged (ad_orders.flag_reason). */
const FLAG_LABEL: Record<string, string> = {
  no_channel:       'no channel',
  no_publish_date:  'no publish date',
  no_agent_card:    'no digest and no agent card',
  no_creative:      'no creative',
  no_link:          'no sponsor link',
  creative_invalid: 'creative invalid',
  missed_day:       'day missed',
  day_passed:       'day passed, not published',
  slot_failed:      'slot failed',
  not_scheduled:    'never scheduled',
  approval_pending: 'action not approved',
};

/** "no creative"; a reason this build does not know is shown with its underscores turned into spaces. */
export const flagLabel = (reason: string): string => FLAG_LABEL[reason] ?? reason.replace(/_/g, ' ');

/** A flag only matters while the order is still to be published (paid or scheduled). */
export const isFlagged = (o: Pick<AdOrder, 'status' | 'flag_reason'>): boolean =>
  !!o.flag_reason && (o.status === 'paid' || o.status === 'scheduled');

/**
 * The counts above the list: orders waiting for the advertiser's payment (draft or awaiting payment), paid ones the owner
 * still has to schedule, scheduled ones, flagged ones (they need the owner), and the ones already out (published or reported).
 */
export function summarizeOrders(orders: ReadonlyArray<Pick<AdOrder, 'status' | 'flag_reason'>>) {
  const n = (...s: AdOrderStatus[]) => orders.filter((o) => s.includes(o.status)).length;
  return {
    total: orders.length,
    awaitingPayment: n('draft', 'awaiting_payment'),
    paid: n('paid'),
    scheduled: n('scheduled'),
    out: n('published', 'reported'),
    flagged: orders.filter(isFlagged).length,
  };
}
