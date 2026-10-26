/**
 * Spec 068 FR-006 / FR-007 against a throwaway Postgres (every migration applied): the pre-flight's library checks over the real
 * data store — a row through the dataset's own `post_requires`, the `library://` alias, a dataset's unposted count on a resource,
 * the content ledger — and `assessPlanned` end to end. Own schema keys (pgt068p_*), removed at the end.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DataStore } from '../../data/data-store';
import { ContentLedger } from '../../data/content-ledger';
import { NetworkRepository } from '../network/network.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { buildSlotPreflight, pgPreflightMaterial } from './preflight-wiring';
import { makeCard } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt068p';
const REF = `telegram:${CH}`;
const OTHER = 'telegram:@pgt068p_other';
const K = 'pgt068p_prompts';
const K_EMPTY = 'pgt068p_empty';
const LEGACY = 'library://pgtold/pgt068p-row-a';
let pool: Pool;
let ids: Record<string, string>; // title → row id

async function cleanup() {
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref LIKE 'telegram:@pgt068p%'`);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt068p\\_%')`);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt068p\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt068p\\_%'`);
}

const FIELDS = [
  { name: 'title', type: 'text' as const, description: 'Title', required: true },
  { name: 'page_url', type: 'url' as const, description: 'Page' },
  { name: 'prompt_text', type: 'long_text' as const, description: 'Prompt text' },
  { name: 'media_url', type: 'image_url' as const, description: 'Image' },
];

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const store = new DataStore(pool);
  await store.createSchema({
    key: K, title: 'Prompts', description: 'test', entity: 'prompt', fields: FIELDS, roles: { title: 'title', url: 'page_url', body: 'prompt_text', image: 'media_url' },
    dedup_key: ['title'], default_license: 'own', reuse_policy: { kind: 'never' }, post_requires: [['page_url'], ['prompt_text', 'media_url']],
    suitable_for: '', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  await store.createSchema({
    key: K_EMPTY, title: 'Nothing', description: 'test', entity: 'item', fields: FIELDS.slice(0, 2), roles: { title: 'title', url: 'page_url' },
    dedup_key: ['title'], default_license: 'own', reuse_policy: { kind: 'never' }, suitable_for: '', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  const full = { page_url: 'https://p068.example/p', prompt_text: 'a cat, 8k', media_url: 'https://p068.example/i.png' };
  const r = await store.upsert(K, ['a', 'b', 'broken', 'hidden', 'two'].map((title) => ({ title, ...full })));
  assert.equal(r.inserted, 5, JSON.stringify(r.invalid));
  ids = Object.fromEntries((await pool.query(`SELECT d.id::text AS id, d.data->>'title' AS title FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [K])).rows.map((x) => [x.title, x.id]));
  // Data older than the rule: a row that lost its page and prompt, a hidden row, a row with a legacy alias.
  await pool.query(`UPDATE data_items SET data = data - 'page_url' - 'prompt_text' WHERE id = $1::bigint`, [ids.broken]);
  await pool.query(`UPDATE data_items SET data = data - 'prompt_text' WHERE id = $1::bigint`, [ids.two]);
  await pool.query(`UPDATE data_items SET status = 'hidden' WHERE id = $1::bigint`, [ids.hidden]);
  await pool.query(`UPDATE data_items SET legacy_ref = $2 WHERE id = $1::bigint`, [ids.a, LEGACY]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const ref = (title: string) => `data://${K}/${ids[title]}`;

test('row(): active and postable, missing the page, missing a second-group field only (still postable), hidden, unknown, alias', { skip }, async () => {
  const m = pgPreflightMaterial(pool);
  assert.deepEqual(await m.row(ref('a')), { active: true, postable: true, missing: [] });
  const broken = await m.row(ref('broken'));
  assert.deepEqual([broken?.active, broken?.postable], [true, false]);
  assert.ok(broken!.missing.length > 0, 'it says what is missing');
  // The group «page_url» is filled and «prompt_text or media_url» has media_url: postable (an OR group).
  assert.deepEqual(await m.row(ref('two')), { active: true, postable: true, missing: [] });
  assert.equal((await m.row(ref('hidden')))?.active, false);
  assert.equal(await m.row(`data://${K}/999999999`), null);
  assert.equal(await m.row('data://pgt068p_nope/1'), null);
  assert.deepEqual(await m.row(LEGACY), { active: true, postable: true, missing: [] }, 'the library:// alias resolves to the same row');
  assert.equal(await m.row('library://pgtold/pgt068p-missing'), null);
});

test('unposted(): counts postable rows not used on the resource; an unknown dataset is unknown; an empty one is zero', { skip }, async () => {
  const m = pgPreflightMaterial(pool);
  // a, b, two are postable and active; broken is unpostable; hidden is not active.
  assert.equal(await m.unposted(REF, K), 3);
  assert.equal(await m.unposted('telegram:@pgt068p_never', K), 3, 'a resource with no uses has all of them left');
  assert.equal(await m.unposted(REF, 'pgt068p_missing'), null);
  assert.equal(await m.unposted(REF, K_EMPTY), 0);
  await new ContentLedger(pool).record(ref('b'), { resourceRef: REF, origin: 'editor', status: 'published' });
  assert.equal(await m.unposted(REF, K), 2, 'a published row is spent on that resource');
  assert.equal(await m.unposted(OTHER, K), 3, 'and only there');
});

test('assessPlanned over the real store: the rows, the alias, the ledger, the dataset', { skip }, async () => {
  const pf = buildSlotPreflight({ pool, env: () => undefined, ideas: new NetworkRepository(pool), plans: new EditorPlansRepository(pool) });
  const card = makeCard({ channelKey: CH });
  const slot = (...sourceHints: string[]) => ({ channelKey: CH, format: 'text', sourceHints });

  assert.equal(await pf.assessPlanned(slot(ref('a')), card), null, 'a good row');
  assert.equal((await pf.assessPlanned(slot(ref('broken')), card))?.code, 'preflight_no_material');
  assert.match((await pf.assessPlanned(slot(ref('broken')), card))?.reason ?? '', /без /);
  assert.equal((await pf.assessPlanned(slot(ref('hidden')), card))?.code, 'preflight_no_material');
  assert.equal((await pf.assessPlanned(slot(`data://${K}/999999999`), card))?.code, 'preflight_no_material');
  const spent = await pf.assessPlanned(slot(ref('b')), card);
  assert.equal(spent?.code, 'preflight_source_used', 'b was published on this resource above');
  assert.match(spent?.reason ?? '', /уже використано/);
  assert.equal(await pf.assessPlanned({ ...slot(ref('b')), resourceRef: OTHER }, card), null, 'but not on another resource');

  // The alias of a row spent through its data:// ref is spent as well.
  await new ContentLedger(pool).record(ref('a'), { resourceRef: REF, origin: 'editor', status: 'published' });
  assert.equal((await pf.assessPlanned(slot(LEGACY), card))?.code, 'preflight_source_used');

  // A dataset hint: rows left pass; spend the rest and it is no material; the broken one beside a usable one does not stop the slot.
  assert.equal(await pf.assessPlanned(slot(`library:${K}`), card), null);
  assert.equal(await pf.assessPlanned(slot(ref('broken'), ref('two')), card), null, 'one usable source is enough');
  await new ContentLedger(pool).record(ref('two'), { resourceRef: REF, origin: 'editor', status: 'published' });
  const empty = await pf.assessPlanned(slot(`library:${K}/anime`), card);
  assert.equal(empty?.code, 'preflight_no_material');
  assert.match(empty?.reason ?? '', new RegExp(`у датасеті ${K} немає непублікованих рядків для ${REF}`));
  assert.equal((await pf.assessPlanned(slot(ref('broken'), ref('two')), card))?.code, 'preflight_no_material', 'all sources out: reported, most informative first');
  assert.equal((await pf.assessPlanned(slot(`library:${K_EMPTY}`), card))?.code, 'preflight_no_material', 'a dataset without rows');
  assert.equal(await pf.assessPlanned(slot('library:pgt068p_missing'), card), null, 'an unknown dataset cannot be judged');
});
