/**
 * Spec 023 T1: migration 060 (content_ledger) on production-shaped data. Builds its own database next to
 * EDITOR_PG_TEST_URL: init.sql + migrations before 058, the legacy content tables seeded with `posted`
 * markers (TELEGRAM, channel keys, IG:, error:), 058 (the data store move), then the other three legacy
 * ledgers (posted_news, published_posts, platform_posts) plus editor slots and strategy bindings, and only
 * then 060. Checks the backfill from all four ledgers, its idempotency (function rerun and a full rerun of
 * the migration), the strategy-posted exclusion in search_library / query_data, and the live triggers.
 * Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { seedLegacyTables } from './testing/legacy-seed';
import { ContentLedger } from './content-ledger';
import { queryDataset } from './data-query';
import { DataStore } from './data-store';
import { EditorPlansRepository } from '../editor/repo/editor-plans.repository';
import { buildReadTools } from '../editor/tools/read-tools';
import type { ToolContext } from '../editor/harness/tool';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const M060 = readFileSync(join(MIGRATIONS, '060_content_ledger.sql'), 'utf8');
const N = 60;
const IG = '7f0c';

let admin: Client;
let pool: Pool;
let dbName: string;
let firstRun: Record<string, number> = {};
const recipeIds: Record<string, string> = {};

function withDb(u: string, db: string): string {
  const x = new URL(u);
  x.pathname = '/' + db;
  return x.toString();
}

async function applyFile(c: Pick<Client, 'query'>, sql: string) {
  await c.query('BEGIN');
  try { await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
}

const files = () => readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort();

/** Other ledgers, bindings and editor rows, written after 058 and before 060 (as in production). */
async function seedOtherLedgers(c: Pick<Client, 'query'>) {
  // Channels and bindings: recipes run on @rec_a (recipes) and @rec_b (recipe-carousel), quotes on @quotes_c; facts have none.
  for (const key of ['@rec_a', '@rec_b', '@quotes_c']) {
    await c.query(`INSERT INTO tracked_channels (channel_key, is_mine) VALUES ($1, true)`, [key]);
  }
  await c.query(
    `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, platform)
     SELECT x.ext, x.type, t.id, '0 9 * * *', 'telegram' FROM (VALUES ('rec-a', 'recipes', '@rec_a'), ('rec-b', 'recipe-carousel', '@rec_b'), ('q-c', 'quotes', '@quotes_c')) x(ext, type, ch)
       JOIN tracked_channels t ON t.channel_key = x.ch`);
  // published_posts: a strategy (image URL with utm and an upper-case host), the editor (legacy library ref), a post without a source.
  const { rows: r } = await c.query(`SELECT id::text FROM legacy_recipes ORDER BY created_at OFFSET 3 LIMIT 3`);
  recipeIds.a = r[0].id; recipeIds.b = r[1].id; recipeIds.c = r[2].id;
  await c.query(
    `INSERT INTO published_posts (channel_id, message_id, source_url, title, strategy_type, posted_at) VALUES
       ('@strategy_ch', 1, 'HTTPS://IMG.Example.COM/x.jpg?utm_source=tg&w=1#top', 'r', 'recipes', now() - interval '3 days'),
       ('@strategy_ch', 2, 'HTTPS://IMG.Example.COM/x.jpg?w=1', 'r again', 'recipes', now() - interval '1 day'),
       ('@editor_ch', 3, 'library://recipes/' || $1, 'e', 'editor', now() - interval '2 days'),
       ('@editor_ch', 4, NULL, 'no source', 'editor', now())`, [recipeIds.c]);
  // platform_posts: published, shadowed, failed (not recorded).
  await c.query(
    `INSERT INTO platform_posts (resource_ref, platform, format, caption, spec, source_ref, status, posted_at) VALUES
       ('instagram:aaa', 'instagram', 'ig_photo', 'c1', '{}', 'https://src.example/p1', 'published', now() - interval '5 days'),
       ('instagram:aaa', 'instagram', 'ig_photo', 'c2', '{}', 'https://src.example/p2', 'shadowed', now() - interval '2 days'),
       ('instagram:aaa', 'instagram', 'ig_photo', 'c3', '{}', 'https://src.example/p3', 'failed', now())`);
  // posted_news: a published news URL and an error marker.
  await c.query(
    `INSERT INTO posted_news (source_url, title, channel_id, content_type, created_at) VALUES
       ('https://news.example/a?utm_campaign=z', 'A', '@news_ch', 'news', now() - interval '10 days'),
       ('https://news.example/bad', 'dead link', '@news_ch', 'error', now() - interval '9 days')`);
  // An editor shadow preview that names both a library item and a source URL.
  await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@shadow_ch', 'shadow')`);
  const { rows: p } = await c.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ('@shadow_ch', current_date) RETURNING id`);
  await c.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec, updated_at)
     VALUES ($1, '@shadow_ch', now(), 'text', 't', 'shadowed', $2, now() - interval '1 day')`,
    [p[0].id, JSON.stringify({ library_ref: `library://recipes/${recipeIds.b}`, source: { url: 'https://shadow.example/s' } })]);
}

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${new URL(url).pathname.slice(1) || 'postgres'}_m060_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: withDb(url, dbName) });
  await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    for (const f of files().filter((x) => x < '058')) await applyFile(c, readFileSync(join(MIGRATIONS, f), 'utf8'));
    await seedLegacyTables(c, N);
    for (const f of files().filter((x) => x >= '058' && x < '060')) await applyFile(c, readFileSync(join(MIGRATIONS, f), 'utf8'));
    await seedOtherLedgers(c);
    const { rows } = await c.query(`SELECT to_regclass('public.content_ledger') AS t`);
    assert.equal(rows[0].t, null, 'the ledger does not exist before 060');
    await applyFile(c, M060);
    const { rows: n } = await c.query(`SELECT origin, count(*)::int AS n FROM content_ledger GROUP BY origin`);
    firstRun = Object.fromEntries(n.map((x) => [x.origin, x.n]));
    for (const f of files().filter((x) => x > '060')) await applyFile(c, readFileSync(join(MIGRATIONS, f), 'utf8'));
  } finally {
    await c.end();
  }
  pool = new Pool({ connectionString: withDb(url, dbName), max: 4 });
});

