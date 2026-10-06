/**
 * Smoke test of the executor-picks-dataset fixtures (no LLM): the datasets seed, the catalog shows them,
 * a 4-field query_data answer is far smaller than the search_library baseline the case compares with.
 * Skipped unless EDITOR_PG_TEST_URL is set (scratch Postgres only).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { buildDataTools, QueryDataInput } from '../../src/editor/tools/data-tools';
import { resetDatasets, searchLibraryBaselineChars, seedDatasets } from './data';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let pool: Pool;

before(async () => { if (url) pool = new Pool({ connectionString: url }); });
after(async () => { if (url) { await resetDatasets(pool); await pool.end(); } });

test('executor-picks-dataset fixtures: catalog, a narrow query and the baseline', { skip }, async () => {
  await resetDatasets(pool);
  const refs = await seedDatasets(pool);
  assert.equal(refs.size, 6);
  const tools = Object.fromEntries(buildDataTools({ pool }).map((t) => [t.name, t]));
  const ctx = { runId: 'r', role: 'executor' as const, channelKey: '@eval_dishes' };
  const cat: any = await tools.library_catalog.execute({}, ctx);
  const dishes = cat.datasets.find((d: any) => d.dataset === 'eval_dishes');
  assert.equal(dishes.rows, 6);
  assert.equal(dishes.unposted_here, 6);
  const q: any = await tools.query_data.execute(QueryDataInput.parse({ schema: 'eval_dishes', fields: ['name', 'region', 'history', 'photo'], limit: 3 }), ctx);
  assert.equal(q.rows.length, 3);
  assert.ok(refs.has(q.rows[0].ref));
  const rows = JSON.stringify(q).length;
  const baseline = await searchLibraryBaselineChars(pool);
  assert.ok(rows <= baseline * 0.5, `query ${rows} chars vs baseline ${baseline}`);
  const catalogChars = JSON.stringify(cat).length;
  // Informational: the overview grows with the number of datasets in the scratch DB.
  console.log(`rows ${rows} · catalog ${catalogChars} · baseline ${baseline} chars`);
});
