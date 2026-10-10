/**
 * Spec 036 against a throwaway Postgres (all migrations, 072 included): a paid digest_sponsor order is embedded
 * by the legacy digest while its binding runs; the spec 023 cutover retires the binding and reports the open
 * orders, the static sponsor and the price to the owner (Inbox + alert); the price is no longer offered; the
 * reserved-lane tick then places the order after the agent's digest series and the reserved lane publishes it
 * (#реклама, approval mode and a pause ignored, fake publisher); a new order is refused at sale; the stuck-order
 * check flags a past-day order once. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../editor/agents/agents.repository';
import { OwnerInbox } from '../editor/agents/owner-inbox';
import { EditorChannelsRepository } from '../editor/repo/editor-channels.repository';
import { EditorPlansRepository } from '../editor/repo/editor-plans.repository';
import { NetworkRepository } from '../editor/network/network.repository';
import { PlaybookSchema } from '../editor/network/playbook';
import { StrategyMigrationService, isFail } from '../editor/migration/strategy-migration.service';
import { ReservedDispatcher } from '../editor/publish/reserved-dispatcher';
import { SponsoredPublisher } from '../editor/publish/sponsored.publisher';
import { AD_LABEL } from '../editor/post/sponsored';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { AdPricesRepository } from './ad-prices.repository';
import { DigestSponsorsRepository } from './digest-sponsors.repository';
import { SponsorFulfilment } from './sponsor-fulfilment';
import { SponsorOrdersRepository } from './sponsor-orders.repository';
import { runStuckCheck } from './stuck-ad-orders';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt036_news';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt036_editor';
const EXT = 'network-digest:pgt036';
const NOW = new Date('2030-03-12T10:00:00Z'); // 12:00 Kyiv (UTC+2)
const CREATIVE = { format: 'text', body: [{ type: 'p', text: '**Курс** програмування для дорослих.' }], cta: { url: 'https://kurs.example/', label: 'Записатися' } };
let pool: Pool;
let trackedId: string;
let priceId: string;
const alerts: string[] = [];

async function cleanup() {
  await pool.query(`DELETE FROM ad_orders WHERE advertiser LIKE 'pgt036-%'`);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM ad_prices WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM strategy_bindings WHERE ext_id = $1`, [EXT]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agent_inbox WHERE kind IN ('sponsor_cutover','ad_order_placed','ad_order_unfulfilled','ad_orders_stuck','strategy_cutover')`);
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  trackedId = (await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'pgt036_news', 'News', true) RETURNING id`, [CH])).rows[0].id;
  const agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Editor', $2, 'shadow') RETURNING id`,
    [TG, HANDLE])).rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats, quiet_start_hour, quiet_end_hour, timezone) VALUES ($1, 'shadow', '{"photo":1,"text":1}', 23, 8, 'Europe/Kyiv')`, [CH]);
  // The approved migration: the digest binding became a network_highlights series at 20:00.
  await new NetworkRepository(pool).insertPlaybook({
    agentId, status: 'active', brief: null, rationale: 'seed', createdBy: 'migration',
    body: PlaybookSchema.parse({
      platforms: [{ resource_ref: TG, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }],
      series: [{
        name: 'Дайджест дня', cadence: 'daily@20:00', resource_ref: TG, format: 'text', brief: 'Найкращі пости мережі за добу.',
        source: { kind: 'network_highlights', scope: 'network' }, origin: 'migration', migrated_from: EXT,
      }],
    }),
  });
  await pool.query(
    `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled) VALUES ($1, 'network-digest', $2, '*/30 19-22 * * *', $3, true)`,
    [EXT, trackedId, JSON.stringify({ sponsor: { text: 'Статичний партнер', url: 'https://static.example/' } })]);
  priceId = (await pool.query(`INSERT INTO ad_prices (channel_key, format, price_uah) VALUES ($1, 'digest_sponsor', 400) RETURNING id`, [CH])).rows[0].id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

