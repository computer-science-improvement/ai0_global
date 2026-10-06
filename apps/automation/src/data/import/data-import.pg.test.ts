/**
 * Spec 032 T4 against a throwaway Postgres with every migration applied: CSV/JSON/JSONL import with dry
 * run, commit, audit and undo; inference → new dataset → import of 1 000 rows; the rows API.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { DataImportService } from './data-import.service';
import { DataStoreError } from '../data-store';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'pgt032i_books';
let pool: Pool;
let svc: DataImportService;
let park: string;

async function cleanup() {
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032i\\_%')`);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032i\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt032i\\_%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  park = mkdtempSync(join(tmpdir(), 'pgt032i-'));
  svc = new DataImportService(pool, park);
  await cleanup();
  await svc.store.createSchema({
    key: K, title: 'Books', description: 'Test books', entity: 'book',
    fields: [
      { name: 'isbn', type: 'text', description: 'ISBN', required: true },
      { name: 'title', type: 'text', description: 'Title', required: true },
      { name: 'pages', type: 'int', description: 'Pages' },
      { name: 'genre', type: 'enum', description: 'Genre', enum: ['novel', 'poetry'] },
      { name: 'cover', type: 'image_url', description: 'Cover' },
    ],
    roles: { title: 'title', image: 'cover', category: 'genre' }, dedup_key: ['isbn'], language: 'uk',
    default_license: 'unknown', reuse_policy: { kind: 'never' }, suitable_for: '', contains_personal_data: false, status: 'active',
  }, 'pgtest');
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
  rmSync(park, { recursive: true, force: true });
});

const item = async (key: string) =>
  (await pool.query(`SELECT d.* FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 AND d.external_key = $2`, [K, key])).rows[0];

test('rows API: dry run counts only; commit inserts and audits', { skip }, async () => {
  const rows = [
    { isbn: 'a-1', title: 'Кобзар', pages: 320, genre: 'poetry' },
    { isbn: 'a-2', title: 'Лісова пісня', genre: 'poetry' },
    { isbn: 'a-3', title: 'Тигролови', genre: 'novel', pages: 'many' },
  ];
  const dry = await svc.importRows(K, rows, { dryRun: true, createdBy: 'pgtest' });
  assert.deepEqual([dry.new, dry.updated, dry.invalid, dry.status], [2, 0, 1, 'dry_run']);
  assert.equal(await item('a-1'), undefined, 'a dry run writes nothing');
  const r = await svc.importRows(K, rows, { createdBy: 'pgtest' });
  assert.deepEqual([r.inserted, r.invalid, r.status], [2, 1, 'committed']);
  assert.deepEqual(r.errors.map((e) => [e.row, e.field]), [[3, 'pages']]);
  const imp = await svc.getImport(r.import_id);
  assert.deepEqual([imp.source, imp.inserted, imp.invalid, imp.schema], ['api', 2, 1, K]);
  await assert.rejects(svc.importRows(K, Array.from({ length: 5001 }, () => ({})), { createdBy: 'x' }), /at most 5000/);
});

test('CSV into an existing dataset: BOM, semicolons, mapping, _extra, duplicates (last wins), broken rows', { skip }, async () => {
  const csv = '﻿ISBN;Назва;Сторінки;Жанр;Обкладинка;Примітка\n'
    + 'a-1;Кобзар (1840);114;poetry;https://img.example/k.jpg;перше видання\n'   // updates a-1
    + 'a-4;"Енеїда; поема";300;poetry;;\n'                                        // new
    + 'a-5;Intermezzo;abc;novel;;\n'                                              // invalid int
    + 'a-6;Місто;;novel;not-a-url;\n'                                             // invalid url
    + 'a-7;"broken"x;1;novel;;\n'                                                 // broken CSV row
    + 'a-8;Сад;10\n'                                                              // wrong column count
    + 'a-4;"Енеїда (повна)";310;poetry;;\n';                                      // duplicate key, last wins
  const dry = await svc.dryRun({
    schemaKey: K, file: { buffer: Buffer.from(csv), filename: 'books.csv' },
    mapping: { 'Назва': 'title', 'Сторінки': 'pages', 'Жанр': 'genre', 'Обкладинка': 'cover' },
    extra: 'keep', createdBy: 'pgtest',
  });
  assert.equal(dry.delimiter, ';');
  assert.equal(dry.mapping['ISBN'], 'isbn', 'unlisted columns are matched by name');
  assert.equal(dry.mapping['Примітка'], null);
  assert.deepEqual([dry.rows_total, dry.new, dry.updated, dry.invalid, dry.duplicates], [7, 1, 1, 4, 1]);
  const byRow = Object.fromEntries(dry.errors.map((e) => [e.row, e]));
  assert.equal(byRow[3].field, 'pages');
  assert.equal(byRow[4].field, 'cover');
  assert.match(byRow[5].error, /closing quote/);
  assert.match(byRow[6].error, /expected 6 columns, found 3/);
  assert.equal(byRow[6].line, 7);
  const p1 = dry.preview.find((p) => p.data.isbn === 'a-1')!;
  assert.deepEqual([p1.title, p1.image_url, p1.category], ['Кобзар (1840)', 'https://img.example/k.jpg', 'poetry']);
  assert.deepEqual(p1.data._extra, { 'Примітка': 'перше видання' });
  assert.equal((await item('a-1')).data.title, 'Кобзар', 'nothing written yet');

  const c = await svc.commit(dry.import_id, 'pgtest');
  assert.deepEqual([c.status, c.inserted, c.updated, c.invalid], ['committed', 1, 1, 4]);
  assert.equal((await item('a-4')).data.title, 'Енеїда (повна)', 'the last duplicate wins');
  assert.equal((await item('a-4')).data.pages, 310);
  assert.equal((await item('a-1')).data.title, 'Кобзар (1840)');
  assert.deepEqual((await item('a-1')).data._extra, { 'Примітка': 'перше видання' });
  assert.deepEqual(readdirSync(park), [], 'the parked file is removed after the commit');
  await assert.rejects(svc.commit(dry.import_id, 'pgtest'), (e: unknown) => e instanceof DataStoreError && e.code === 'conflict');
});

test('undo: deletes unused inserted rows, hides used ones, restores updated rows', { skip }, async () => {
  const dry = await svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('isbn,title,pages\na-2,Лісова пісня (2),99\nb-1,Нова,1\nb-2,Ще нова,2\n'), filename: 'x.csv' }, createdBy: 'pgtest' });
  const c = await svc.commit(dry.import_id, 'pgtest');
  assert.deepEqual([c.inserted, c.updated], [2, 1]);
  // b-2 gets used (posted) before the undo.
  await pool.query(`UPDATE data_items SET posted = '{"@chan": "2026-10-06"}' WHERE id = $1`, [(await item('b-2')).id]);
  const u = await svc.undo(dry.import_id, 'pgtest');
  assert.deepEqual([u.deleted, u.hidden, u.restored], [1, 1, 1]);
  assert.equal(await item('b-1'), undefined);
  assert.equal((await item('b-2')).status, 'hidden');
  assert.equal((await item('a-2')).data.title, 'Лісова пісня');
  assert.equal((await item('a-2')).data.pages, undefined, 'restored from the snapshot, including removed fields');
  assert.equal((await svc.getImport(dry.import_id)).status, 'undone');
  await assert.rejects(svc.undo(dry.import_id, 'pgtest'), /only a committed import/);
});

test('undo refuses when a later import changed the same rows', { skip }, async () => {
  const a = await svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('isbn,title\nc-1,One\n'), filename: 'a.csv' }, createdBy: 'pgtest' });
  await svc.commit(a.import_id, 'pgtest');
  const b = await svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('isbn,title\nc-1,One v2\n'), filename: 'b.csv' }, createdBy: 'pgtest' });
  await svc.commit(b.import_id, 'pgtest');
  await assert.rejects(svc.undo(a.import_id, 'pgtest'), /later import/);
  await svc.undo(b.import_id, 'pgtest');
  assert.equal((await item('c-1')).data.title, 'One');
  await svc.undo(a.import_id, 'pgtest');
  assert.equal(await item('c-1'), undefined);
});

test('JSON and JSONL files import; broken elements are reported', { skip }, async () => {
  const json = JSON.stringify([{ isbn: 'j-1', title: 'JSON one', pages: 5 }, { isbn: 'j-2', pages: 1 }]);
  const d1 = await svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from(json), filename: 'b.json' }, createdBy: 'pgtest' });
  assert.deepEqual([d1.new, d1.invalid], [1, 1]);
  assert.match(d1.errors[0].error, /required|empty/);
  const d2 = await svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('{"isbn":"l-1","title":"Line"}\n{oops}\n'), filename: 'b.jsonl' }, createdBy: 'pgtest' });
  assert.deepEqual([d2.new, d2.invalid], [1, 1]);
  const c2 = await svc.commit(d2.import_id, 'pgtest');
  assert.equal(c2.inserted, 1);
  await assert.rejects(svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('{"a":1}'), filename: 'x.json' }, createdBy: 'pgtest' }), /JSON array/);
  await assert.rejects(svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('isbn\n1\n'), filename: 'x.csv' }, mapping: { isbn: 'nope' }, createdBy: 'pgtest' }), /unknown field/);
});

test('an expired parked file cannot be committed', { skip }, async () => {
  const d = await svc.dryRun({ schemaKey: K, file: { buffer: Buffer.from('isbn,title\ne-1,E\n'), filename: 'e.csv' }, createdBy: 'pgtest' });
  rmSync(join(park, d.import_id));
  await assert.rejects(svc.commit(d.import_id, 'pgtest'), /expired/);
  assert.equal((await svc.getImport(d.import_id)).status, 'expired');
});

test('a new dataset from a 1 000-row CSV: infer, create, describe, import, undo — no migration', { skip }, async () => {
  const lines = ['Code,Name,Description,Photo,Kind,Released'];
  for (let i = 0; i < 1000; i++) {
    lines.push(`P-${i},"Product ${i}, ""special""","${'Long description of the product. '.repeat(i % 3 ? 2 : 12)}",https://img.example/p/${i}.png,${['tool', 'toy', 'book'][i % 3]},2026-0${(i % 9) + 1}-1${i % 9}`);
  }
  const file = { buffer: Buffer.from(lines.join('\r\n') + '\r\n'), filename: 'products.csv' };
  const draft = await svc.infer(file);
  assert.deepEqual(draft.fields.map((f) => [f.name, f.type]), [
    ['code', 'text'], ['name', 'text'], ['description', 'long_text'], ['photo', 'image_url'], ['kind', 'enum'], ['released', 'date'],
  ]);
  assert.deepEqual(draft.dedup_key, ['code']);
  const schema = await svc.store.createSchema({
    key: 'pgt032i_products', title: 'Products', description: 'Products from a CSV', entity: 'product',
    fields: draft.fields.map((f) => ({ ...f, description: `The ${f.name} of the product.` })),
    roles: draft.roles, dedup_key: draft.dedup_key, language: 'en', default_license: 'own', reuse_policy: { kind: 'never' },
    suitable_for: 'shop channels', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  assert.equal(schema.version, 1);
  const dry = await svc.dryRun({ schemaKey: schema.key, file, createdBy: 'pgtest' });
  assert.deepEqual([dry.rows_total, dry.new, dry.invalid], [1000, 1000, 0]);
  const c = await svc.commit(dry.import_id, 'pgtest');
  assert.equal(c.inserted, 1000);
  const st = (await pool.query(`SELECT rows_total::int, top_categories FROM data_schema_stats WHERE schema_id = $1`, [schema.id])).rows[0];
  assert.equal(st.rows_total, 1000);
  assert.equal(st.top_categories.length, 3);
  const env = (await pool.query(`SELECT title, image_url, category, event_month FROM data_items WHERE schema_id = $1 AND external_key = 'p-5'`, [schema.id])).rows[0];
  assert.deepEqual(env, { title: 'Product 5, "special"', image_url: 'https://img.example/p/5.png', category: 'book', event_month: 6 });
  const u = await svc.undo(dry.import_id, 'pgtest');
  assert.equal(u.deleted, 1000);
  const hist = await svc.listImports(schema.key);
  assert.equal(hist[0].status, 'undone');
});