after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await admin.end();
});

const dataRefOf = async (table: string, legacyId: string) => {
  const { rows } = await pool.query(
    `SELECT 'data://' || s.key || '/' || d.id AS ref FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE d.legacy_ref = $1`,
    [`library://${table}/${legacyId}`]);
  return rows[0].ref as string;
};

test('backfill: every non-TELEGRAM posted marker is in the ledger with its resource, status and time', { skip }, async () => {
  assert.ok(firstRun.backfill > 0, `backfilled rows: ${JSON.stringify(firstRun)}`);
  const { rows: missing } = await pool.query(
    `SELECT d.id, e.key FROM data_items d JOIN data_schemas s ON s.id = d.schema_id CROSS JOIN LATERAL jsonb_each(d.posted) e
      WHERE e.key NOT IN ('TELEGRAM', 'error:TELEGRAM')
        AND NOT EXISTS (
          SELECT 1 FROM content_ledger l
           WHERE l.source_ref = 'data://' || s.key || '/' || d.id
             AND l.status = CASE WHEN e.key LIKE 'error:%' THEN 'error' ELSE 'published' END
             AND l.resource_ref = (SELECT r FROM content_posted_resources(s.key, regexp_replace(e.key, '^error:', '')) r LIMIT 1))`);
  assert.deepEqual(missing, [], 'no marker is lost');

  // A recipe with {TELEGRAM, @chan_a} (seed row 1) and one with {@chan_b, error:@chan_c, IG:7f0c} (row 2).
  const { rows: seeded } = await pool.query(`SELECT id::text, posted FROM legacy_recipes ORDER BY created_at LIMIT 3`);
  const r1 = await dataRefOf('recipes', seeded[1].id);
  const r2 = await dataRefOf('recipes', seeded[2].id);
  const rowsOf = async (ref: string) => (await pool.query(
    `SELECT resource_ref, status, origin, used_at, note FROM content_ledger WHERE source_ref = $1 ORDER BY resource_ref, status`, [ref])).rows;
  const a = await rowsOf(r1);
  assert.deepEqual(a.map((x) => [x.resource_ref, x.status]), [
    ['telegram:@chan_a', 'published'], ['telegram:@rec_a', 'published'], ['telegram:@rec_b', 'published'],
  ], 'TELEGRAM → every channel with a recipes / recipe-carousel binding');
  assert.equal(new Date(a[0].used_at).toISOString(), new Date(seeded[1].posted['@chan_a']).toISOString(), 'used_at = the marker time');
  const b = await rowsOf(r2);
  assert.deepEqual(b.map((x) => [x.resource_ref, x.status]), [
    ['instagram:7f0c', 'published'], ['telegram:@chan_b', 'published'], ['telegram:@chan_c', 'error'],
  ]);
  assert.equal(b.find((x) => x.status === 'error').note, 'dead page (HTTP 404)');
  assert.ok(b.every((x) => x.origin === 'backfill'));

  // Quotes are bound to @quotes_c; facts have no binding at all, so their TELEGRAM marker becomes the wildcard.
  const count = async (rr: string, like: string) => (await pool.query(
    `SELECT count(*)::int AS n FROM content_ledger WHERE resource_ref = $1 AND source_ref LIKE $2`, [rr, like])).rows[0].n;
  assert.ok(await count('telegram:@quotes_c', 'data://quotes/%') > 0);
  assert.equal(await count('telegram:*', 'data://quotes/%'), 0);
  assert.ok(await count('telegram:*', 'data://facts/%') > 0);
  assert.equal(IG, '7f0c');
});

