import type { EditorCard } from '../editor/card';
import type { InboxItemInput } from '../editor/agents/owner-inbox';
import type { ReserveSlotInput } from '../editor/repo/editor-plans.repository';
import { lintSponsored, SponsoredCreative, SponsoredCreativeSchema } from '../editor/post/sponsored';
import { isQuietHour, localDate, localHour, localTimeLabel, zonedToUtc } from '../editor/roles/time';
import { instancesOn, parseCadence } from '../editor/network/series';
import { weekdayOf } from '../editor/schedule/schedule-rules';
import { shortCampaign, withUtm } from './ad-report';
import type { SponsorOrder, SponsorOrdersRepository } from './sponsor-orders.repository';

/**
 * Spec 036: a paid `digest_sponsor` order is never silently lost.
 *
 * While an enabled legacy digest binding (network-digest / topic-digest) publishes to the order's channel, the
 * strategy embeds the "Партнер дайджесту" line on the order's day (spec 008 T006) and nothing here acts. When
 * no digest strategy runs there (spec 023 cutover retired it, or it was paused or never bound), the order is
 * placed in the RESERVED lane as a standalone sponsored post — deterministic, no LLM, outside approval mode
 * (spec 031) and resource pauses (spec 025), with the code-added #реклама label — 10 minutes after the agent's
 * digest-like series (source `network_highlights`) on that day, else at the order's own time moved out of the
 * channel's quiet hours. An order that cannot be placed is flagged once per reason (Inbox action + admin-bot
 * alert). Orders whose day is already over are left to the stuck-order check: never published late.
 */

const KYIV = 'Europe/Kyiv';

/** Minutes after the agent's digest instance the sponsor post goes out. */
export const AFTER_DIGEST_MIN = 10;
/** Orders are placed at most this far ahead (the agent's playbook may still change before that). */
export const PLACE_HORIZON_MS = 48 * 3600_000;
/** The reserved lane picks a slot up on the next minute tick. */
const ASAP_MS = 60_000;

export type FlagReason = 'no_channel' | 'no_publish_date' | 'no_agent_card' | 'no_creative' | 'no_link' | 'creative_invalid' | 'missed_day';

/** Owner-facing (English) explanation of a flag reason. */
export const FLAG_TEXT: Record<FlagReason, string> = {
  no_channel:       'the order names no channel',
  no_publish_date:  'the order has no publish date',
  no_agent_card:    'no digest strategy runs on the channel and it has no agent card, so nothing can publish the sponsor',
  no_creative:      'the order has no ad creative',
  no_link:          'the creative has no link (CTA or button) for the sponsor',
  creative_invalid: 'the ad creative does not pass the sponsored-post checks',
  missed_day:       'no time is left on the ordered day to publish it',
};

/** Telegram alert wording (the owner's admin-bot alerts stay Ukrainian). */
const FLAG_TEXT_UK: Record<FlagReason, string> = {
  no_channel:       'у замовленні немає каналу',
  no_publish_date:  'у замовленні немає дати публікації',
  no_agent_card:    'на каналі немає ні стратегії-дайджесту, ні картки агента — опублікувати спонсора нікому',
  no_creative:      'у замовленні немає рекламного креативу',
  no_link:          'у креативі немає посилання (CTA або кнопки)',
  creative_invalid: 'креатив не проходить перевірку рекламного поста',
  missed_day:       'на замовлений день уже не лишилося часу для публікації',
};

export type SponsorCard = Pick<EditorCard, 'timezone' | 'quietStartHour' | 'quietEndHour' | 'linkStyle' | 'language'>;

export interface SponsorFulfilmentPorts {
  orders:  Pick<SponsorOrdersRepository, 'openDigestSponsors' | 'digestSponsorsOn' | 'digestSponsorPricesOn' | 'digestCadences' | 'place' | 'dropSlot' | 'flag'>;
  card:    (channelKey: string) => Promise<SponsorCard | null>;
  reserve: (i: ReserveSlotInput) => Promise<string>;
  inbox:   { post(i: InboxItemInput): Promise<number> };
  log?:    (m: string) => void;
}

/** The order's creative as the sponsor post: the advertiser's link(s) get ai0 UTM tags like the digest line. */
export function sponsorCreative(orderId: string, raw: unknown): { creative: SponsoredCreative } | { reason: FlagReason } {
  if (raw == null) return { reason: 'no_creative' };
  const p = SponsoredCreativeSchema.safeParse(raw);
  if (!p.success) return { reason: 'creative_invalid' };
  const c = p.data;
  if (!c.cta?.url && !c.buttons?.[0]?.[0]?.url) return { reason: 'no_link' };
  const camp = shortCampaign(orderId);
  return {
    creative: {
      ...c,
      ...(c.cta ? { cta: { ...c.cta, url: withUtm(c.cta.url, camp) } } : {}),
      buttons: c.buttons.map((row) => row.map((b) => ({ ...b, url: withUtm(b.url, camp) }))),
    },
  };
}