function deps() {
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const inbox = new OwnerInbox(pool, async (t) => { alerts.push(t); });
  const sponsorRepo = new SponsorOrdersRepository(pool);
  const fulfilment = new SponsorFulfilment({ orders: sponsorRepo, card: (k) => channels.get(k), reserve: (i) => plans.reserveSlot(i), inbox });
  const migration = new StrategyMigrationService({
    pool, agents: new AgentsRepository(pool), network: new NetworkRepository(pool), card: (k) => channels.get(k), inbox,
    time: { tzOf: async () => 'Europe/Kyiv', quietOf: async () => ({ start: 23, end: 8 }) },
    editorEnabled: () => true, cronTz: 'Europe/Kyiv', now: () => NOW, sponsors: fulfilment,
  });
  return { channels, plans, inbox, sponsorRepo, fulfilment, migration, orders: new AdOrdersRepository(pool), prices: new AdPricesRepository(pool) };
}

let orderId: string;

test('while the digest binding runs: the sponsor is sellable and left to the legacy digest; an order without a creative is flagged', { skip }, async () => {
  const d = deps();
  assert.equal(await d.sponsorRepo.digestRunsOn(CH), true);
  assert.equal(await d.sponsorRepo.digestRunsOn(trackedId), true, 'a tracked_channels uuid resolves too');
  assert.deepEqual((await d.prices.list({ activeOnly: true, channelKey: CH, sellableOnly: true })).map((p) => p.format), ['digest_sponsor']);

  // channel_id as the tracked uuid (the dashboard form's format): resolved to the channel key
  const o = await d.orders.create({ advertiser: 'pgt036-kurs', amount: '400.00', currency: 'UAH', priceId, channelId: trackedId,
    publishAt: new Date('2030-03-12T14:00:00Z'), creative: CREATIVE });
  orderId = o.id;
  const bare = await d.orders.create({ advertiser: 'pgt036-bare', amount: '400.00', currency: 'UAH', priceId, publishAt: new Date('2030-03-12T14:00:00Z') });
  await pool.query(`UPDATE ad_orders SET status = 'paid', paid_at = now() WHERE id = ANY($1::uuid[])`, [[o.id, bare.id]]);

  const open = (await d.sponsorRepo.openDigestSponsors()).filter((x) => x.advertiser.startsWith('pgt036-'));
  assert.deepEqual(open.map((x) => [x.advertiser, x.channelKey, x.digestRuns]).sort(), [['pgt036-bare', CH, true], ['pgt036-kurs', CH, true]]);
  assert.deepEqual(await d.fulfilment.reserveDue(NOW), { placed: 0, flagged: 1 });
  const flagged = (await pool.query(`SELECT advertiser, flag_reason FROM ad_orders WHERE flag_reason IS NOT NULL AND advertiser LIKE 'pgt036-%'`)).rows;
  assert.deepEqual(flagged, [{ advertiser: 'pgt036-bare', flag_reason: 'no_creative' }]);
  assert.ok(alerts.some((a) => /pgt036-bare/.test(a)), 'admin-bot alert sent');
  assert.equal(await d.sponsorRepo.flag(bare.id, 'no_creative'), false, 'the same reason is flagged once');
  assert.ok(await new DigestSponsorsRepository(pool).findForDay(CH, '2030-03-12'), 'the legacy digest finds it');
});

test('cutover retires the digest binding and reports the open sponsors; the price is no longer offered', { skip }, async () => {
  const d = deps();
  const r = await d.migration.cutover(CH);
  assert.ok(!isFail(r), JSON.stringify(r));
  const item = (await pool.query(`SELECT severity, title, body FROM agent_inbox WHERE kind = 'sponsor_cutover'`)).rows;
  assert.equal(item.length, 1);
  assert.equal(item[0].severity, 'action');
  assert.match(item[0].body, /«pgt036-kurs» on @pgt036_news \(2030-03-12, paid\): goes out as a standalone sponsored post/);
  assert.match(item[0].body, /«pgt036-bare».*CANNOT be published: the order has no ad creative/);
  assert.match(item[0].body, /static digest sponsor of network-digest:pgt036/);
  assert.match(item[0].body, /digest sponsor price of @pgt036_news \(400 UAH\) is no longer offered/);

  assert.equal(await d.sponsorRepo.digestRunsOn(CH), false);
  assert.deepEqual(await d.prices.list({ activeOnly: true, channelKey: CH, sellableOnly: true }), []);
  assert.equal((await d.prices.mediaKit()).find((c) => c.channelKey === CH), undefined);
  // a new sale is refused (the service with the real guard)
  const svc = new AdOrdersService(d.orders, {} as any, {} as any, d.prices, d.sponsorRepo);
  await assert.rejects(() => svc.create({ advertiser: 'pgt036-new', priceId }), /digest_sponsor is not sold on @pgt036_news/);
});

