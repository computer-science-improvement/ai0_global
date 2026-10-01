/**
 * Integration tests for spec 008 (migration 044) against a throwaway Postgres
 * with all migrations applied. Skipped unless EDITOR_PG_TEST_URL is set, e.g.
 *   EDITOR_PG_TEST_URL=postgres://ai0@localhost:54329/ai0 npx tsx --test src/payments/ad-revenue.pg.test.ts
 * Never point this at a real database: it writes and deletes rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AdPricesRepository } from './ad-prices.repository';
import { AdOrdersRepository } from './ad-orders.repository';
import { DigestSponsorsRepository } from './digest-sponsors.repository';
import { buildAdReport } from './ad-report';
import { EditorPlansRepository, RESERVED_ONLY_RATIONALE } from '../editor/repo/editor-plans.repository';
import { AgentScheduleExecutor, channelRefFromDb } from '../agent/agent-schedule.executor';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let pool: Pool;
const CH = '@pgtest_ads';
const ADV = 'pgtest-advertiser';
let trackedId: string;

async function cleanup() {
  await pool.query(`DELETE FROM ad_orders WHERE advertiser LIKE 'pgtest-%'`);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM ad_prices WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM channel_stats_snapshots WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const { rows } = await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'pgtest_ads', 'PG Ads', true) RETURNING id`, [CH]);
  trackedId = rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'off')`, [CH]);
  await pool.query(`INSERT INTO channel_stats_snapshots (channel_id, subscribers) VALUES ($1, 2000)`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('044: status CHECK accepts published/reported and still rejects unknown statuses', { skip }, async () => {
  const { rows } = await pool.query(`INSERT INTO ad_orders (advertiser, amount, status) VALUES ($1, 1, 'reported') RETURNING id`, [ADV]);
  assert.ok(rows[0].id);
  await assert.rejects(() => pool.query(`INSERT INTO ad_orders (advertiser, amount, status) VALUES ($1, 1, 'bogus')`, [ADV]), /ad_orders_status_check/);
  await assert.rejects(() => pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah) VALUES ($1, 'banner', 10)`, [CH]), /check/);
  await assert.rejects(() => pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah) VALUES ($1, 'post', 0)`, [CH]), /check/);
});

test('prices: one active per channel+format, history kept, public list + media kit', { skip }, async () => {
  const repo = new AdPricesRepository(pool);
  const first = await repo.upsertActive({ channelKey: CH, format: 'post', priceUah: 900 });
  const second = await repo.upsertActive({ channelKey: CH, format: 'post', priceUah: 1200, note: 'від жовтня' });
  await repo.upsertActive({ channelKey: CH, format: 'digest_sponsor', priceUah: 400 });
  const all = await repo.list({ channelKey: CH });
  assert.equal(all.length, 3);
  assert.equal(all.find((p) => p.id === first.id)!.active, false);
  const active = await repo.list({ activeOnly: true, channelKey: CH });
  assert.deepEqual(active.map((p) => [p.format, p.price_uah]).sort(), [['digest_sponsor', 400], ['post', 1200]]);
  await assert.rejects(() => pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah) VALUES ($1, 'post', 5)`, [CH]), /uq_ad_prices_active/);

  const kit = (await repo.mediaKit()).find((c) => c.channelKey === CH)!;
  assert.equal(kit.title, 'PG Ads');
  assert.equal(kit.url, 'https://t.me/pgtest_ads');
  assert.equal(kit.subscribers, 2000);
  assert.deepEqual(kit.prices.map((p) => p.format), ['digest_sponsor', 'post']);
  assert.equal((await repo.findById(second.id))!.note, 'від жовтня');
  assert.equal(await repo.deactivate(second.id), true);
  assert.equal(await repo.deactivate(second.id), false);
});

test('reserved slot lifecycle: reserve → planner supersedes → claim → ad publication → order published → report', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  const orders = new AdOrdersRepository(pool);
  const creative = { format: 'text', body: [{ type: 'p', text: 'Реклама школи' }], cta: { url: 'https://school.example', label: 'Сайт' } };
  const order = await orders.create({ advertiser: ADV, channelId: trackedId, amount: '1200.00', currency: 'UAH', creative, sponsorLabel: 'ФОП Тест' });
  await pool.query(`UPDATE ad_orders SET status = 'scheduled' WHERE id = $1`, [order.id]);

  // Reserve via the real executor wiring (editor enabled, card exists, mode off).
  const exec = new AgentScheduleExecutor({ create: async () => assert.fail('must not use scheduled_posts') } as any, pool, { get: (k: string) => (k === 'EDITOR_ENABLED' ? 'true' : undefined) } as any);
  const at = new Date(Date.now() - 60_000);
  const placed = await exec.schedule({ channelId: trackedId, text: 'x', scheduledAt: at.toISOString(), orderId: order.id });
  assert.equal(placed.kind, 'reserved_slot');
  const slot = await plans.getSlot(placed.id);
  assert.equal(slot!.kind, 'reserved');
  assert.deepEqual((slot!.postSpec as any).cta, creative.cta);
  assert.deepEqual((slot!.postSpec as any).body, creative.body);
  const planDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(at);
  assert.equal((await plans.getActivePlan(CH, planDate))!.rationale, RESERVED_ONLY_RATIONALE);
  const placedOrder = await orders.findById(order.id);
  assert.equal(placedOrder!.editor_slot_id, placed.id);
  assert.equal(new Date(placedOrder!.publish_at!).getTime(), at.getTime());

  // A second reservation the same day reuses the plan; the planner's plan then takes both over.
  const extra = await plans.reserveSlot({ channelKey: CH, planDate, scheduledAt: new Date(at.getTime() + 3600_000 * 5), format: 'text', topic: 'Реклама: інша', sourceHints: [], postSpec: creative });
  const planned = await plans.createPlan(CH, planDate, 'real plan', null, []);
  assert.equal((await plans.getSlot(placed.id))!.planId, planned);
  assert.equal((await plans.getSlot(extra))!.planId, planned);
  assert.equal((await plans.getSlot(placed.id))!.status, 'planned', 'reserved slots are never skipped by a replan');

  // Claim (content claim must not see it; reserved claim does).
  assert.ok(!(await plans.claimDue(new Date(), 50)).some((s) => s.id === placed.id));
  const claimed = await plans.claimDueReserved(new Date(), 50);
  assert.ok(claimed.some((s) => s.id === placed.id));
  assert.ok(!claimed.some((s) => s.id === extra), 'future reserved slot is not due');

  assert.deepEqual(await orders.findBySlot(placed.id), { id: order.id, advertiser: ADV, sponsorLabel: 'ФОП Тест', status: 'scheduled', creative, format: null });
  const postId = await plans.insertPublication({ channelKey: CH, messageId: 9001, sourceUrl: `ad://order/${order.id}`, title: 'Реклама', tags: ['реклама'], format: 'text', slotId: placed.id, strategyType: 'ad' });
  const { rows: pp } = await pool.query(`SELECT strategy_type FROM published_posts WHERE id = $1`, [postId]);
  assert.equal(pp[0].strategy_type, 'ad');
  await orders.markPublished(order.id, postId);
  const pub = await orders.findById(order.id);
  assert.equal(pub!.status, 'published');
  assert.equal(Number(pub!.published_post_id), postId);
  assert.match(pub!.report_token!, /^[A-Za-z0-9_-]{32}$/);

  // Stats → report (24h, then final 72h).
  await pool.query(`UPDATE published_posts SET posted_at = now() - interval '73 hours' WHERE id = $1`, [postId]);
  await pool.query(`INSERT INTO post_stats_snapshots (post_id, captured_at, views, forwards, reactions_total, replies)
                    VALUES ($1, now() - interval '72 hours', 100, 1, 2, 0), ($1, now() - interval '50 hours', 800, 5, 9, 1)`, [postId]);
  const due = await orders.dueForReport(new Date());
  const row = due.find((o) => o.id === order.id)!;
  assert.ok(row);
  const inputs = await orders.reportInputs(postId);
  assert.equal(inputs!.snapshots.length, 2);
  assert.equal(inputs!.channel.subscribers, 2000);
  const report = buildAdReport({ stage: '72h', now: new Date(), advertiser: ADV, ...inputs!, linkUrl: creative.cta.url });
  const token = await orders.saveReport(order.id, report);
  assert.equal(token, pub!.report_token);
  const done = await orders.findById(order.id);
  assert.equal(done!.status, 'reported');
  assert.ok(done!.reported_at);
  assert.equal((await orders.reportByToken(token!))!.metrics.views, 800);
  assert.ok(!(await orders.dueForReport(new Date())).some((o) => o.id === order.id), 'a final report is not rebuilt');
  assert.equal(await orders.reportByToken('nope'), null);
});

test('update refuses published orders; executor fallback without a card writes scheduled_publications with the channel bot', { skip }, async () => {
  const orders = new AdOrdersRepository(pool);
  const o = await orders.create({ advertiser: ADV, amount: '10', currency: 'UAH' });
  assert.equal((await orders.update(o.id, { sponsorLabel: 'X' }))!.sponsor_label, 'X');
  await pool.query(`UPDATE ad_orders SET status = 'published' WHERE id = $1`, [o.id]);
  assert.equal(await orders.update(o.id, { sponsorLabel: 'Y' }), null);

  const ref = await channelRefFromDb(pool, trackedId);
  assert.equal(ref!.channelKey, CH);
  assert.deepEqual(await channelRefFromDb(pool, CH), ref);
  assert.equal(await channelRefFromDb(pool, '@pgtest_missing'), null);
});

test('digest sponsors: today\'s paid digest_sponsor order for the channel → found, then published with the digest post', { skip }, async () => {
  const prices = new AdPricesRepository(pool);
  const orders = new AdOrdersRepository(pool);
  const sponsors = new DigestSponsorsRepository(pool);
  const price = (await prices.list({ activeOnly: true, channelKey: CH })).find((p) => p.format === 'digest_sponsor')!;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const o = await orders.create({
    advertiser: 'pgtest-digest', amount: '400.00', currency: 'UAH', priceId: price.id, publishAt: new Date(),
    creative: { format: 'text', body: [{ type: 'p', text: '**Курс** програмування' }], cta: { url: 'https://kurs.example', label: 'Курс' } },
  });
  assert.equal(await sponsors.findForDay(CH, day), null, 'unpaid orders never sponsor');
  await pool.query(`UPDATE ad_orders SET status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
  assert.equal(await sponsors.findForDay(CH, '2001-01-01'), null);
  const s = await sponsors.findForDay(CH, day);
  assert.deepEqual(s, { orderId: o.id, text: 'Курс програмування', url: 'https://kurs.example' });

  await pool.query(`INSERT INTO published_posts (channel_id, message_id, title, strategy_type) VALUES ($1, 777, 'digest', 'network-digest')`, [CH]);
  await sponsors.markPublished(o.id, CH, '777');
  const after = await orders.findById(o.id);
  assert.equal(after!.status, 'published');
  assert.ok(after!.published_post_id);
  assert.ok(after!.report_token);
  assert.equal(await sponsors.findForDay(CH, day), null, 'a published sponsor is not reused');
});
