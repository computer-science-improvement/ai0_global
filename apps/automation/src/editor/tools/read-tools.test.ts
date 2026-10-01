import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from './read-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';

function fakePool(handler: (sql: string, params: any[]) => any[] = () => []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return { calls, pool: { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: handler(sql, params) }; } } as any };
}
const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function tools(pool: any, extra: any = {}) {
  const readonly = { run: async (q: string, l: number) => ({ q, l }) } as any;
  const list = buildReadTools({ pool, readonly, skills: new SkillLibrary('/nonexistent'), http: { lookup, get: extra.get }, today: () => ({ month: 10, day: 1 }) });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

test('get_channel_stats aggregates three queries scoped to the channel', async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('channel_stats_snapshots')) return [{ now: 1200, then: 1100 }];
    if (sql.includes('GROUP BY 1')) return [{ hour: 19, posts: 4, median_vph: '35.5' }];
    return [{ n: 28, avg_views: 900, median_vph: '20.1' }];
  });
  const res: any = await tools(pool).get_channel_stats.execute({ days: 14 }, ctx);
  assert.equal(res.subscribers.delta, 100);
  assert.equal(res.posts.perDay, 2);
  assert.deepEqual(res.bestHours, [{ hour: 19, posts: 4, medianViewsPerHour: 35.5 }]);
  assert.ok(calls.every((c) => c.params[0] === '@chan'));
});

test('get_top_posts orders by the whitelisted metric only', async () => {
  const { pool, calls } = fakePool();
  await tools(pool).get_top_posts.execute({ days: 30, limit: 5, metric: 'forwards' }, ctx);
  assert.match(calls[0].sql, /ORDER BY forwards DESC/);
});

test('search_library excludes used rows, filters, and returns library_ref', async () => {
  const { pool, calls } = fakePool(() => [{ id: 42, title: 'Борщ' }]);
  const res: any = await tools(pool).search_library.execute({ table: 'recipes', query: 'борщ', today_only: false, include_used: false, limit: 5 }, ctx);
  assert.match(calls[0].sql, /FROM recipes x/);
  assert.match(calls[0].sql, /NOT EXISTS \(SELECT 1 FROM published_posts/);
  assert.deepEqual(calls[0].params, ['%борщ%', '@chan', 5]);
  assert.equal(res.items[0].library_ref, 'library://recipes/42');
});

test('search_library today_only uses month/day params and rejects tables without dates', async () => {
  const { pool, calls } = fakePool();
  await tools(pool).search_library.execute({ table: 'on_this_day', today_only: true, include_used: true, limit: 3 }, ctx);
  assert.match(calls[0].sql, /month = \$1 AND day = \$2/);
  assert.deepEqual(calls[0].params, [10, 1, 3]);
  const r: any = await tools(pool).search_library.execute({ table: 'recipes', today_only: true, include_used: true, limit: 3 }, ctx);
  assert.equal(r.error, 'today_only_not_supported');
});

test('sql_readonly delegates to the readonly service', async () => {
  const res: any = await tools(fakePool().pool).sql_readonly.execute({ query: 'SELECT 1', limit: 7 }, ctx);
  assert.deepEqual(res, { q: 'SELECT 1', l: 7 });
});

test('web_fetch extracts page via safe GET', async () => {
  const get = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: '<title>T</title><p>Body text</p>' });
  const res: any = await tools(fakePool().pool, { get }).web_fetch.execute({ url: 'https://example.com/a' }, ctx);
  assert.equal(res.title, 'T');
  assert.match(res.text, /Body text/);
});

test('fetch_feed parses RSS items', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
    <item><title>One</title><link>https://example.com/1</link><description>Desc one</description></item>
    <item><title>Two</title><link>https://example.com/2</link></item></channel></rss>`;
  const get = async () => ({ status: 200, headers: { 'content-type': 'application/rss+xml' }, data: xml });
  const res: any = await tools(fakePool().pool, { get }).fetch_feed.execute({ url: 'https://example.com/rss', limit: 1 }, ctx);
  assert.equal(res.title, 'F');
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].link, 'https://example.com/1');
});

test('check_similarity flags near-duplicates', async () => {
  const { pool } = fakePool(() => [{ text: 'NASA запустила новий телескоп для пошуку екзопланет', at: new Date() }, { text: 'Рецепт борщу', at: new Date() }]);
  const res: any = await tools(pool).check_similarity.execute({ text: 'NASA запустило новий телескоп, щоб шукати екзопланети' }, ctx);
  assert.ok(res.maxScore > 0.6);
});

test('load_skill unknown returns an error object', async () => {
  const res: any = await tools(fakePool().pool).load_skill.execute({ name: 'nope' }, ctx);
  assert.equal(res.error, 'unknown_skill');
});

test('channel-scoped tools refuse without channel context', async () => {
  await assert.rejects(tools(fakePool().pool).get_recent_posts.execute({ limit: 5 }, { ...ctx, channelKey: null }), /channel context/);
});