/**
 * When the standalone sponsor post goes out (pure). The day is the order's publish date in the channel's zone.
 *   1. the agent's first digest-like series instance that day + 10 min, if still ahead;
 *   2. else the order's own time, moved to the end of the quiet hours when it falls inside them;
 *   3. a time already past → as soon as possible, but only on the same day and outside quiet hours.
 * Null when nothing is left of the day.
 */
export function sponsorPostTime(i: { publishAt: Date; now: Date; tz: string; quiet: { start: number; end: number }; cadences: string[] }): Date | null {
  const { tz, now } = i;
  const day = localDate(i.publishAt, tz);
  const quiet = (d: Date) => isQuietHour(localHour(d, tz), i.quiet.start, i.quiet.end);
  const quietEnd = zonedToUtc(day, `${String(i.quiet.end).padStart(2, '0')}:00`, tz);
  const sameDay = (d: Date) => localDate(d, tz) === day;

  const digest = i.cadences
    .map(parseCadence).filter((c): c is NonNullable<typeof c> => !!c)
    .flatMap((c) => instancesOn(c, weekdayOf(day)))
    .map((t) => new Date(zonedToUtc(day, t, tz).getTime() + AFTER_DIGEST_MIN * 60_000))
    .filter((d) => sameDay(d) && d.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (digest) return digest;

  let at = i.publishAt;
  if (quiet(at)) at = quietEnd;
  if (at.getTime() > now.getTime()) return sameDay(at) ? at : null;

  const asap = new Date(now.getTime() + ASAP_MS);
  if (!sameDay(asap)) return null;
  if (!quiet(asap)) return asap;
  return quietEnd.getTime() > asap.getTime() && sameDay(quietEnd) ? quietEnd : null;
}

export type Assessment =
  | { kind: 'legacy' }
  | { kind: 'past' }
  | { kind: 'later' }
  | { kind: 'flag'; reason: FlagReason }
  | { kind: 'place'; at: Date; creative: SponsoredCreative; card: SponsorCard };

export interface FulfilmentResult { placed: number; flagged: number }

export class SponsorFulfilment {
  constructor(private readonly d: SponsorFulfilmentPorts) {}

  /** What will happen to one open order (no side effects). */
  async assess(o: SponsorOrder, now: Date): Promise<Assessment> {
    if (!o.channelKey) return { kind: 'flag', reason: 'no_channel' };
    // The legacy digest needs a date and a link too (it silently skips an order without them).
    if (!o.publishAt) return { kind: 'flag', reason: 'no_publish_date' };
    const cr = sponsorCreative(o.id, o.creative);
    if ('reason' in cr) return { kind: 'flag', reason: cr.reason };
    if (o.digestRuns) return { kind: 'legacy' };
    const card = await this.d.card(o.channelKey);
    if (!card) return { kind: 'flag', reason: 'no_agent_card' };
    const lint = lintSponsored(cr.creative, card, { advertiser: o.advertiser, sponsorLabel: o.sponsorLabel });
    if (!lint.ok) return { kind: 'flag', reason: 'creative_invalid' };
    const tz = card.timezone;
    const day = localDate(o.publishAt, tz);
    if (day < localDate(now, tz)) return { kind: 'past' };
    if (zonedToUtc(day, '00:00', tz).getTime() - now.getTime() > PLACE_HORIZON_MS) return { kind: 'later' };
    const at = sponsorPostTime({
      publishAt: o.publishAt, now, tz, quiet: { start: card.quietStartHour, end: card.quietEndHour },
      cadences: await this.d.orders.digestCadences(o.channelKey),
    });
    if (!at) return { kind: 'flag', reason: 'missed_day' };
    return { kind: 'place', at, creative: cr.creative, card };
  }

  /**
   * The reserved-lane tick (every minute, before the dispatcher publishes): place what is due, flag what
   * cannot be placed. Never throws for one order.
   */
  async reserveDue(now: Date): Promise<FulfilmentResult> {
    const out: FulfilmentResult = { placed: 0, flagged: 0 };
    for (const o of await this.d.orders.openDigestSponsors()) {
      try {
        const a = await this.assess(o, now);
        if (a.kind === 'flag') {
          if (await this.flag(o, a.reason)) out.flagged++;
        } else if (a.kind === 'place') {
          if (await this.place(o, a)) out.placed++;
        }
      } catch (err: any) {
        this.d.log?.(`digest sponsor ${o.id}: ${err?.message ?? err}`);
      }
    }
    return out;
  }

  private async place(o: SponsorOrder, a: Extract<Assessment, { kind: 'place' }>): Promise<boolean> {
    const key = o.channelKey!;
    const slotId = await this.d.reserve({
      channelKey: key, planDate: localDate(a.at, a.card.timezone), scheduledAt: a.at, format: a.creative.format,
      topic: `Реклама: ${o.advertiser}`.slice(0, 300), sourceHints: [`ad_order:${o.id}`, 'digest_sponsor'], postSpec: a.creative,
    });
    if (!(await this.d.orders.place(o.id, slotId, a.at))) {
      await this.d.orders.dropSlot(slotId, 'ad order already placed');
      return false;
    }
    const when = `${localDate(a.at, a.card.timezone)} ${localTimeLabel(a.at, a.card.timezone)}`;
    await this.post({
      kind: 'ad_order_placed', severity: 'info',
      title: `💰 Digest sponsor «${o.advertiser}» on ${key} goes out as a sponsored post at ${when}`,
      body: `No digest strategy runs on ${key} any more, so the paid digest sponsor is published as a standalone post marked #реклама `
        + `in the reserved lane (approval mode and pauses do not hold paid ads). Tell the advertiser if the format matters to them.`,
      alert: {
        title: `💰 Спонсор дайджесту «${o.advertiser}» у ${key} вийде окремим рекламним постом о ${when}`,
        body: 'Дайджест-стратегія на каналі більше не працює, тож оплачене спонсорство публікується окремим постом із #реклама.',
      },
      refType: 'ad_order', refId: o.id,
    });
    return true;
  }

  private async flag(o: SponsorOrder, reason: FlagReason): Promise<boolean> {
    if (!(await this.d.orders.flag(o.id, reason))) return false;
    const where = o.channelKey ?? 'no channel';
    await this.post({
      kind: 'ad_order_unfulfilled', severity: 'action',
      title: `💰 Paid digest sponsor «${o.advertiser}» (${where}) cannot be published: ${FLAG_TEXT[reason]}`,
      body: `Fix the order on /app/ads (channel, publish date, creative) or settle it with the advertiser. `
        + `It is not refunded or published automatically.`,
      alert: {
        title: `⚠️ Оплачений спонсор дайджесту «${o.advertiser}» (${where}) не може вийти: ${FLAG_TEXT_UK[reason]}`,
        body: 'Виправ замовлення на /app/ads або домовся з рекламодавцем. Автоматично нічого не повертається і не публікується.',
      },
      refType: 'ad_order', refId: o.id,
    });
    return true;
  }

  /**
   * Spec 036 at cutover: the digest bindings of `channelKeys` were just retired. Every open digest_sponsor order
   * there (sold or paid) and every static sponsor of a retired binding is reported in one Inbox action, with
   * what will happen to it. Returns the number of items reported (0 = nothing posted).
   */
  async reportCutover(i: {
    channelKeys: string[]; agentId?: string | null; handle?: string | null; now: Date;
    staticSponsors?: Array<{ extId: string; channelKey: string; text: string; url: string }>;
  }): Promise<number> {
    const orders = await this.d.orders.digestSponsorsOn(i.channelKeys);
    const prices = await this.d.orders.digestSponsorPricesOn(i.channelKeys);
    const statics = i.staticSponsors ?? [];
    if (!orders.length && !statics.length && !prices.length) return 0;
    const lines: string[] = [];
    for (const o of orders) {
      const day = o.publishAt ? localDate(o.publishAt, KYIV) : 'no date';
      let fate: string;
      if (o.status === 'draft' || o.status === 'awaiting_payment') fate = 'not paid yet; once paid it goes out as a standalone sponsored post';
      else {
        const a = await this.assess(o, i.now);
        fate = a.kind === 'flag' ? `CANNOT be published: ${FLAG_TEXT[a.reason]}`
          : a.kind === 'legacy' ? 'still embedded by a digest strategy on this channel'
          : a.kind === 'past' ? 'its day is over — see the stuck-order check'
          : 'goes out as a standalone sponsored post (#реклама) on its day';
        if (a.kind === 'flag') await this.d.orders.flag(o.id, a.reason).catch(() => false);
      }
      lines.push(`• «${o.advertiser}» on ${o.channelKey} (${day}, ${o.status}): ${fate}`);
    }
    for (const s of statics) {
      lines.push(`• static digest sponsor of ${s.extId} on ${s.channelKey} («${s.text.slice(0, 60)}», ${s.url}) is no longer published — the agent's series has no sponsor slot`);
    }
    for (const p of prices) {
      lines.push(`• the digest sponsor price of ${p.channelKey} (${p.priceUah} UAH) is no longer offered on the landing, the media kit or in DM price lists`);
    }
    await this.post({
      agentId: i.agentId ?? null, kind: 'sponsor_cutover', severity: 'action',
      title: `💰 ${i.handle ? `@${i.handle}: ` : ''}digest strategies retired on ${i.channelKeys.join(', ')} — check the digest sponsors`,
      body: lines.join('\n'),
      alert: {
        title: `💰 Дайджест-стратегії вимкнено на ${i.channelKeys.join(', ')} — перевір спонсорів дайджесту`,
        body: `Замовлень: ${orders.length}, статичних спонсорів: ${statics.length}. Деталі в Inbox.`,
      },
      refType: 'agent', refId: i.handle ?? null,
    });
    return lines.length;
  }

  private async post(i: InboxItemInput): Promise<void> {
    try { await this.d.inbox.post(i); } catch (err: any) { this.d.log?.(`inbox post failed: ${err?.message ?? err}`); }
  }
}