test('after the cutover the tick places the paid sponsor after the agent\'s digest; the reserved lane publishes it despite approval mode and a pause', { skip }, async () => {
  const d = deps();
  assert.equal((await d.channels.get(CH))!.mode, 'approve', 'the cutover put the channel in approval mode');
  assert.deepEqual(await d.sponsorRepo.digestCadences(CH), ['daily@20:00']);
  assert.deepEqual(await d.fulfilment.reserveDue(NOW), { placed: 1, flagged: 0 });
  const o = (await d.orders.findById(orderId))!;
  assert.equal(o.status, 'scheduled');
  assert.ok(o.editor_slot_id);
  assert.equal(o.publish_at!.toISOString(), '2030-03-12T18:10:00.000Z', '20:10 Kyiv, ten minutes after the digest series');
  assert.equal(o.flag_reason, null);
  const slot = (await pool.query(`SELECT kind, status, scheduled_at, source_hints, post_spec FROM editor_slots WHERE id = $1`, [o.editor_slot_id])).rows[0];
  assert.equal(slot.kind, 'reserved');
  assert.deepEqual(slot.source_hints, [`ad_order:${orderId}`, 'digest_sponsor']);
  assert.match(slot.post_spec.cta.url, /utm_source=ai0/);
  assert.equal(await new DigestSponsorsRepository(pool).findForDay(CH, '2030-03-12'), null, 'placed → never also a digest line');
  assert.deepEqual(await d.fulfilment.reserveDue(NOW), { placed: 0, flagged: 0 }, 'placed once');

  const sent: any[] = [];
  const sponsored = new SponsoredPublisher({
    plans: d.plans, channels: d.channels, orders: d.orders,
    publisher: { send: async (k, m) => { sent.push({ k, m }); return { messageIds: [9036] }; } },
    recordPublish: () => {}, notify: async (t) => { alerts.push(t); },
  });
  const lane = new ReservedDispatcher({
    plans: d.plans, orders: d.orders, sponsored,
    manual: { publishScheduled: async () => { throw new Error('not a manual post'); } },
    paused: async () => true,
  });
  assert.equal(await lane.publishDue(new Date('2030-03-12T18:00:00Z')), 0);
  assert.equal(await lane.publishDue(new Date('2030-03-12T18:11:00Z')), 1);
  assert.ok((sent[0].m[0].text as string).endsWith(AD_LABEL));
  const after = (await d.orders.findById(orderId))!;
  assert.equal(after.status, 'published');
  assert.ok(after.report_token);
  const post = (await pool.query(`SELECT strategy_type, tags, message_id FROM published_posts WHERE id = $1`, [after.published_post_id])).rows[0];
  assert.equal(post.strategy_type, 'ad');
  assert.deepEqual(post.tags, ['реклама']);
  assert.equal(Number(post.message_id), 9036);
});

test('stuck-order check: a paid digest sponsor whose day passed is flagged once and posted to the Inbox', { skip }, async () => {
  const d = deps();
  const old = await d.orders.create({ advertiser: 'pgt036-old', amount: '400.00', currency: 'UAH', priceId,
    publishAt: new Date('2030-03-09T10:00:00Z'), creative: CREATIVE });
  await pool.query(`UPDATE ad_orders SET status = 'paid', paid_at = now() WHERE id = $1`, [old.id]);
  // the tick never publishes a past day
  assert.deepEqual(await d.fulfilment.reserveDue(NOW), { placed: 0, flagged: 0 });
  const fresh = (await runStuckCheck({ orders: d.sponsorRepo, inbox: d.inbox }, NOW)).filter((o) => o.advertiser.startsWith('pgt036-'));
  assert.deepEqual(fresh.map((o) => [o.advertiser, o.reason, o.channelKey]), [['pgt036-old', 'day_passed', CH]]);
  const items = (await pool.query(`SELECT body FROM agent_inbox WHERE kind = 'ad_orders_stuck'`)).rows;
  assert.equal(items.length, 1);
  assert.match(items[0].body, /pgt036-old/);
  assert.deepEqual((await runStuckCheck({ orders: d.sponsorRepo, inbox: d.inbox }, NOW)).filter((o) => o.advertiser.startsWith('pgt036-')), []);
  assert.equal((await d.orders.findById(old.id))!.status, 'paid', 'nothing is refunded or published');
});
