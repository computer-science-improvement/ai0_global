/**
 * Spec 032 T5/T6 against a throwaway Postgres with every migration applied: the shared dataset query
 * (filters, search, unposted_on with data:// and library:// refs, today), the dashboard items endpoint,
 * hide/unhide and the stats in the dataset list. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { BadRequestException } from '@nestjs/common';
import { DataStore } from './data-store';
import { queryDataset, type QueryOptions } from './data-query';
import { refAliases, resolveContentRef } from './data-refs';
import { DataController } from './data.controller';
import { EditorPlansRepository } from '../editor/repo/editor-plans.repository';
import type { DataSchema, FieldDef } from './data.types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const K = 'pgt032q_books';
const CH = '@pgt032q_chan';
let pool: Pool;
let store: DataStore;
let schema: DataSchema;
const ids: Record<string, string> = {};

const FIELDS: FieldDef[] = [
  { name: 'isbn', type: 'text', description: 'ISBN', required: true, agent_visible: false, filterable: true },
  { name: 'title', type: 'text', description: 'Book title', required: true, searchable: true },
  { name: 'summary', type: 'long_text', description: 'Summary' },
  { name: 'genre', type: 'enum', description: 'Genre', enum: ['novel', 'poetry'], filterable: true },
  { name: 'pages', type: 'int', description: 'Pages', filterable: true },
  { name: 'rating', type: 'number', description: 'Rating', filterable: true },
  { name: 'tags', type: 'text_list', description: 'Tags', filterable: true },
  { name: 'released', type: 'date', description: 'Release date', filterable: true },
  { name: 'author_day', type: 'month_day', description: 'Author birthday', filterable: true },
  { name: 'cover', type: 'image_url', description: 'Cover', filterable: true },
];

async function cleanup() {
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032q\\_%')`);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key LIKE 'pgt032q\\_%')`);
  await pool.query(`DELETE FROM data_schemas WHERE key LIKE 'pgt032q\\_%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  store = new DataStore(pool);
  await cleanup();
  schema = await store.createSchema({
    key: K, title: 'Books', description: 'Ukrainian classics', entity: 'book', fields: FIELDS,
    roles: { title: 'title', body: 'summary', category: 'genre', image: 'cover', month_day: 'author_day' },
    dedup_key: ['isbn'], language: 'uk', default_license: 'own', reuse_policy: { kind: 'never' },
    suitable_for: 'literature channels', contains_personal_data: false, status: 'active',
  }, 'pgtest');
  const res = await store.upsert(K, [
    { isbn: '1', title: 'Кобзар', summary: 'Збірка поезій Тараса Шевченка', genre: 'poetry', pages: 320, rating: 4.9, tags: ['classic', 'poetry'], released: '1840-04-30', author_day: '03-09', cover: 'https://x.ua/1.jpg' },
    { isbn: '2', title: 'Тигролови', summary: 'Пригодницький роман Івана Багряного', genre: 'novel', pages: 250, rating: 4.7, tags: ['adventure'], released: '1944-01-01', author_day: '10-02' },
    { isbn: '3', title: 'Лісова пісня', summary: 'x'.repeat(2600), genre: 'poetry', pages: 120, tags: [], released: '1911-07-25' },
    { isbn: '4', title: 'Земля', summary: 'Повість Ольги Кобилянської', genre: 'novel', pages: 400, rating: 4.2, released: '1902-01-01' },
  ]);
  assert.equal(res.inserted, 4, JSON.stringify(res));
  const { rows } = await pool.query(`SELECT id::text, data->>'isbn' AS isbn FROM data_items WHERE schema_id = $1`, [schema.id]);
  for (const r of rows) ids[r.isbn] = r.id;
  // A row moved from a legacy table keeps its old ref (the write path only accepts the dataset's own legacy table).
  await pool.query(`UPDATE data_items SET legacy_ref = 'library://pgt_old_books/77' WHERE id = $1::bigint`, [ids['4']]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const q = (o: Partial<QueryOptions>) => queryDataset(pool, schema, { audience: 'agent', limit: 20, order: 'oldest', today: { month: 3, day: 9 }, ...o });
const titles = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.title).sort();

test('every filter operator runs on real rows', { skip }, async () => {
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'genre', op: 'eq', value: 'novel' }] })).rows), ['Земля', 'Тигролови']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'tags', op: 'eq', value: 'classic' }] })).rows), ['Кобзар']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'tags', op: 'in', value: ['adventure', 'classic'] }] })).rows), ['Кобзар', 'Тигролови']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'pages', op: 'in', value: [120, '400'] }] })).rows), ['Земля', 'Лісова пісня']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'pages', op: 'gte', value: 300 }] })).rows), ['Земля', 'Кобзар']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'rating', op: 'between', value: [4.5, 4.8] }] })).rows), ['Тигролови']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'released', op: 'lte', value: '1911-12-31' }] })).rows), ['Земля', 'Кобзар', 'Лісова пісня']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'rating', op: 'is_null' }] })).rows), ['Лісова пісня']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'cover', op: 'is_null', value: false }] })).rows), ['Кобзар']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'isbn', op: 'ilike', value: '2' }] })).rows), ['Тигролови']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'author_day', op: 'today' }] })).rows), ['Кобзар']);
  assert.deepEqual(titles((await q({ fields: ['title'], filters: [{ field: 'released', op: 'today' }], today: { month: 7, day: 25 } })).rows), ['Лісова пісня']);
});

test('Cyrillic full-text search over the envelope and searchable fields', { skip }, async () => {
  assert.deepEqual(titles((await q({ fields: ['title'], search: 'шевченка' })).rows), ['Кобзар']);
  assert.deepEqual(titles((await q({ fields: ['title'], search: 'пісня' })).rows), ['Лісова пісня']);
});

test('long text is cut to 2000 characters unless full', { skip }, async () => {
  const cut = await q({ fields: ['summary'], filters: [{ field: 'pages', op: 'eq', value: 120 }] });
  assert.equal((cut.rows[0].summary as string).length, 2001);
  const full = await q({ fields: ['summary'], filters: [{ field: 'pages', op: 'eq', value: 120 }], full: true });
  assert.equal((full.rows[0].summary as string).length, 2600);
});

test('unposted_on drops rows used on the resource: posted markers, data:// and library:// refs (content ledger)', { skip }, async () => {
  const unposted = async () => titles((await q({ fields: ['title'], unpostedOn: `telegram:${CH}` })).rows);
  assert.equal((await unposted()).length, 4);
  // A legacy strategy's marker reaches the ledger through the 060 trigger; the editor records its publications.
  await pool.query(`UPDATE data_items SET posted = posted || jsonb_build_object($2::text, now()) WHERE id = $1::bigint`, [ids['1'], CH]);
  const plans = new EditorPlansRepository(pool);
  await plans.insertPublication({ channelKey: CH, messageId: 1, sourceUrl: `data://${K}/${ids['2']}`, title: 't', tags: [], format: 'text', slotId: null });
  await plans.insertPublication({ channelKey: CH, messageId: 2, sourceUrl: 'library://pgt_old_books/77', title: 't', tags: [], format: 'text', slotId: null });
  assert.deepEqual(await unposted(), ['Лісова пісня']);
  assert.equal((await q({ fields: ['title'], unpostedOn: '@someone_else' })).rows.length, 4, 'other resources are not affected');
});

test('refs: data:// and library:// resolve to each other', { skip }, async () => {
  const r = await resolveContentRef(pool, 'library://pgt_old_books/77');
  assert.equal(r?.dataRef, `data://${K}/${ids['4']}`);
  assert.deepEqual(r?.legacy, { table: 'pgt_old_books', id: '77' });
  assert.deepEqual((await refAliases(pool, `data://${K}/${ids['4']}`)).sort(), [`data://${K}/${ids['4']}`, 'library://pgt_old_books/77'].sort());
  assert.deepEqual(await refAliases(pool, `data://${K}/${ids['1']}`), [`data://${K}/${ids['1']}`]);
  assert.deepEqual(await refAliases(pool, 'https://example.com/a'), ['https://example.com/a']);
  assert.equal(await resolveContentRef(pool, `data://${K}/999999999`), null);
});

test('dashboard: items endpoint with filters, search, paging; hide/unhide; stats in the list', { skip }, async () => {
  const c = new DataController(pool);
  const page = await c.listItems(K, { filters: JSON.stringify([{ field: 'genre', op: 'eq', value: 'poetry' }]), page_size: '1', order: 'oldest' }) as any;
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, 'Кобзар');
  assert.equal(page.items[0].data.isbn, '1', 'the owner sees every field');
  await assert.rejects(c.listItems(K, { filters: JSON.stringify([{ field: 'title', op: 'eq', value: 'x' }]) }),
    (e: any) => e instanceof BadRequestException && /not filterable/.test((e.getResponse() as any).message));
  assert.throws(() => c.listItems(K, { filters: '{oops' }), BadRequestException);

  await c.setItemStatus(K, ids['3'], { status: 'hidden' });
  assert.equal(((await c.listItems(K, {})) as any).total, 3);
  assert.equal(((await c.listItems(K, { status: 'hidden' })) as any).items[0].title, 'Лісова пісня');
  assert.equal((await q({ fields: ['title'] })).rows.length, 3, 'agents never see hidden rows');
  await c.setItemStatus(K, ids['3'], { status: 'active' });
  await assert.rejects(c.setItemStatus(K, '999999999', { status: 'hidden' }), /not found/);
  assert.throws(() => c.setItemStatus(K, ids['3'], { status: 'deleted' }), BadRequestException);

  assert.equal((await c.refreshStats({ schema: K })).refreshed, 1);
  const list = await c.listSchemas() as any[];
  const mine = list.find((s) => s.key === K);
  assert.equal(mine.rows, 4);
  assert.equal(mine.unposted_network, 1, 'every ledger publication (marker, data:// and library:// refs) counts network-wide');
  assert.ok(mine.stats_at);
});
