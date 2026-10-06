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

// search_library is a wrapper over the data store (spec 032): the dataset schema, then one data_items query.
const RECIPES_SCHEMA = {
  id: 's-rec', key: 'recipes', status: 'active', roles: { title: ['title_uk', 'title'], body: 'description', image: 'image_url', category: 'category' },
  fields: ['title', 'title_uk', 'description', 'kcal', 'ingredients', 'ingredients_uk', 'instructions', 'instructions_uk', 'telegraph_url', 'license', 'source_name', 'image_url', 'category']
    .map((name) => ({ name, type: 'text', description: '' })),
};
const OTD_SCHEMA = { id: 's-otd', key: 'on_this_day', status: 'active', roles: { title: 'title', month: 'month', day: 'day' },
  fields: ['title', 'month', 'day', 'license', 'source_name'].map((name) => ({ name, type: name === 'month' || name === 'day' ? 'int' : 'text', description: '' })) };
const libraryPool = (items: any[] = []) => fakePool((sql, params) => {
  if (/FROM data_schemas WHERE key = \$1/.test(sql)) return [params[0] === 'recipes' ? RECIPES_SCHEMA : OTD_SCHEMA];
  return items;
});

test('search_library keeps its answer shape: legacy id, text, extra and the library ref; used rows are skipped', async () => {
  const { pool, calls } = libraryPool([{
    id: '9001', legacy_ref: 'library://recipes/42', title: 'Борщ', body: 'Класичний борщ', image_url: 'https://x/b.jpg', url: null, category: 'soup',
    data: { kcal: 300, ingredients: 'буряк', ingredients_uk: 'буряк, капуста', instructions: 'x'.repeat(1700), license: 'unknown', source_name: 'site' },
  }]);
  const res: any = await tools(pool).search_library.execute({ table: 'recipes', query: 'борщ', today_only: false, include_used: false, limit: 5 }, ctx);
  const q = calls[1];
  assert.match(q.sql, /FROM data_items d WHERE/);
  assert.match(q.sql, /NOT \(d\.posted \? \$\d+\)/);
  assert.ok(q.params.includes('@chan') && q.params.includes('telegram:@chan'));
  assert.ok(q.params.includes('%борщ%'));
  assert.match(q.sql, /ORDER BY d\.created_at DESC/);
  const it = res.items[0];
  assert.equal(res.table, 'recipes');
  assert.equal(it.id, '42');
  assert.equal(it.library_ref, 'library://recipes/42');
  assert.equal(it.text, 'Класичний борщ');
  assert.equal(it.extra.ingredients, 'буряк, капуста');
  assert.equal(it.extra.instructions.length, 1500);
  assert.equal(it.extra.license, 'unknown');
  assert.equal(it.extra.telegraph_url, null);
});

test('search_library today_only filters on the envelope month/day and rejects datasets without dates', async () => {
  const { pool, calls } = libraryPool();
  await tools(pool).search_library.execute({ table: 'on_this_day', today_only: true, include_used: true, limit: 3 }, ctx);
  assert.match(calls[1].sql, /d\.event_month = \$\d+ AND d\.event_day = \$\d+/);
  assert.ok(calls[1].params.includes(10) && calls[1].params.includes(1));
  assert.doesNotMatch(calls[1].sql, /used AS/, 'include_used: no dedup');
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
