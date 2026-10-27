/**
 * Spec 071 R2 against a throwaway Postgres with every migration applied: the similarity corpora (the editor's recent texts, the
 * approval re-check's published texts, a platform's recent captions) can leave out the earlier posts of ONE library row — the
 * row of a dataset that repeats in rounds comes back in round 2 and must not be refused for being like its own round-1 post.
 * The row is matched by its canonical ref (a `library://` alias is the same row); posts of other rows and of no row stay.
 * Creates its own database next to EDITOR_PG_TEST_URL and drops it. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { DataStore } from '../../data/data-store';
import { EditorPlansRepository } from './editor-plans.repository';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { PlatformPostsRepository } from '../platform/platform-posts.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt071b';
const REF = 'instagram:pgt071b';
const LEGACY_B = 'library://pgt_legacy/7';

let db: FreshDb;
let pool: Pool;
let rowA = '';
let rowB = '';

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'r071b');
  pool = db.pool;
  const store = new DataStore(pool);
  await store.createSchema({
    key: 'pgt071b_pdr', title: 'pdr', description: 'similarity test', entity: 'item',
    fields: [{ name: 'label', type: 'text', description: 'Label' }], roles: { title: 'label' }, dedup_key: [], language: 'uk',
    default_license: 'own', reuse_policy: { kind: 'cycle', order: 'sequential' }, suitable_for: 'tests', contains_personal_data: false, status: 'active',
  } as any, 'pgtest');
  await store.upsert('pgt071b_pdr', [{ label: 'a' }, { label: 'b' }] as any);
  const { rows } = await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = 'pgt071b_pdr' ORDER BY d.id`);
  rowA = `data://pgt071b_pdr/${rows[0].id}`;
  rowB = `data://pgt071b_pdr/${rows[1].id}`;
  await pool.query(`UPDATE data_items SET legacy_ref = $2 WHERE id = $1::bigint`, [rows[1].id, LEGACY_B]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'shadow', '{"text":1}')`, [CH]);
});
after(async () => { await db?.drop(); });

const sorted = (xs: string[]) => [...xs].sort();

test('R2: recentTexts and publishedTexts leave out the earlier posts of one row — by canonical ref, alias included — and keep every other post', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  const approvals = new ApprovalsRepository(pool);
  const now = new Date();
  const s = (m: number) => ({ scheduledAt: new Date(now.getTime() - m * 60_000), format: 'text', topic: `t${m}`, angle: null, sourceHints: [] as string[], isExperiment: false });
  await plans.createPlan(CH, '2099-01-01', 'p', null, [s(1), s(2), s(3), s(4)]);
  const claimed = (await plans.claimDue(now, 10)).filter((c) => c.channelKey === CH);
  assert.equal(claimed.length, 4);
  const [a, b, none, viaPlatformSpec] = claimed;
  await plans.updateSlot(a.id, { status: 'published', postSpec: { title: 'A', library_ref: rowA }, renderedPreview: 'пост про рядок А' });
  await plans.updateSlot(b.id, { status: 'published', postSpec: { title: 'B', library_ref: LEGACY_B }, renderedPreview: 'пост про рядок Б' });
  await plans.updateSlot(none.id, { status: 'published', postSpec: { title: 'N', source: { url: 'https://e.example/n' } }, renderedPreview: 'пост без рядка' });
  await plans.updateSlot(viaPlatformSpec.id, { status: 'published', renderedPreview: 'платформний пост про рядок А' });
  await pool.query(`UPDATE editor_slots SET platform_spec = $2::jsonb WHERE id = $1`, [viaPlatformSpec.id, JSON.stringify({ library_ref: rowA })]);
  await pool.query(`INSERT INTO published_posts (channel_id, message_id, title, format) VALUES ($1, 5, 'старий пост без слота', 'text')`, [CH]);

  const all = ['пост про рядок А', 'пост про рядок Б', 'пост без рядка', 'платформний пост про рядок А', 'старий пост без слота'];
  assert.deepEqual(sorted(await plans.recentTexts(CH)), sorted(all), 'no exclude: today\'s corpus');
  assert.deepEqual(sorted(await plans.recentTexts(CH, null, null)), sorted(all));
  assert.deepEqual(sorted(await plans.recentTexts(CH, null, rowA)), sorted(['пост про рядок Б', 'пост без рядка', 'старий пост без слота']), 'row A: both its slots are out (post_spec and platform_spec)');
  assert.deepEqual(sorted(await plans.recentTexts(CH, null, rowB)), sorted(all.filter((t) => t !== 'пост про рядок Б')), 'row B is stored by its legacy alias and still left out');
  assert.deepEqual(sorted(await plans.recentTexts(CH, null, LEGACY_B)), sorted(all.filter((t) => t !== 'пост про рядок Б')), 'asked by the alias: the same row');
  assert.deepEqual(sorted(await plans.recentTexts(CH, none.id, rowA)), sorted(['пост про рядок Б', 'старий пост без слота']), 'the slot exclusion still works beside it');

  const any = randomUUID();
  assert.deepEqual(sorted(await approvals.publishedTexts(CH, any)), sorted(all));
  assert.deepEqual(sorted(await approvals.publishedTexts(CH, any, null)), sorted(all));
  assert.deepEqual(sorted(await approvals.publishedTexts(CH, any, rowA)), sorted(['пост про рядок Б', 'пост без рядка', 'старий пост без слота']));
  assert.deepEqual(sorted(await approvals.publishedTexts(CH, any, rowB)), sorted(all.filter((t) => t !== 'пост про рядок Б')));
});

test('R2: recentCaptions leaves out the earlier posts of one row (spec.library_ref or source_ref) and keeps the rest', { skip }, async () => {
  const repo = new PlatformPostsRepository(pool);
  await repo.insert({ resourceRef: REF, platform: 'instagram', externalId: 'm1', format: 'ig_photo', caption: 'підпис А', spec: { library_ref: rowA }, sourceRef: 'https://e.example/a', status: 'published' });
  await repo.insert({ resourceRef: REF, platform: 'instagram', externalId: 'm2', format: 'ig_photo', caption: 'підпис Б', spec: {}, sourceRef: LEGACY_B, status: 'published' });
  await repo.insert({ resourceRef: REF, platform: 'instagram', externalId: 'm3', format: 'ig_photo', caption: 'підпис за посиланням', spec: {}, sourceRef: 'https://e.example/c', status: 'published' });

  const all = ['підпис А', 'підпис Б', 'підпис за посиланням'];
  assert.deepEqual(sorted(await repo.recentCaptions(REF)), sorted(all));
  assert.deepEqual(sorted(await repo.recentCaptions(REF, 40, false, null)), sorted(all));
  assert.deepEqual(sorted(await repo.recentCaptions(REF, 40, false, rowA)), ['підпис Б', 'підпис за посиланням'].sort(), 'spec.library_ref wins over the cited URL');
  assert.deepEqual(sorted(await repo.recentCaptions(REF, 40, false, rowB)), ['підпис А', 'підпис за посиланням'].sort(), 'source_ref holding the alias');
});
