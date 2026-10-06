/**
 * Spec 032 T1 against a throwaway Postgres with every migration applied: data_items_upsert (insert, merge,
 * invalid rows, dedup key), the envelope from roles, and schema versioning in the database.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DataStore, DataStoreError } from './data-store';
import type { FieldDef } from './data.types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'pgt032_books';
let pool: Pool;
let store: DataStore;

const FIELDS: FieldDef[] = [
  { name: 'isbn', type: 'text', description: 'ISBN', required: true },
  { name: 'title', type: 'text', description: 'Book title', required: true },
  { name: 'pages', type: 'int', description: 'Pages' },
  { name: 'genre', type: 'enum', description: 'Genre', enum: ['novel', 'poetry'] },
  { name: 'cover', type: 'image_url', description: 'Cover' },
  { name: 'released', type: 'date', description: 'Release date' },
  { name: 'tags', type: 'text_list', description: 'Tags' },
  { name: 'note', type: 'long_text', description: 'Note' },
];

async function cleanup() {
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032\\_%')`);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt032\\_%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  store = new DataStore(pool);
  await cleanup();
  await store.createSchema({
    key: K, title: 'Books', description: 'Test books', entity: 'book', fields: FIELDS,
    roles: { title: 'title', body: 'note', image: 'cover', category: 'genre', date: 'released' },
    dedup_key: ['isbn'], language: 'uk', default_license: 'own', reuse_policy: { kind: 'never' },
    suitable_for: '', contains_personal_data: false, status: 'active',
  }, 'pgtest');
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const item = async (key: string) =>
  (await pool.query(`SELECT d.* FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 AND d.external_key = $2`, [K, key])).rows[0];

test('upsert inserts, fills the envelope from roles and builds a lower-cased external key', { skip }, async () => {
  const r = await store.upsert(K, [
    { isbn: 'ISBN-1', title: 'Кобзар', pages: '320', genre: 'poetry', cover: 'https://x.ua/c.jpg', released: '1840-04-30', tags: 'a|b', note: 'Збірка' },
  ]);
  assert.deepEqual({ ...r, invalid: r.invalid.length }, { inserted: 1, updated: 0, skipped: 0, invalid: 0, invalid_rows: 0, rejected: [] });
  const row = await item('isbn-1');
  assert.ok(row, 'external key is lower-cased');
  assert.deepEqual(row.data.tags, ['a', 'b']);
  assert.equal(row.data.pages, 320);
  assert.equal(row.title, 'Кобзар');
  assert.equal(row.body, 'Збірка');
  assert.equal(row.image_url, 'https://x.ua/c.jpg');
  assert.equal(row.category, 'poetry');
  assert.equal(row.lang, 'uk', 'lang falls back to the schema language');
  assert.equal(row.license, 'own', 'license falls back to the schema default');
  assert.equal(row.event_month, 4);
  assert.equal(row.event_day, 30);
  assert.equal(row.schema_version, 1);
  assert.match(row.search, /кобзар/i);
});

test('upsert merges every given field on conflict, or only p_update_fields; unchanged rows are skipped', { skip }, async () => {
  const r1 = await store.upsert(K, [{ isbn: 'isbn-1', title: 'Кобзар (1840)', pages: 114 }]);
  assert.equal(r1.updated, 1);
  let row = await item('isbn-1');
  assert.equal(row.data.title, 'Кобзар (1840)');
  assert.equal(row.data.genre, 'poetry', 'fields not given are kept');

  const r2 = await store.upsert(K, [{ isbn: 'isbn-1', title: 'Ignored', pages: 200 }], { updateFields: ['pages'] });
  assert.equal(r2.updated, 1);
  row = await item('isbn-1');
  assert.equal(row.data.pages, 200);
  assert.equal(row.data.title, 'Кобзар (1840)');

  const r3 = await store.upsert(K, [{ isbn: 'isbn-1', title: 'Ignored' }], { updateFields: [] });
  assert.equal(r3.skipped, 1, 'an empty update list means insert-or-skip');
  const r4 = await store.upsert(K, [{ isbn: 'isbn-1', pages: 200, title: 'Кобзар (1840)' }]);
  assert.equal(r4.skipped, 1, 'no change → skipped');
});

test('invalid rows are reported per field and never abort the batch', { skip }, async () => {
  const rows = [
    { isbn: 'b-2', title: 'Ok' },
    { isbn: 'b-3', title: 'Bad', pages: 'many', genre: 'prose' },
    { title: 'no key' },
    { isbn: 'b-4', title: 'Ok too' },
  ];
  // SQL-level validation (zod off): the database reports the same kinds of errors.
  const raw = await store.upsert(K, rows, { validate: false });
  assert.equal(raw.inserted, 2);
  assert.equal(raw.invalid_rows, 2);
  assert.deepEqual(raw.invalid.map((e) => [e.row, e.field, e.error]).sort(), [
    [1, 'genre', 'not one of the allowed values'],
    [1, 'pages', 'expected an integer'],
    [2, 'isbn', 'dedup key fields are empty'],
  ].sort());
  // zod pre-check rejects them before SQL, row numbers index the input.
  const z = await store.upsert(K, [{ isbn: 'b-5', title: 'x', pages: 'many' }, { isbn: 'b-6', title: 'y', cover: 'not a url' }]);
  assert.equal(z.inserted, 0);
  assert.deepEqual(z.rejected.map((e) => [e.row, e.field]), [[0, 'pages'], [1, 'cover']]);
  assert.equal(z.invalid_rows, 2);
});

test('an explicit _external_key wins over the dedup fields', { skip }, async () => {
  const r = await store.upsert(K, [{ isbn: 'zz', title: 'Keyed', _external_key: 'custom-key-1' }]);
  assert.equal(r.inserted, 1);
  assert.ok(await item('custom-key-1'));
});

test('missing required fields are reported; defaults fill them on insert', { skip }, async () => {
  const r = await store.upsert(K, [{ isbn: 'b-7' }], { validate: false });
  assert.deepEqual(r.invalid, [{ row: 0, field: 'title', error: 'required' }]);
});

test('with an import id: inserted rows carry it, updated rows are snapshotted once', { skip }, async () => {
  const sid = (await store.requireSchema(K)).id;
  const imp = (await pool.query(`INSERT INTO data_imports (schema_id, schema_version, source) VALUES ($1, 1, 'api') RETURNING id`, [sid])).rows[0].id;
  await store.upsert(K, [{ isbn: 'b-8', title: 'New' }, { isbn: 'b-2', title: 'Changed' }, { isbn: 'b-2', title: 'Changed twice' }], { importId: imp });
  assert.equal((await item('b-8')).import_id, imp);
  const snaps = (await pool.query(`SELECT data FROM data_import_snapshots WHERE import_id = $1`, [imp])).rows;
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].data.title, 'Ok', 'the snapshot keeps the value before the import');
});

test('description-only edit keeps the version; structural edit bumps it and writes data_schema_versions', { skip }, async () => {
  const before = await store.requireSchema(K);
  const r1 = await store.updateSchema(K, {
    description: 'Books we love',
    fields: before.fields.map((f) => (f.name === 'title' ? { ...f, description: 'Full title of the book', filterable: true } : f)),
  }, { changedBy: 'pgtest' });
  assert.equal(r1.schema.version, 1);
  assert.equal(r1.diff.structural, false);

  const r2 = await store.updateSchema(K, {
    fields: [...r1.schema.fields, { name: 'author', type: 'text', description: 'Author' }],
  }, { changedBy: 'pgtest', reason: 'add author' });
  assert.equal(r2.schema.version, 2);
  assert.equal(r2.schema.fields.find((f) => f.name === 'author')!.since_version, 2);
  const v = (await pool.query(`SELECT version, changed_by, reason FROM data_schema_versions WHERE schema_id = $1 ORDER BY version`, [before.id])).rows;
  assert.deepEqual(v.map((x) => [x.version, x.changed_by, x.reason]), [[1, 'pgtest', 'created'], [2, 'pgtest', 'add author']]);

  // New writes are stamped with the new version; old rows keep theirs.
  await store.upsert(K, [{ isbn: 'b-9', title: 'V2', author: 'Шевченко' }]);
  assert.equal((await item('b-9')).schema_version, 2);
  assert.equal((await item('b-4')).schema_version, 1);
});

test('the database refuses removal or retyping of a field even without the TS check', { skip }, async () => {
  await assert.rejects(pool.query(`UPDATE data_schemas SET fields = fields - 2 WHERE key = $1`, [K]), /cannot be removed or renamed/);
  await assert.rejects(
    pool.query(`UPDATE data_schemas SET fields = jsonb_set(fields, '{2,type}', '"number"') WHERE key = $1`, [K]), /cannot change/);
  await assert.rejects(store.updateSchema(K, { fields: (await store.requireSchema(K)).fields.slice(1) }, { changedBy: 'x' }),
    (e: unknown) => e instanceof DataStoreError && e.code === 'invalid');
  await assert.rejects(pool.query(`UPDATE data_schemas SET dedup_key = '{title}' WHERE key = $1`, [K]), /dedup_key/);
});

test('a roles change re-fills the envelope of existing rows', { skip }, async () => {
  await store.updateSchema(K, { roles: { title: 'isbn', category: 'genre' } }, { changedBy: 'pgtest' });
  assert.equal((await item('isbn-1')).title, 'isbn-1');
  assert.equal((await item('isbn-1')).body, null);
});

test('patchByLegacyRef returns false for an unknown ref; an unknown schema is not_found', { skip }, async () => {
  assert.equal(await store.patchByLegacyRef(K, 'library://nope/1', { title: 'x' }), false);
  await assert.rejects(store.upsert('pgt032_missing', [{}]), (e: unknown) => e instanceof DataStoreError && e.code === 'not_found');
  await assert.rejects(store.callUpsert('pgt032_missing', [{}]), /unknown data schema/);
});
