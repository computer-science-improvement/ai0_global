/**
 * Spec 023 T1: the content ledger rules against a throwaway Postgres with every migration applied —
 * canonical refs, reuse policy (dated datasets after 300 days), the 7-day shadow window, error everywhere,
 * waiting posts (spec 031), the approval re-check (published only) and network-wide scope.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(await canon('http://x.example/?utm_a=1&utm_b=2'), 'http://x.example/');
  assert.equal(await canon('  https://x.example/a?b=1  '), 'https://x.example/a?b=1');
  assert.equal(await canon('library://pgt023l_old/9'), ref[K_ONCE], 'a moved row resolves to data://');
  assert.equal(await canon('library://pgt023l_old/404'), 'library://pgt023l_old/404', 'an unknown legacy ref stays as given');
  assert.equal(await canon('digest://network/2026-10-06'), 'digest://network/2026-10-06');
  assert.equal(await canon('pdr:12:q3'), 'pdr:12:q3');
  assert.equal(await canon('   '), null);
  assert.equal(await ledger.canonical('HTTP://A.example/x#y'), 'http://a.example/x');
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
