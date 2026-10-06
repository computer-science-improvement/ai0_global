import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildInsertSql, buildUpsertCall, loadData, schemaFor, formatLoad } from './loader.js';
import { pool as defaultPool } from './db.js';
import { mapRecipe, REFRESH_COLUMNS } from '../loaders/recipes.js';

const norm = (s) => s.replace(/\s+/g, ' ').trim();

after(() => defaultPool.end().catch(() => undefined));

test('buildInsertSql: default is ON CONFLICT DO NOTHING with numbered placeholders', () => {
  const sql = norm(buildInsertSql('t', ['a', 'b'], '(a)', 2));
  assert.equal(sql, 'INSERT INTO t ("a", "b") VALUES ($1, $2), ($3, $4) ON CONFLICT (a) DO NOTHING');
});

test('buildInsertSql: updateColumns turns it into an upsert of only those columns', () => {
  const sql = norm(buildInsertSql('t', ['a', 'b', 'c'], '(a)', 1, ['b']));
  assert.equal(sql, 'INSERT INTO t ("a", "b", "c") VALUES ($1, $2, $3) ON CONFLICT (a) DO UPDATE SET "b" = EXCLUDED."b"');
});

test('buildInsertSql: an empty updateColumns list stays DO NOTHING', () => {
  const sql = norm(buildInsertSql('t', ['a'], '(a)', 1, []));
  assert.match(sql, /DO NOTHING$/);
});

test('buildUpsertCall: one parameterised call of data_items_upsert with JSON rows', () => {
  const c = buildUpsertCall('facts', [{ content: 'Факт' }], null, []);
  assert.equal(c.text, 'SELECT data_items_upsert($1, $2::jsonb, $3::uuid, $4::text[]) AS r');
  assert.deepEqual(c.values, ['facts', '[{"content":"Факт"}]', null, []]);
});

test('schemaFor: every loader source maps to a dataset; unknown sources fail loudly', () => {
  for (const s of ['faktypro', 'pdr', 'recipes', 'prompthero', 'prompts-github', 'daytoday-events', 'daytoday-articles',
    'daytoday-jokes', 'daytoday-quotes', 'daytoday-name-days', 'daytoday-birthdays', 'treatfield', 'tg-posts', 'assets', 'mcpservers']) {
    assert.match(schemaFor(s), /^[a-z_]+$/, s);
  }
  assert.equal(schemaFor('faktypro'), 'facts');
  assert.throws(() => schemaFor('nope'), /no dataset mapped/);
  assert.equal(schemaFor('x', { schemaMap: { x: 'y' } }), 'y');
});

