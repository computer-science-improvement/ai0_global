/** Spec 031 T2 (pure + fakes): lead-time scheduling, the waiting-post path of publish_post / publish_platform, the scheduler hook. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchDateDue, batchTimeOf, expiresAt, freshnessDeadline, isTimeSensitive, writeAt, FRESHNESS_GRACE_MS,
} from './approval-timing';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { renderTelegram } from '../post/render-telegram';
import { buildRoleTools } from '../tools/role-tools';
import { publishPlatformNow, publishApprovedPlatform, type PublishPlatformDeps } from '../platform/publish-platform';
import { PlatformPostSpecSchema } from '../platform/platform-spec';
import { EditorScheduler } from '../editor.scheduler';
import type { EditorSlot } from '../repo/editor-plans.repository';

const TZ = 'Europe/Kyiv'; // UTC+3 in October 2026 (DST until Oct 25)
const card = makeCard({ mode: 'approve', timezone: TZ, sources: [{ id: 'feed', kind: 'rss', ref: 'https://news.example/rss' }] });
const slot = (o: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2026-10-08T07:00:00Z'), kind: 'content', format: 'photo',
  topic: 'Туманність Кільце', angle: null, sourceHints: [], isExperiment: false, status: 'planned', attempts: 0, runId: null,
  publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...o,
});
const h = 3600_000;

test('lead time: the next-day batch is written at 20:00 the evening before', () => {
  // Slot Thu 10:00 Kyiv (07:00Z); its batch is Wed 20:00 Kyiv = 17:00Z.
  assert.equal(batchTimeOf(new Date('2026-10-08T07:00:00Z'), TZ).toISOString(), '2026-10-07T17:00:00.000Z');
  const planned = slot({ createdAt: new Date('2026-10-07T17:00:40Z') }); // the 20:00 planning run itself
  assert.equal(writeAt(planned, card).toISOString(), '2026-10-07T17:00:00.000Z');
  const early = slot({ createdAt: new Date('2026-10-07T05:00:00Z') });  // planned in the morning
  assert.equal(writeAt(early, card).toISOString(), '2026-10-07T17:00:00.000Z');
});

test('lead time: a slot added later is written approval_lead_hours ahead, capped at 3 h when created < 12 h ahead', () => {
  const added = slot({ createdAt: new Date('2026-10-07T19:30:00Z'), scheduledAt: new Date('2026-10-08T15:00:00Z') }); // 19.5 h ahead
  assert.equal(writeAt(added, card).getTime(), added.scheduledAt.getTime() - 12 * h);
  const custom = writeAt(added, { ...card, approvalLeadHours: 6 });
  assert.equal(custom.getTime(), added.scheduledAt.getTime() - 6 * h);
  const late = slot({ createdAt: new Date('2026-10-08T03:00:00Z'), scheduledAt: new Date('2026-10-08T12:00:00Z') }); // 9 h ahead
  assert.equal(writeAt(late, card).getTime(), late.scheduledAt.getTime() - 3 * h);
  const urgent = slot({ createdAt: new Date('2026-10-08T10:00:00Z'), scheduledAt: new Date('2026-10-08T11:00:00Z') });
  assert.ok(writeAt(urgent, card).getTime() < urgent.createdAt!.getTime(), 'a write time in the past means "now"');
});

test('lead time: news / feed slots are written 2 h ahead and carry a freshness deadline', () => {
  const news = slot({ sourceHints: ['https://news.example/rss'], createdAt: new Date('2026-10-01T00:00:00Z') });
  assert.equal(isTimeSensitive(news, card), true);
  assert.equal(writeAt(news, card).getTime(), news.scheduledAt.getTime() - 2 * h);
  assert.equal(freshnessDeadline(news, card)!.getTime(), news.scheduledAt.getTime() + FRESHNESS_GRACE_MS);
  assert.equal(isTimeSensitive(slot({ sourceHints: ['rss:feed'] }), card), true);
  assert.equal(isTimeSensitive(slot(), card), false);
  assert.equal(freshnessDeadline(slot(), card), null);
});

test('expiry: hold window after the slot, or the freshness deadline when earlier', () => {
  const s = slot();
  assert.equal(expiresAt(s, card).getTime(), s.scheduledAt.getTime() + 6 * h);
  assert.equal(expiresAt(s, { approvalHoldHours: 2 }).getTime(), s.scheduledAt.getTime() + 2 * h);
  const fresh = { ...s, freshnessDeadline: new Date(s.scheduledAt.getTime() + 30 * 60_000) };
  assert.equal(expiresAt(fresh, card).getTime(), fresh.freshnessDeadline.getTime());
});

test('batchDateDue: tomorrow from 20:00 in the resource zone', () => {
  assert.equal(batchDateDue(new Date('2026-10-07T16:59:00Z'), card), null);         // 19:59 Kyiv
  assert.equal(batchDateDue(new Date('2026-10-07T17:00:00Z'), card), '2026-10-08'); // 20:00 Kyiv
  assert.equal(batchDateDue(new Date('2026-10-07T20:59:00Z'), card), '2026-10-08'); // 23:59 Kyiv
});

function roleToolsHarness(o: { mode: 'approve' | 'live'; slotStatus?: string } = { mode: 'approve' }) {
  const sent: unknown[] = [];
  const updates: any[] = [];
  const prepared: any[] = [];
  const current = slot({ status: (o.slotStatus ?? 'running') as any });
  const tools = buildRoleTools({
    pool: { query: async () => ({ rows: [] }) } as any,
    plans: {
      getSlot: async () => current, updateSlot: async (_id: string, p: any) => { updates.push(p); },
      createPlan: async () => 'p', reservedSlots: async () => [], countPublishedSince: async () => 0, lastPostAt: async () => null,
      sourceAlreadyPosted: async () => false, recentTexts: async () => [], insertPublication: async () => 1,
    },
    memory: {} as any, channels: {} as any,
    publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [42] }; } },
    media: { prepare: async (spec, key) => { prepared.push([spec.format, key]); return { prepared: { slideUrls: ['https://h/1.png', 'https://h/2.png'] }, cleanup: async () => {} }; } },
    recordPublish: () => {},
    now: () => new Date('2026-10-07T17:05:00Z'),
  });
  const publish = tools.find((t) => t.name === 'publish_post')!;
  const ctx = { runId: 'r', role: 'executor' as const, channelKey: '@chan', slotId: 's1', extras: { card: { ...card, mode: o.mode } } };
  return { publish, ctx, sent, updates, prepared };
}

test('publish_post in approve: every check runs, media is prepared, the render is stored — nothing is sent', async () => {
  const t = roleToolsHarness();
  const spec = makeSpec();
  const r: any = await t.publish.execute({ spec }, t.ctx);
  assert.deepEqual(r, { ok: true, awaiting_approval: true, warnings: [] });
  assert.equal(t.sent.length, 0, 'nothing reaches Telegram');
  const u = t.updates.at(-1);
  assert.equal(u.status, 'awaiting_approval');
  const expected = renderTelegram(spec, { ...card });
  assert.deepEqual(u.renderMessages, { kind: 'telegram', messages: expected.messages, primary: expected.primary }, 'the stored render is the live render');
  assert.equal(u.renderedPreview, expected.preview);

  // A carousel: slides are rendered and hosted at write time, so the owner sees exactly what goes out.
  const c = roleToolsHarness();
  const carousel = makeSpec({ format: 'carousel', media: [], slides: [{ title: 'Марс', text: 'Червона планета.' }, { title: 'Олімп', text: 'Найвища гора.' }] });
  const rc: any = await c.publish.execute({ spec: carousel }, { ...c.ctx, extras: { card: { ...card, formats: { ...card.formats, carousel: 1 } } } });
  assert.equal(rc.awaiting_approval, true, JSON.stringify(rc));
  assert.deepEqual(c.prepared, [['carousel', { channelKey: '@chan', slotId: 's1' }]]);
  const msgs = c.updates.at(-1).renderMessages.messages;
  assert.deepEqual(msgs[0].photos, ['https://h/1.png', 'https://h/2.png'], 'the album carries the hosted slides');
  assert.deepEqual(c.updates.at(-1).preparedMedia, { slideUrls: ['https://h/1.png', 'https://h/2.png'] });
  assert.equal(c.sent.length, 0);

  // Lint still blocks: a waiting post never skips a guard.
  const bad: any = await t.publish.execute({ spec: makeSpec({ hashtags: ['невідомий'] }) }, t.ctx);
  assert.equal(bad.error, 'lint_failed');
});

test('publish_post in live still sends (unchanged)', async () => {
  const t = roleToolsHarness({ mode: 'live' });
  const r: any = await t.publish.execute({ spec: makeSpec() }, { ...t.ctx, extras: { card: { ...card, mode: 'live', quietStartHour: 0, quietEndHour: 0 } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.shadow, false);
  assert.equal(t.sent.length, 1);
});

const pspec = (o: any = {}) => PlatformPostSpecSchema.parse({
  format: 'ig_carousel', title: 'П’ять фактів про Марс', caption: '**Марс** — червона планета. Гортай 👉',
  hashtags: ['космос', 'марс', 'наука'],
  slides: [{ title: 'Марс', text: 'Доба на Марсі — 24 год 37 хв.' }, { title: 'Олімп', text: 'Найвища гора Сонячної системи.' }],
  ...o,
});

function platformDeps(o: { posted?: boolean } = {}) {
  const inserted: any[] = [];
  const published: any[] = [];
  const settled: any[] = [];
  const d: PublishPlatformDeps = {
    posts: {
      insert: async (p: any) => { inserted.push(p); return { id: inserted.length, ...p } as any; },
      alreadyPosted: async () => !!o.posted, countPublishedSince: async () => 0, lastPostAt: async () => null, recentCaptions: async () => [],
      settle: async (id, status, p) => { settled.push([id, status, p]); return true; },
    },
    publisher: { publish: async (ref, r) => { published.push([ref, r]); return { externalId: 'ig-9', url: 'https://ig/p/9', warnings: [] }; } },
    hostSlides: async (slides) => ({ prepared: { slideUrls: slides.map((_, i) => `https://h/${i}.png`) }, cleanup: async () => {} }),
    health: async () => null,
    now: () => new Date('2026-10-02T10:00:00Z'),
  };
  return { d, inserted, published, settled };
}

test('publish_platform in approve: slides hosted, a waiting row, no API call; the approved path sends the stored render', async () => {
  const p = platformDeps();
  const r: any = await publishPlatformNow(p.d, { resourceRef: 'instagram:ig1', spec: pspec(), mode: 'approve', slotId: 's1' });
  assert.equal(r.ok, true);
  assert.equal(r.awaiting, true);
  assert.equal(p.published.length, 0, 'nothing reaches Instagram');
  assert.equal(p.inserted[0].status, 'awaiting_approval');
  assert.deepEqual(r.rendered.imageUrls, ['https://h/0.png', 'https://h/1.png']);

  const ok: any = await publishApprovedPlatform(p.d, { resourceRef: 'instagram:ig1', postId: 1, spec: pspec(), rendered: r.rendered });
  assert.equal(ok.ok, true);
  assert.deepEqual(p.published, [['instagram:ig1', r.rendered]], 'exactly the approved render is sent');
  assert.deepEqual(p.settled, [[1, 'published', { externalId: 'ig-9', url: 'https://ig/p/9' }]]);

  const dup = platformDeps({ posted: true });
  const d: any = await publishApprovedPlatform(dup.d, { resourceRef: 'instagram:ig1', postId: 3, spec: pspec({ source: { url: 'https://src/a' } }), rendered: r.rendered });
  assert.equal(d.error, 'dedup_after_approval');
  assert.equal(dup.published.length, 0);
  assert.deepEqual(dup.settled[0].slice(0, 2), [3, 'canceled']);
});

test('scheduler: approval channels plan the next day at 20:00 and write slots ahead; others are untouched', async () => {
  const calls: string[] = [];
  const approveCard = { ...card, channelKey: '@appr', planHour: 6, createdAt: new Date('2026-01-01') };
  const liveCard = { ...makeCard({ channelKey: '@live', mode: 'live', planHour: 6 }), createdAt: new Date('2026-01-01') };
  const tomorrowSlot = slot({ id: 'w1', channelKey: '@appr', scheduledAt: new Date('2026-10-08T07:00:00Z'), createdAt: new Date('2026-10-07T17:00:30Z') });
  const laterSlot = slot({ id: 'w2', channelKey: '@appr', scheduledAt: new Date('2026-10-09T07:00:00Z'), createdAt: new Date('2026-10-07T17:00:30Z') });
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [{}] }) } as any,
    channels: { listActive: async () => [approveCard, liveCard] },
    plans: {
      getActivePlan: async (key: string, date: string) => (date === '2026-10-07' ? { id: 'p', rationale: null } : null),
      claimDue: async () => [], skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0,
      plannedBefore: async (keys: string[]) => { calls.push(`candidates:${keys.join(',')}`); return [tomorrowSlot, laterSlot]; },
      claimSlot: async (id: string) => { calls.push(`claim:${id}`); return { ...(id === 'w1' ? tomorrowSlot : laterSlot), status: 'running' }; },
    },
    runner: {
      runPlanner: async (c: any, o?: any) => { calls.push(`plan:${c.channelKey}:${o?.planDate ?? 'today'}`); return {} as any; },
      runExecutor: async (sl: any) => { calls.push(`exec:${sl.id}`); return {} as any; },
      runReviewer: async () => ({}) as any,
    },
    enabled: () => true,
    notify: async () => {},
    approval: { mode: async (c) => c.mode, tick: async () => { calls.push('approval-tick'); } },
  });
  await s.tick(new Date('2026-10-07T17:01:00Z')); // Wed 20:01 Kyiv
  assert.ok(calls.includes('plan:@appr:2026-10-08'), calls.join(' '));
  assert.ok(!calls.some((c) => c.startsWith('plan:@live:2026-10-08')), 'live channels do not plan ahead');
  assert.ok(calls.includes('candidates:@appr'), 'only approval channels write ahead');
  assert.ok(calls.includes('claim:w1') && calls.includes('exec:w1'), 'the batch slot is written now');
  assert.ok(!calls.includes('claim:w2'), 'the day after waits for its own batch');

  await s.approvalTick(new Date('2026-10-07T17:01:00Z'));
  assert.ok(calls.includes('approval-tick'));
});