test('backfill: published_posts, platform_posts, posted_news and editor shadow slots, canonical refs', { skip }, async () => {
  const one = async (where: string, params: unknown[] = []) =>
    (await pool.query(`SELECT resource_ref, source_ref, status, published_post_id, platform_post_id, slot_id FROM content_ledger WHERE ${where} ORDER BY source_ref`, params)).rows;
  const strat = await one(`resource_ref = 'telegram:@strategy_ch'`);
  assert.deepEqual(strat.map((x) => x.source_ref), ['https://img.example.com/x.jpg?w=1'], 'lower-case host, no utm_*, no fragment; two posts → one row');
  const editor = await one(`resource_ref = 'telegram:@editor_ch'`);
  assert.deepEqual(editor.map((x) => x.source_ref), [await dataRefOf('recipes', recipeIds.c)], 'library:// resolves to data://');
  assert.ok(editor[0].published_post_id);
  const plat = await one(`resource_ref = 'instagram:aaa'`);
  assert.deepEqual(plat.map((x) => [x.source_ref, x.status]), [['https://src.example/p1', 'published'], ['https://src.example/p2', 'shadowed']], 'failed posts are not recorded');
  const news = await one(`resource_ref = 'telegram:@news_ch'`);
  assert.deepEqual(news.map((x) => [x.source_ref, x.status]), [['https://news.example/a', 'published'], ['https://news.example/bad', 'error']]);
  const shadow = await one(`resource_ref = 'telegram:@shadow_ch'`);
  assert.deepEqual(shadow.map((x) => x.status), ['shadowed', 'shadowed']);
  assert.ok(shadow.some((x) => x.source_ref === 'https://shadow.example/s'));
});

test('backfill is idempotent: a rerun of the function and of the whole migration adds nothing', { skip }, async () => {
  const before = (await pool.query(`SELECT count(*)::int AS n, max(id) AS m FROM content_ledger`)).rows[0];
  const r = await new ContentLedger(pool).backfill();
  assert.equal(r.total, 0, JSON.stringify(r));
  const c = await pool.connect();
  try { await applyFile(c, M060); } finally { c.release(); }
  const after = (await pool.query(`SELECT count(*)::int AS n, max(id) AS m FROM content_ledger`)).rows[0];
  assert.equal(after.n, before.n);
  assert.equal(String(after.m), String(before.m));
  const { rows } = await pool.query(`SELECT reuse_policy FROM data_schemas WHERE key IN ('on_this_day','birthdays','name_days') ORDER BY key`);
  assert.ok(rows.every((x) => x.reuse_policy.kind === 'after_days' && x.reuse_policy.days === 300), 'dated datasets repeat after 300 days');
});

