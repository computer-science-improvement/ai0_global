/**
 * Spec 023 T2 against a throwaway Postgres with every migration applied: library_catalog's additions on
 * fixture counts (unposted from the ledger, last use, runway from an active series and 28-day usage, APIs
 * without secrets, card feeds), low_runway once per dataset per 7 days, and get_network_highlights on
 * published posts (own channels, views per hour, ads and digests left out, topic mode, enough, today's
 * digest already out). Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DataStore } from '../../data/data-store';
import { ContentLedger } from '../../data/content-ledger';
import { OwnerInbox } from '../agents/owner-inbox';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema } from '../network/playbook';
import { buildDataTools } from './data-tools';
import { buildHighlightsTools } from './highlights-tools';
import { catalogSummaryOf, checkLowRunway } from './catalog-context';
import type { ToolContext } from '../harness/tool';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'pgt023c_tips';
const CH = '@pgt023c_ch';
const RR = `telegram:${CH}`;
const HANDLE = 'pgt023c_orch';
const SECRET = 'pgt023c-TMDB-SECRET';
let pool: Pool;
let agentId: string;
const playbook = PlaybookSchema.parse({
  platforms: [{ resource_ref: RR, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 4 } }],
  series: [{ name: 'Порада дня', cadence: 'daily@10:00,18:00', resource_ref: RR, format: 'text', brief: 'Порада з бібліотеки двічі на день', source: { kind: 'library', table: K } }],
});

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE ref_type = 'dataset' AND ref_id = $1`, [K]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref LIKE '%pgt023c%' OR source_ref LIKE '%pgt023c%'`);
  await pool.query(`DELETE FROM posted_news WHERE channel_id LIKE '@pgt023c%'`);
  await pool.query(`DELETE FROM published_posts WHERE channel_id LIKE '@pgt023c%'`);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key LIKE '@pgt023c%'`);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key = $1)`, [K]);
  await pool.query(`DELETE FROM data_schemas WHERE key = $1`, [K]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const store = new DataStore(pool);
  await store.createSchema({
    key: K, title: 'Kitchen tips', description: 'Short kitchen tips', entity: 'tip',
    fields: [{ name: 'text', type: 'text', description: 'The tip', required: true }],
    roles: { title: 'text' }, dedup_key: ['text'], language: 'uk', default_license: 'own',
    reuse_policy: { kind: 'never' }, suitable_for: 'food channels', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  await store.upsert(K, Array.from({ length: 10 }, (_, i) => ({ text: `Порада ${i}` })));
  const { rows } = await pool.query(`SELECT d.id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [K]);
  const ledger = new ContentLedger(pool);
  for (const [i, days] of [[0, 2], [1, 5], [2, 40]] as const) {
    await ledger.record(`data://${K}/${rows[i].id}`, { resourceRef: RR, origin: 'editor', status: 'published', usedAt: new Date(Date.now() - days * 86_400_000) });
  }
  agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Tips', $2, 'shadow') RETURNING id`, [RR, HANDLE])).rows[0].id;
  await new NetworkRepository(pool).insertPlaybook({ agentId, status: 'active', brief: null, body: playbook, rationale: 'seed', createdBy: 'owner' });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const card = { channelKey: CH, timezone: 'Europe/Kyiv', sources: [{ id: 'f1', kind: 'rss', ref: 'https://pgt023c.example/rss' }, { id: 'l1', kind: 'library', ref: K }] };
const ctx = (channelKey = CH): ToolContext => ({ runId: 'r', role: 'planner', channelKey, extras: { card } });

test('library_catalog overview: ledger counts, last use, runway, APIs without secrets, card feeds', { skip }, async () => {
  const env = (k: string) => (k === 'TMDB_API_KEY' ? SECRET : undefined);
  const tools = Object.fromEntries(buildDataTools({ pool, env }).map((t) => [t.name, t]));
  const r: any = await tools.library_catalog.execute({}, ctx());
  const d = r.datasets.find((x: any) => x.dataset === K);
  assert.equal(d.rows, 10);
  assert.equal(d.unposted_here, 7, 'three rows are in the ledger for this channel');
  // 2 instances a day from the series beat 2 uses in 28 days.
  assert.equal(d.runway_days, 3.5);
  assert.ok(d.last_used_here && Date.now() - Date.parse(d.last_used_here) < 3 * 86_400_000);
  assert.equal(r.apis.find((a: any) => a.name === 'tmdb_trending').configured, true);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'never a key value');
  assert.deepEqual(r.feeds, [{ id: 'f1', kind: 'rss', ref: 'https://pgt023c.example/rss' }]);
  const one: any = await tools.library_catalog.execute({ dataset: K }, ctx());
  assert.equal(one.dataset.runway_days, 3.5);
  const elsewhere: any = await tools.library_catalog.execute({}, ctx('@pgt023c_other'));
  const e = elsewhere.datasets.find((x: any) => x.dataset === K);
  assert.equal(e.unposted_here, 10);
  assert.equal(e.runway_days, null, 'nothing uses it there');

  const summary = await catalogSummaryOf(pool, env)(card as any);
  assert.ok(summary && summary.length <= 1500);
  assert.match(summary!, new RegExp(`${K}: Kitchen tips — невикористаних тут 7 з 10, запас 3.5 дн.`));
});

test('low_runway: once per dataset per 7 days', { skip }, async () => {
  const inbox = new OwnerInbox(pool);
  assert.deepEqual(await checkLowRunway({ pool, inbox }, { id: agentId, handle: HANDLE }, playbook), [K]);
  assert.deepEqual(await checkLowRunway({ pool, inbox }, { id: agentId, handle: HANDLE }, playbook), [], 'not again within 7 days');
  const { rows } = await pool.query(`SELECT kind, severity, title FROM agent_inbox WHERE ref_type = 'dataset' AND ref_id = $1`, [K]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /about 3.5 days/);
  await pool.query(`UPDATE agent_inbox SET created_at = now() - interval '8 days' WHERE ref_type = 'dataset' AND ref_id = $1`, [K]);
  assert.deepEqual(await checkLowRunway({ pool, inbox }, { id: agentId, handle: HANDLE }, playbook), [K], 'again after 7 days');
  const paused = { ...playbook, series: playbook.series.map((s) => ({ ...s, active: false })) };
  await pool.query(`DELETE FROM agent_inbox WHERE ref_type = 'dataset' AND ref_id = $1`, [K]);
  assert.deepEqual(await checkLowRunway({ pool, inbox }, { id: agentId, handle: HANDLE }, paused), [], 'a paused series uses nothing');
});

test('get_network_highlights: own posts of a day ranked by views per hour; ads and digests left out; topic mode; enough', { skip }, async () => {
  for (const key of ['@pgt023c_a', '@pgt023c_b']) await pool.query(`INSERT INTO tracked_channels (channel_key, username, is_mine) VALUES ($1, $2, true)`, [key, key.slice(1)]);
  const day = '2031-05-05';
  const posts: Array<[string, number, string, string, number | null, string]> = [
    ['@pgt023c_a', 1, 'Перший пост', 'editor', 100, '06:00'],
    ['@pgt023c_a', 2, 'Другий пост', 'ai0-news', 5000, '09:00'],
    ['@pgt023c_b', 3, 'Третій пост', 'ua-news', 300, '12:00'],
    ['@pgt023c_b', 4, 'Реклама', 'ad', 99999, '13:00'],
    ['@pgt023c_a', 5, 'Дайджест', 'network-digest', 99999, '17:00'],
  ];
  for (const [ch, mid, title, type, views, hhmm] of posts) {
    const { rows } = await pool.query(
      `INSERT INTO published_posts (channel_id, message_id, title, strategy_type, posted_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ch, mid, title, type, `${day}T${hhmm}:00Z`]);
    if (views != null) await pool.query(`INSERT INTO post_stats_snapshots (post_id, views) VALUES ($1, $2)`, [rows[0].id, views]);
  }
  const tool = buildHighlightsTools({ pool })[0];
  const net: any = await tool.execute({ scope: 'network', date: day, min_items: 3, max_items: 8 }, ctx('@pgt023c_a'));
  assert.deepEqual(net.items.map((i: any) => i.title), ['Другий пост', 'Третій пост', 'Перший пост']);
  assert.equal(net.items[0].url, 'https://t.me/pgt023c_a/2');
  assert.equal(net.enough, true);
  const mine: any = await tool.execute({ scope: 'channel', date: day, min_items: 3, max_items: 8 }, ctx('@pgt023c_b'));
  assert.equal(mine.enough, false);
  assert.match(mine.note, /замало/);
  const topic: any = await tool.execute({ scope: 'network', date: day, strategy_types: ['ai0-news', 'ua-news'], min_items: 3, max_items: 8 }, ctx('@pgt023c_a'));
  assert.deepEqual(topic.items.map((i: any) => i.title), ['Другий пост', 'Третій пост'], 'chronological');
  await pool.query(`INSERT INTO posted_news (source_url, title, channel_id, content_type) VALUES ($1, 'd', '@pgt023c_a', 'digest')`, [`digest://network/@pgt023c_a/${day}`]);
  const again: any = await tool.execute({ scope: 'network', date: day, min_items: 3, max_items: 8 }, ctx('@pgt023c_a'));
  assert.equal(again.already_posted_today, true);
});