function fakePool(results) {
  const calls = [];
  let i = 0;
  const client = {
    query: async (q, params) => {
      const text = typeof q === 'string' ? q : q.text;
      const values = typeof q === 'string' ? params : q.values;
      calls.push({ text, values });
      if (/INSERT INTO data_imports/.test(text)) return { rows: [{ id: 'imp-1' }] };
      if (/data_items_upsert/.test(text)) {
        const r = results[i++];
        if (r instanceof Error) throw r;
        return { rows: [{ r }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { calls, pool: { connect: async () => client } };
}

test('loadData: batches of 500, sums the reports, shifts error rows, records a committed import', async () => {
  const rows = Array.from({ length: 1001 }, (_, k) => ({ content: `f${k}` }));
  const ok = (n) => ({ inserted: n, updated: 0, skipped: 0, invalid: [], invalid_rows: 0 });
  const f = fakePool([ok(500), { inserted: 499, updated: 0, skipped: 0, invalid: [{ row: 3, field: 'content', error: 'required' }], invalid_rows: 1 }, ok(1)]);
  const r = await loadData('facts', rows, { pool: f.pool, filename: 'x.json' });
  assert.deepEqual({ ...r, errors: r.errors.length }, { inserted: 1000, updated: 0, skipped: 0, invalid: 1, errors: 1, importId: 'imp-1' });
  assert.equal(r.errors[0].row, 503, 'row numbers index the whole input');
  const ups = f.calls.filter((c) => /data_items_upsert/.test(c.text));
  assert.equal(ups.length, 3);
  assert.deepEqual(ups[0].values[3], [], 'default: insert new rows, skip existing ones');
  assert.equal(ups[0].values[2], 'imp-1');
  assert.ok(f.calls.some((c) => /status = 'committed'/.test(c.text)));
  assert.match(formatLoad(r), /inserted: 1000, updated: 0, skipped: 0, invalid: 1/);
});

test('loadData: a failing batch marks the import failed and rethrows', async () => {
  const f = fakePool([new Error('boom')]);
  await assert.rejects(loadData('facts', [{ content: 'x' }], { pool: f.pool }), /boom/);
  assert.ok(f.calls.some((c) => /status = 'failed'/.test(c.text)));
});

test('loadData: nothing to load makes no connection', async () => {
  const r = await loadData('facts', [], { pool: { connect: () => { throw new Error('no'); } } });
  assert.equal(r.inserted, 0);
});

test('recipes mapping: plain JSON values for the store (arrays, objects), no posted', () => {
  const row = mapRecipe({ title: 'Pie', tags: ['a', 'b "c"'], raw: { note: 'x\u0000y', n: { a: 1 } }, kcal: 250 });
  assert.deepEqual(row.tags, ['a', 'b "c"']);
  assert.deepEqual(row.raw, { note: 'xy', n: { a: 1 } });
  assert.equal(row.slug, 'pie');
  assert.ok(!('posted' in row));
  assert.ok(!REFRESH_COLUMNS.includes('title_uk'));
});

// ── Against the store (scratch Postgres with migration 058) ─────────────────
const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;

test('loadData against data_items_upsert: insert, skip on re-run, refresh keeps preserved fields, audit', { skip }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const tag = `pgpipe-${process.pid}`;
  try {
    const base = { title: 'Pipe pie', url: 'https://example.com/p', ingredients: 'flour', tags: ['x'], kcal: 100, raw: { a: 1 } };
    const rows = [{ ...base, slug: `${tag}-1` }, { ...base, slug: `${tag}-2`, kcal: '120.5' }, { ...base, slug: `${tag}-3`, title: null }];
    const r1 = await loadData('recipes', rows, { pool, filename: tag });
    assert.equal(r1.inserted, 2);
    assert.equal(r1.invalid, 1);
    assert.deepEqual(r1.errors[0], { row: 2, field: 'title', error: 'required' });
    const view = (await pool.query(`SELECT id, kcal, tags, raw, posted FROM recipes WHERE slug = $1`, [`${tag}-2`])).rows[0];
    assert.equal(view.kcal, '120.5');
    assert.deepEqual(view.tags, ['x']);
    assert.deepEqual(view.posted, {});

    // The strategy translates the recipe; a plain re-run skips it; a refresh updates source fields only.
    await pool.query(`UPDATE recipes SET title_uk = 'Пиріг' WHERE id = $1`, [view.id]);
    const r2 = await loadData('recipes', rows.slice(0, 2), { pool, filename: tag });
    assert.equal(r2.skipped, 2);
    const r3 = await loadData('recipes', [{ ...rows[1], title: 'Pipe pie v2', kcal: 130 }], { pool, filename: tag, updateFields: REFRESH_COLUMNS });
    assert.equal(r3.updated, 1);
    const v3 = (await pool.query(`SELECT title, title_uk, kcal FROM recipes WHERE id = $1`, [view.id])).rows[0];
    assert.deepEqual(v3, { title: 'Pipe pie v2', title_uk: 'Пиріг', kcal: '130' });

    const imp = (await pool.query(`SELECT source, status, inserted, invalid FROM data_imports WHERE filename = $1 ORDER BY created_at LIMIT 1`, [tag])).rows[0];
    assert.deepEqual(imp, { source: 'pipeline', status: 'committed', inserted: 2, invalid: 1 });
  } finally {
    await pool.query(`DELETE FROM data_items WHERE data->>'slug' LIKE $1`, [`${tag}-%`]);
    await pool.query(`DELETE FROM data_imports WHERE filename = $1`, [tag]);
    await pool.end();
  }
});
