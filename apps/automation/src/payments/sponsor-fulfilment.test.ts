import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SponsorFulfilment, sponsorCreative, sponsorPostTime, AFTER_DIGEST_MIN } from './sponsor-fulfilment';
import type { SponsorOrder } from './sponsor-orders.repository';
import { makeCard } from '../editor/post/testing/fixtures';
import { ReservedDispatcher } from '../editor/publish/reserved-dispatcher';
import { SponsoredPublisher } from '../editor/publish/sponsored.publisher';
import { AD_LABEL } from '../editor/post/sponsored';

// Kyiv is UTC+3 on these October 2026 dates (EEST until 25 Oct).
const TZ = 'Europe/Kyiv';
const QUIET = { start: 23, end: 8 };
const at = (iso: string) => new Date(iso);
const CREATIVE = {
  format: 'text', body: [{ type: 'p', text: '**Курс** програмування для дорослих.' }],
  cta: { url: 'https://kurs.example/start', label: 'Записатися' },
};

function order(over: Partial<SponsorOrder> = {}): SponsorOrder {
  return {
    id: '1a2b3c4d-0000-4000-8000-000000000001', advertiser: 'Курс', sponsorLabel: 'ФОП Коваль', status: 'paid', creative: CREATIVE,
    publishAt: at('2026-10-12T09:00:00Z'), channelKey: '@chan', digestRuns: false, flagReason: null, ...over,
  };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

test('sponsorCreative: the advertiser link gets ai0 UTM tags (CTA and buttons); no creative / no link is a reason', () => {
  const r = sponsorCreative('1a2b3c4d-0000-4000-8000-000000000001', { ...CREATIVE, buttons: [[{ text: 'Сайт', url: 'https://kurs.example/' }]] });
  assert.ok('creative' in r);
  assert.match(r.creative.cta!.url, /utm_source=ai0&utm_medium=telegram&utm_campaign=1a2b3c4d/);
  assert.match(r.creative.buttons[0][0].url, /utm_campaign=1a2b3c4d/);
  assert.deepEqual(sponsorCreative('x', null), { reason: 'no_creative' });
  assert.deepEqual(sponsorCreative('x', { format: 'text', body: [{ type: 'p', text: 'Без посилання' }] }), { reason: 'no_link' });
  assert.deepEqual(sponsorCreative('x', { format: 'text', body: [], hashtags: ['x'] }), { reason: 'creative_invalid' });
});

test('sponsorPostTime: 10 minutes after the agent\'s digest series instance that day', () => {
  const t = sponsorPostTime({ publishAt: at('2026-10-12T05:00:00Z'), now: at('2026-10-11T12:00:00Z'), tz: TZ, quiet: QUIET, cadences: ['daily@19:00'] });
  assert.equal(t!.toISOString(), `2026-10-12T16:${String(AFTER_DIGEST_MIN).padStart(2, '0')}:00.000Z`); // 19:10 Kyiv
  // a weekly digest on another weekday does not count (12 Oct 2026 is a Monday)
  const w = sponsorPostTime({ publishAt: at('2026-10-12T09:00:00Z'), now: at('2026-10-11T12:00:00Z'), tz: TZ, quiet: QUIET, cadences: ['weekly:sun@19:00'] });
  assert.equal(w!.toISOString(), '2026-10-12T09:00:00.000Z');
});

test('sponsorPostTime: no digest series → the order\'s own time, moved out of quiet hours', () => {
  const own = sponsorPostTime({ publishAt: at('2026-10-12T09:00:00Z'), now: at('2026-10-11T12:00:00Z'), tz: TZ, quiet: QUIET, cadences: [] });
  assert.equal(own!.toISOString(), '2026-10-12T09:00:00.000Z');
  // 00:00 Kyiv (a "date only" order) → the end of quiet hours, 08:00 Kyiv
  const midnight = sponsorPostTime({ publishAt: at('2026-10-11T21:00:00Z'), now: at('2026-10-11T12:00:00Z'), tz: TZ, quiet: QUIET, cadences: [] });
  assert.equal(midnight!.toISOString(), '2026-10-12T05:00:00.000Z');
});

test('sponsorPostTime: a time already past → as soon as possible on the same day, never in quiet hours, null when the day is gone', () => {
  const asap = sponsorPostTime({ publishAt: at('2026-10-12T06:00:00Z'), now: at('2026-10-12T12:00:00Z'), tz: TZ, quiet: QUIET, cadences: ['daily@10:00'] });
  assert.equal(asap!.toISOString(), '2026-10-12T12:01:00.000Z');
  // 23:30 Kyiv: quiet now and the morning end of quiet hours is already behind → the day is gone
  assert.equal(sponsorPostTime({ publishAt: at('2026-10-12T06:00:00Z'), now: at('2026-10-12T20:30:00Z'), tz: TZ, quiet: QUIET, cadences: [] }), null);
});

// ── the reserved-lane tick ───────────────────────────────────────────────────

function harness(o: { orders?: SponsorOrder[]; card?: any; cadences?: string[]; placeOk?: boolean; flagNew?: boolean } = {}) {
  const calls = { reserve: [] as any[], place: [] as any[], drop: [] as any[], flag: [] as any[], inbox: [] as any[] };
  const flagged = new Map<string, string>();
  const f = new SponsorFulfilment({
    orders: {
      openDigestSponsors: async () => o.orders ?? [order()],
      digestSponsorsOn: async (keys: string[]) => (o.orders ?? [order()]).filter((x) => keys.includes(x.channelKey!)),
      digestSponsorPricesOn: async (keys: string[]) => keys.map((k) => ({ channelKey: k, priceUah: 400 })),
      digestCadences: async () => o.cadences ?? [],
      place: async (id: string, slotId: string, when: Date) => { calls.place.push({ id, slotId, when }); return o.placeOk ?? true; },
      dropSlot: async (slotId: string, why: string) => { calls.drop.push({ slotId, why }); },
      flag: async (id: string, reason: string) => {
        calls.flag.push({ id, reason });
        if (flagged.get(id) === reason) return false;
        flagged.set(id, reason);
        return true;
      },
    },
    card: async () => (o.card === undefined ? makeCard({ mode: 'approve' }) : o.card),
    reserve: async (i) => { calls.reserve.push(i); return 'slot-1'; },
    inbox: { post: async (i) => { calls.inbox.push(i); return 1; } },
  });
  return { f, calls };
}

test('agent-run channel: the paid digest sponsor is reserved as a sponsored post (UTM link, ad hints) and the owner is told', async () => {
  const h = harness({ cadences: ['daily@19:00'] });
  const r = await h.f.reserveDue(at('2026-10-12T07:00:00Z'));
  assert.deepEqual(r, { placed: 1, flagged: 0 });
  const slot = h.calls.reserve[0];
  assert.equal(slot.channelKey, '@chan');
  assert.equal(slot.planDate, '2026-10-12');
  assert.equal(slot.scheduledAt.toISOString(), '2026-10-12T16:10:00.000Z');
  assert.deepEqual(slot.sourceHints, ['ad_order:1a2b3c4d-0000-4000-8000-000000000001', 'digest_sponsor']);
  assert.match(slot.postSpec.cta.url, /utm_campaign=1a2b3c4d/);
  assert.equal(h.calls.place[0].slotId, 'slot-1');
  assert.equal(h.calls.inbox[0].kind, 'ad_order_placed');
  assert.match(h.calls.inbox[0].title, /standalone|sponsored post/);
});

test('a digest strategy still runs on the channel → nothing to do (the strategy embeds the sponsor line)', async () => {
  const h = harness({ orders: [order({ digestRuns: true })] });
  assert.deepEqual(await h.f.reserveDue(at('2026-10-12T07:00:00Z')), { placed: 0, flagged: 0 });
  assert.equal(h.calls.reserve.length + h.calls.inbox.length, 0);
});

test('unfulfillable order → flagged once per reason with an Inbox action (no card, no link, no date, no channel)', async () => {
  const h = harness({ card: null });
  const now = at('2026-10-12T07:00:00Z');
  assert.deepEqual(await h.f.reserveDue(now), { placed: 0, flagged: 1 });
  assert.deepEqual(await h.f.reserveDue(now), { placed: 0, flagged: 0 }, 'the same reason is not posted twice');
  assert.equal(h.calls.inbox.length, 1);
  assert.equal(h.calls.inbox[0].kind, 'ad_order_unfulfilled');
  assert.equal(h.calls.inbox[0].severity, 'action');
  assert.equal(h.calls.inbox[0].refId, order().id);
  assert.equal(h.calls.reserve.length, 0);

  for (const [o, reason] of [
    [order({ creative: { format: 'text', body: [{ type: 'p', text: 'x' }] } }), 'no_link'],
    [order({ publishAt: null, digestRuns: true }), 'no_publish_date'],
    [order({ channelKey: null }), 'no_channel'],
    [order({ creative: null, digestRuns: true }), 'no_creative'],
  ] as const) {
    const g = harness({ orders: [o] });
    await g.f.reserveDue(now);
    assert.deepEqual(g.calls.flag.map((x) => x.reason), [reason]);
  }
});

test('a past day is left to the stuck-order check (never published late); a far day is placed later', async () => {
  const past = harness({ orders: [order({ publishAt: at('2026-10-10T09:00:00Z') })] });
  assert.deepEqual(await past.f.reserveDue(at('2026-10-12T07:00:00Z')), { placed: 0, flagged: 0 });
  const far = harness({ orders: [order({ publishAt: at('2026-10-20T09:00:00Z') })] });
  assert.deepEqual(await far.f.reserveDue(at('2026-10-12T07:00:00Z')), { placed: 0, flagged: 0 });
  assert.equal(past.calls.reserve.length + far.calls.reserve.length, 0);
});

test('a lost placement race drops the extra slot', async () => {
  const h = harness({ placeOk: false });
  assert.deepEqual(await h.f.reserveDue(at('2026-10-12T07:00:00Z')), { placed: 0, flagged: 0 });
  assert.deepEqual(h.calls.drop, [{ slotId: 'slot-1', why: 'ad order already placed' }]);
});

test('cutover report: open orders, static sponsors and hidden prices in one Inbox action', async () => {
  const h = harness({ orders: [order(), order({ id: 'o2', advertiser: 'Без картки', status: 'awaiting_payment' })] });
  const n = await h.f.reportCutover({
    channelKeys: ['@chan'], agentId: 'a1', handle: 'chan_bot', now: at('2026-10-11T07:00:00Z'),
    staticSponsors: [{ extId: 'digest-1', channelKey: '@chan', text: 'Партнер', url: 'https://p.example' }],
  });
  assert.equal(n, 4);
  assert.equal(h.calls.inbox.length, 1);
  const item = h.calls.inbox[0];
  assert.equal(item.kind, 'sponsor_cutover');
  assert.equal(item.severity, 'action');
  assert.match(item.body, /«Курс» on @chan .*standalone sponsored post/);
  assert.match(item.body, /«Без картки».*not paid yet/);
  assert.match(item.body, /static digest sponsor of digest-1/);
  assert.match(item.body, /no longer offered/);

  const none = harness({ orders: [] });
  none.f = new SponsorFulfilment({ ...(none.f as any).d, orders: { ...(none.f as any).d.orders, digestSponsorPricesOn: async () => [] } });
  assert.equal(await none.f.reportCutover({ channelKeys: ['@chan'], now: at('2026-10-11T07:00:00Z') }), 0);
  assert.equal(none.calls.inbox.length, 0);
});

test('cutover report flags an order that cannot be fulfilled', async () => {
  const h = harness({ card: null });
  await h.f.reportCutover({ channelKeys: ['@chan'], now: at('2026-10-11T07:00:00Z') });
  assert.match(h.calls.inbox[0].body, /CANNOT be published/);
  assert.deepEqual(h.calls.flag.map((x) => x.reason), ['no_agent_card']);
});

// ── end to end through the reserved lane (fake publisher) ───────────────────

test('placed sponsor → ReservedDispatcher → SponsoredPublisher: published with #реклама despite approval mode and a resource pause', async () => {
  const slots: any[] = [];
  const h = harness({ cadences: ['daily@19:00'] });
  (h.f as any).d.reserve = async (i: any) => {
    slots.push({ id: 'slot-1', planId: 'p', channelKey: i.channelKey, scheduledAt: i.scheduledAt, kind: 'reserved', format: i.format,
      topic: i.topic, angle: null, sourceHints: i.sourceHints, isExperiment: false, status: 'planned', attempts: 0, runId: null,
      publishedPostId: null, postSpec: i.postSpec, renderedPreview: null, error: null });
    return 'slot-1';
  };
  await h.f.reserveDue(at('2026-10-12T07:00:00Z'));
  assert.equal(slots.length, 1);

  const sent: any[] = [];
  const marked: any[] = [];
  const o = order();
  const orders = {
    findBySlot: async () => ({ id: o.id, advertiser: o.advertiser, sponsorLabel: o.sponsorLabel, status: 'scheduled', creative: o.creative, format: 'digest_sponsor' }),
    markPublished: async (id: string, postId: number) => { marked.push({ id, postId }); },
  };
  const plans = {
    claimDueReserved: async (now: Date) => slots.filter((s) => s.status === 'planned' && s.scheduledAt <= now).map((s) => { s.status = 'running'; return s; }),
    updateSlot: async (id: string, patch: any) => { Object.assign(slots.find((s) => s.id === id), patch); },
    insertPublication: async () => 4242,
  };
  const notes: string[] = [];
  const dispatcher = new ReservedDispatcher({
    plans, orders,
    sponsored: new SponsoredPublisher({
      plans, orders, channels: { get: async () => makeCard({ mode: 'approve' }) },
      publisher: { send: async (k: string, m: any[]) => { sent.push({ k, m }); return { messageIds: [77] }; } },
      recordPublish: () => {}, notify: async (t) => { notes.push(t); },
    }),
    manual: { publishScheduled: async () => { throw new Error('not a manual post'); } },
    paused: async () => true, // every resource paused: paid ads are not this lane's (spec 025)
  });
  assert.equal(await dispatcher.publishDue(at('2026-10-12T16:00:00Z')), 0, 'not before its time');
  assert.equal(await dispatcher.publishDue(at('2026-10-12T16:11:00Z')), 1);
  const text: string = sent[0].m[0].text;
  assert.ok(text.endsWith(`Реклама. Замовник: ФОП Коваль\n${AD_LABEL}`), text);
  assert.match(JSON.stringify(sent[0].m), /utm_campaign=1a2b3c4d/, "the CTA link carries the UTM tags");
  assert.deepEqual(marked, [{ id: o.id, postId: 4242 }]);
  assert.equal(slots[0].status, 'published');
  assert.match(notes[0], /Спонсор дайджесту/);
});
