/**
 * Spec 037 T9 on a throwaway Postgres with every migration applied: the resource's last written posts as integrity
 * posts (recentAuditPosts: own Telegram slots only, written statuses, newest first, a live slot without its topic)
 * and the feed-fit block of the MANAGER digest from real slots (jargon at the resource's audience level, critic
 * verdicts, a rejected slot attributed by its live feed). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { recentAuditPosts } from './recent-posts';
import { SqlFeedFit } from '../../manager/feed-fit';
import { SqlQuality } from '../../manager/quality-digest';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt037t9_ai';
const REF = `telegram:${CH}`;
const MTP = 'https://www.marktechpost.com/2026/10/07/x/';
let pool: Pool;
let planId: string;

async function cleanup() {
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

async function addSlot(o: { hoursAgo: number; status: string; text?: string; source?: string; critic?: unknown; topicMode?: 'live'; liveSpec?: unknown; resourceRef?: string }) {
  const spec = o.text ? { format: 'text', title: 'Тест', origin: 'external', body: [{ type: 'p', text: o.text }], ...(o.source ? { source: { url: o.source } } : {}) } : null;
  await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec, critic, topic_mode, live_spec, resource_ref)
     VALUES ($1, $2, now() - ($3 || ' hours')::interval, 'text', $4, $5, $6, $7, $8, $9, $10)`,
    [planId, CH, String(o.hoursAgo), `Тема ${o.hoursAgo}`, o.status, spec ? JSON.stringify(spec) : null, o.critic ? JSON.stringify(o.critic) : null,
      o.topicMode ?? 'fixed', o.liveSpec ? JSON.stringify(o.liveSpec) : null, o.resourceRef ?? null]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1}')`, [CH]);
  await pool.query(`INSERT INTO resource_profiles (resource_ref, profile) VALUES ($1, $2)`, [REF, JSON.stringify({ format_prefs: { style: { audience: { level: 'beginner' } } } })]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [CH])).rows[0].id;
  const jargon = 'Модель має 1 трлн параметрів в архітектурі MoE, на кожен токен активні 49 млрд, доступ через API.';
  await addSlot({ hoursAgo: 50, status: 'published', text: jargon, source: MTP, critic: { verdict: 'pass' } });
  await addSlot({ hoursAgo: 40, status: 'shadowed', text: 'Ще один пост із MoE, API, токенами й параметрами.', source: MTP, critic: { verdict: 'pass', history: [{ verdict: 'revise' }] } });
  await addSlot({ hoursAgo: 30, status: 'skipped', critic: { verdict: 'reject' }, topicMode: 'live', liveSpec: { sources: [MTP], brief: 'b', max_age_hours: 36, origin: 'planner' } });
  await addSlot({ hoursAgo: 20, status: 'published', text: 'Простий пост про новий застосунок для нотаток.', source: 'https://blog.google/x', critic: { verdict: 'pass' } });
  await addSlot({ hoursAgo: 10, status: 'awaiting_approval', text: 'Живий слот без теми.', source: 'https://blog.google/y', topicMode: 'live', liveSpec: { sources: ['https://blog.google/rss'], brief: 'b', max_age_hours: 36, origin: 'planner' } });
  await addSlot({ hoursAgo: 5, status: 'published', text: 'Пост на Threads того ж каналу.', resourceRef: 'threads:1' });
  await addSlot({ hoursAgo: 2, status: 'planned', text: 'Ще не написаний.' });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('recentAuditPosts: the channel\'s own written Telegram posts, newest first, live slots without a topic', { skip }, async () => {
  const posts = await recentAuditPosts(pool, { channelKey: CH, timezone: 'Europe/Kyiv' });
  assert.deepEqual(posts.map((p) => p.text.split('\n')[0].slice(0, 20)), ['Живий слот без теми.', 'Простий пост про нов', 'Ще один пост із MoE,', 'Модель має 1 трлн па']);
  assert.deepEqual(posts.map((p) => p.topic ?? null), [null, 'Тема 20', 'Тема 40', 'Тема 50']);
  assert.ok(posts.every((p) => p.format === 'text' && p.channel === CH));
  const without = await recentAuditPosts(pool, { channelKey: CH, timezone: 'Europe/Kyiv', limit: 2 });
  assert.equal(without.length, 2);
});

test('feed fit from real slots: marktechpost.com replace (jargon at the beginner level, revise, reject), blog.google fine', { skip }, async () => {
  const now = new Date();
  const feeds = await new SqlFeedFit(pool).feeds([REF], new Date(now.getTime() - 7 * 86_400_000), now);
  assert.deepEqual(feeds.get(REF), [
    { feed: 'marktechpost.com', items: 3, jargon_over_level: 2, revise: 1, reject: 1, misfit_share: 1, suggestion: 'replace' },
    { feed: 'blog.google', items: 2, jargon_over_level: 0, revise: 0, reject: 0, misfit_share: 0, suggestion: null },
  ]);
  const q = (await new SqlQuality(pool).digest([REF], now)).get(REF)!;
  assert.equal(q.feeds?.[0].feed, 'marktechpost.com');
  assert.ok(q.flags.includes('feed_misfit'));
});