test('a strategy-posted item is excluded from search_library and query_data on that channel only', { skip }, async () => {
  const { rows: seeded } = await pool.query(`SELECT id::text FROM legacy_recipes ORDER BY created_at LIMIT 3`);
  const ref1 = await dataRefOf('recipes', seeded[1].id);
  const tools = Object.fromEntries(buildReadTools({ pool, readonly: {} as any, skills: {} as any }).map((t) => [t.name, t]));
  const ctxOf = (channelKey: string): ToolContext => ({ runId: 'r', role: 'executor', channelKey });
  const ids = async (ch: string) => {
    const out = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r: any = await tools.search_library.execute({ table: 'recipes', include_used: false, today_only: false, limit: 20 }, ctxOf(ch));
      for (const row of r.items ?? r.rows ?? []) out.add(String(row.id));
    }
    return out;
  };
  // @chan_a has the marker; @rec_a got it through the TELEGRAM binding; a fresh channel has not.
  const schema = (await new DataStore(pool).getSchema('recipes'))!;
  const unposted = async (rr: string) => (await queryDataset(pool, schema, { audience: 'agent', fields: ['title'], unpostedOn: rr, order: 'oldest', limit: 200, today: { month: 1, day: 1 } })).rows.map((x) => x.ref);
  assert.ok(!(await unposted('telegram:@chan_a')).includes(ref1));
  assert.ok(!(await unposted('telegram:@rec_a')).includes(ref1));
  assert.ok((await unposted('telegram:@fresh')).includes(ref1));
  assert.ok(!(await ids('@chan_a')).has(seeded[1].id), 'search_library never offers it on @chan_a');
  const plans = new EditorPlansRepository(pool);
  assert.equal(await plans.sourceAlreadyPosted('@chan_a', `library://recipes/${seeded[1].id}`), true);
  assert.equal(await plans.sourceAlreadyPosted('@fresh', `library://recipes/${seeded[1].id}`), false);
  // An error marker excludes the item everywhere.
  const ref2 = `library://recipes/${seeded[2].id}`;
  assert.equal(await plans.sourceAlreadyPosted('@fresh', ref2), true, 'error:@chan_c blocks every resource');
});

test('live: a strategy marker and a posted_news row reach the ledger through the 060 triggers', { skip }, async () => {
  const { rows } = await pool.query(`SELECT id::text FROM quotes ORDER BY id LIMIT 1`);
  const qid = rows[0].id;
  await pool.query(`UPDATE quotes SET posted = posted || jsonb_build_object('@live_ch', now()) WHERE id = $1`, [qid]);
  const ref = await dataRefOf('quotes', qid);
  const { rows: l } = await pool.query(`SELECT origin, status FROM content_ledger WHERE resource_ref = 'telegram:@live_ch' AND source_ref = $1`, [ref]);
  assert.deepEqual(l, [{ origin: 'strategy', status: 'published' }]);
  await pool.query(`INSERT INTO posted_news (source_url, title, channel_id, content_type) VALUES ('https://Live.example/n?utm_source=x', 't', '@live_ch', 'news')`);
  assert.equal(await new ContentLedger(pool).used('@live_ch', 'https://live.example/n'), true);
  // The stats count network-wide use from the ledger.
  await pool.query(`SELECT data_schema_stats_refresh()`);
  const { rows: st } = await pool.query(
    `SELECT st.unposted_network::int AS u, st.rows_active::int AS a FROM data_schema_stats st JOIN data_schemas s ON s.id = st.schema_id WHERE s.key = 'recipes'`);
  assert.ok(st[0].u < st[0].a, 'used recipes are not unposted network-wide');
});
