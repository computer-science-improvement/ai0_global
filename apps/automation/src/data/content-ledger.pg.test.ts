/**
 * Spec 023 T1: the content ledger rules against a throwaway Postgres with every migration applied —
 * canonical refs, reuse policy (dated datasets after 300 days), the 7-day shadow window, error everywhere,
 * waiting posts (spec 031), the approval re-check (published only) and network-wide scope; spec 037 T16: one
 * canonical form per URL (migration 075) in the ledger and the waiting posts, and the rewrite of old rows.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { ContentLedger } from './content-ledger';
import { DataStore } from './data-store';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K_DATED = 'pgt023l_dated';
const K_ONCE = 'pgt023l_once';
const R1 = 'telegram:@pgt023l_a';
const R2 = 'instagram:pgt023l-b';
let pool: Pool;
let ledger: ContentLedger;
const ref: Record<string, string> = {};

async function cleanup() {
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref LIKE '%pgt023l%' OR source_ref LIKE '%pgt023l%'`);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = '@pgt023l_a'`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = '@pgt023l_a'`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = '@pgt023l_a'`);
  await pool.query(`DELETE FROM platform_posts WHERE resource_ref = $1`, [R2]);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt023l\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt023l\\_%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  ledger = new ContentLedger(pool);
  await cleanup();
  const store = new DataStore(pool);
  for (const [key, policy] of [[K_DATED, { kind: 'after_days', days: 300 }], [K_ONCE, { kind: 'never' }]] as const) {
    await store.createSchema({
      key, title: key, description: 'ledger test rows', entity: 'event',
      fields: [{ name: 'text', type: 'text', description: 'Text', required: true }],
      roles: { title: 'text' }, dedup_key: ['text'], language: 'uk', default_license: 'own',
      reuse_policy: policy as any, suitable_for: 'tests', contains_personal_data: false, status: 'active',
    }, 'pgtest');
    await store.upsert(key, [{ text: `${key} one` }]);
    const { rows } = await pool.query(`SELECT d.id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [key]);
    ref[key] = `data://${key}/${rows[0].id}`;
  }
  await pool.query(`UPDATE data_items SET legacy_ref = 'library://pgt023l_old/9' WHERE id = $1::bigint`, [ref[K_ONCE].split('/').pop()]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const canon = async (s: string) => (await pool.query(`SELECT content_ref_canonical($1) AS c`, [s])).rows[0].c;

test('canonical refs: URLs, data:// and its library:// alias, other refs', { skip }, async () => {
  assert.equal(await canon('HTTPS://News.Example.COM/Path/A?utm_source=tg&id=7&UTM_Medium=x#frag'), 'https://news.example.com/Path/A?id=7');
  assert.equal(await canon('http://x.example/?utm_a=1&utm_b=2'), 'https://x.example/');
  assert.equal(await canon('  https://x.example/a?b=1  '), 'https://x.example/a?b=1');
  assert.equal(await canon('library://pgt023l_old/9'), ref[K_ONCE], 'a moved row resolves to data://');
  assert.equal(await canon('library://pgt023l_old/404'), 'library://pgt023l_old/404', 'an unknown legacy ref stays as given');
  assert.equal(await canon('digest://network/2026-10-06'), 'digest://network/2026-10-06');
  assert.equal(await canon('pdr:12:q3'), 'pdr:12:q3');
  assert.equal(await canon('   '), null);
  assert.equal(await ledger.canonical('HTTP://A.example/x#y'), 'https://a.example/x');
});

test('record: blank refs are ignored; a repeat moves used_at forward, never back', { skip }, async () => {
  assert.equal(await ledger.record('  ', { resourceRef: R1, origin: 'editor', status: 'published' }), false);
  const t0 = new Date(Date.now() - 10 * 86_400_000);
  assert.equal(await ledger.record('https://pgt023l.example/r', { resourceRef: '@pgt023l_a', origin: 'editor', status: 'published', usedAt: t0 }), true);
  assert.equal(await ledger.record('HTTPS://PGT023L.example/r?utm_x=1', { resourceRef: R1, origin: 'chat', status: 'published', usedAt: new Date(t0.getTime() - 86_400_000) }), false);
  const { rows } = await pool.query(`SELECT used_at, origin FROM content_ledger WHERE resource_ref = $1 AND source_ref = 'https://pgt023l.example/r'`, [R1]);
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].used_at).toISOString(), t0.toISOString(), 'an older use does not move it back');
  assert.equal(rows[0].origin, 'editor');
  await ledger.record('https://pgt023l.example/r', { resourceRef: R1, origin: 'chat', status: 'published' });
  const { rows: r2 } = await pool.query(`SELECT used_at FROM content_ledger WHERE resource_ref = $1 AND source_ref = 'https://pgt023l.example/r'`, [R1]);
  assert.ok(new Date(r2[0].used_at).getTime() > t0.getTime());
});

test('rules: a URL never repeats on a resource; other resources are free; network scope sees it', { skip }, async () => {
  assert.equal(await ledger.used(R1, 'https://pgt023l.example/r'), true);
  assert.equal(await ledger.used('@pgt023l_a', 'https://pgt023l.example/r?utm_campaign=q'), true, 'a channel key and a utm variant are the same');
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/r'), false);
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/r', { scope: 'network' }), true);
});

test('rules: a library item never repeats unless its dataset allows it after N days (dated: 300)', { skip }, async () => {
  const day = 86_400_000;
  await ledger.record(ref[K_ONCE], { resourceRef: R1, origin: 'editor', status: 'published', usedAt: new Date(Date.now() - 900 * day) });
  assert.equal(await ledger.used(R1, ref[K_ONCE]), true, 'never means never');
  assert.equal(await ledger.used(R1, 'library://pgt023l_old/9'), true, 'asked through the legacy alias');

  await ledger.record(ref[K_DATED], { resourceRef: R1, origin: 'editor', status: 'published', usedAt: new Date(Date.now() - 299 * day) });
  assert.equal(await ledger.used(R1, ref[K_DATED]), true, '299 days ago: still blocked');
  await pool.query(`UPDATE content_ledger SET used_at = now() - interval '301 days' WHERE source_ref = $1`, [ref[K_DATED]]);
  assert.equal(await ledger.used(R1, ref[K_DATED]), false, '301 days ago: reusable');
  // on_this_day itself carries the 300-day policy after 060.
  const { rows } = await pool.query(`SELECT reuse_policy FROM data_schemas WHERE key = 'on_this_day'`);
  assert.deepEqual(rows[0].reuse_policy, { kind: 'after_days', days: 300 });
});

test('rules: a shadow preview holds the source 7 days on its resource only; error blocks everywhere', { skip }, async () => {
  await ledger.record('https://pgt023l.example/shadow', { resourceRef: R2, origin: 'platform', status: 'shadowed' });
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/shadow'), true);
  assert.equal(await ledger.used(R1, 'https://pgt023l.example/shadow'), false);
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/shadow', { publishedOnly: true }), false, 'the approval re-check ignores shadows');
  await pool.query(`UPDATE content_ledger SET used_at = now() - interval '8 days' WHERE source_ref = 'https://pgt023l.example/shadow'`);
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/shadow'), false, 'after 7 days it is free again');

  await ledger.record('https://pgt023l.example/broken', { resourceRef: R2, origin: 'strategy', status: 'error', note: 'HTTP 404' });
  const v = await ledger.check(R1, 'https://pgt023l.example/broken');
  assert.equal(v.used, true);
  assert.equal(v.used && v.status, 'error');
});

test('waiting posts (spec 031) count only with waiting: true; the slot itself is excluded', { skip }, async () => {
  await pool.query(`INSERT INTO platform_posts (resource_ref, platform, format, caption, spec, source_ref, status) VALUES ($1, 'instagram', 'ig_photo', 'w', '{}', 'https://pgt023l.example/wait', 'awaiting_approval')`, [R2]);
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/wait'), false);
  const v = await ledger.check(R2, 'https://pgt023l.example/wait', { waiting: true });
  assert.equal(v.used && v.status, 'waiting');

  const slotId = '7d4f8a52-0d0b-4c9e-9f3c-1f2e3d4c5b6a';
  await ledger.record('https://pgt023l.example/own', { resourceRef: R1, origin: 'editor', status: 'shadowed', slotId });
  assert.equal(await ledger.used(R1, 'https://pgt023l.example/own', { excludeSlotId: slotId }), false, 'its own shadow does not block the slot');
  assert.equal(await ledger.used(R1, 'https://pgt023l.example/own'), true);
});

test('the wildcard telegram:* (a TELEGRAM marker without a bound channel) counts network-wide only', { skip }, async () => {
  await ledger.record('https://pgt023l.example/wild', { resourceRef: 'telegram:*', origin: 'backfill', status: 'published' });
  assert.equal(await ledger.used(R1, 'https://pgt023l.example/wild'), false);
  assert.equal(await ledger.used(R1, 'https://pgt023l.example/wild', { scope: 'network' }), true);
});

// ── spec 037 T16 (AI0-110): the Steam deals of 08.10 went out twice with the same source ──────────────

test('037 T16: one URL is one ref — root slash, http, www., trailing slash, default port, click ids; another path or query is another page', { skip }, async () => {
  for (const v of ['https://store.steampowered.com', 'https://store.steampowered.com/', 'http://store.steampowered.com', 'https://www.store.steampowered.com/',
    'HTTPS://Store.SteamPowered.com:443/', 'https://store.steampowered.com/#deals', 'https://store.steampowered.com/?utm_source=tg&fbclid=1&gclid=2']) {
    assert.equal(await canon(v), 'https://store.steampowered.com/', v);
  }
  assert.equal(await canon('https://store.steampowered.com/search/?specials=1'), 'https://store.steampowered.com/search?specials=1');
  assert.equal(await canon('https://www.example.com/News/A/'), 'https://example.com/News/A', 'the path keeps its case');
  assert.equal(await canon('https://store.steampowered.com/?l=ukrainian'), 'https://store.steampowered.com/?l=ukrainian', 'other parameters stay');

  await ledger.record('https://store.pgt023l.example', { resourceRef: R1, origin: 'editor', status: 'published' });
  for (const v of ['https://store.pgt023l.example/', 'http://www.store.pgt023l.example', 'https://store.pgt023l.example/?utm_medium=x']) {
    assert.equal(await ledger.used(R1, v), true, `${v} is the published homepage`);
  }
  assert.equal(await ledger.used(R1, 'https://store.pgt023l.example/search/?specials=1'), false, 'the specials search is another page (09.10 18:01)');
  const { rows } = await pool.query(`SELECT source_ref FROM content_ledger WHERE resource_ref = $1 AND source_ref LIKE 'https://store.pgt023l%'`, [R1]);
  assert.deepEqual(rows.map((r) => r.source_ref), ['https://store.pgt023l.example/']);
});

test('037 T16: a waiting slot or platform post holds its source in any spelling of the URL', { skip }, async () => {
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pgt023l_a', 'approve') ON CONFLICT DO NOTHING`);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ('@pgt023l_a', CURRENT_DATE) RETURNING id`)).rows[0].id;
  const slot = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec)
     VALUES ($1, '@pgt023l_a', now() + interval '2 hours', 'text', 'Steam deals', 'awaiting_approval', $2) RETURNING id`,
    [plan, JSON.stringify({ source: { url: 'https://Steam.pgt023l.example' } })])).rows[0].id;
  const v = await ledger.check(R1, 'https://steam.pgt023l.example/', { waiting: true });
  assert.equal(v.used && v.status, 'waiting', 'written without the root slash, asked with it');
  assert.equal(await ledger.used(R1, 'https://steam.pgt023l.example/', { waiting: true, excludeSlotId: slot }), false, 'the slot itself is excluded');

  await pool.query(`INSERT INTO platform_posts (resource_ref, platform, format, caption, spec, source_ref, status) VALUES ($1, 'instagram', 'ig_photo', 'w', '{}', 'http://www.pgt023l.example/wait2/', 'awaiting_approval')`, [R2]);
  assert.equal(await ledger.used(R2, 'https://pgt023l.example/wait2', { waiting: true }), true);
});

test('037 T16: migration 075 rewrites rows of the old canonical form and merges the ones that become one ref', { skip }, async () => {
  const day = 86_400_000;
  // Rows as 060 wrote them (inserted directly: content_ledger_record would canonicalise them now).
  await pool.query(
    `INSERT INTO content_ledger (resource_ref, source_ref, origin, status, published_post_id, used_at) VALUES
       ($1, 'https://old.pgt023l.example', 'editor', 'published', 11, $2),
       ($1, 'https://old.pgt023l.example/', 'editor', 'published', 12, $3),
       ($1, 'http://www.old.pgt023l.example/a/', 'chat', 'shadowed', NULL, $3)`,
    [R1, new Date(Date.now() - 2 * day), new Date(Date.now() - day)]);
  const m075 = readFileSync(join(__dirname, '..', '..', '..', '..', 'database', 'migrations', '075_ledger_url_canonical.sql'), 'utf8');
  await pool.query(m075);
  await pool.query(m075); // idempotent
  const { rows } = await pool.query(
    `SELECT source_ref, status, published_post_id, origin FROM content_ledger WHERE resource_ref = $1 AND source_ref LIKE '%old.pgt023l%' ORDER BY source_ref, status`, [R1]);
  assert.deepEqual(rows, [
    { source_ref: 'https://old.pgt023l.example/', status: 'published', published_post_id: '12', origin: 'editor' },
    { source_ref: 'https://old.pgt023l.example/a', status: 'shadowed', published_post_id: null, origin: 'chat' },
  ], 'the latest use of the merged rows wins');
});
