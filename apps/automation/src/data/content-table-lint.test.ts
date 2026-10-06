import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { findContentTableRefs } from './content-table-lint';

/**
 * Spec 032 FR-009 lint: content tables are compatibility views over the data store now. New code reads
 * and writes datasets by schema key (DataStore, pipeline loadData, later query_data) — never by table
 * name. The files below are the legacy readers (and the tests of the compatibility layer) that may still
 * name a content table until specs 023/009 retire them. Do not add to this list; shrink it.
 */
const ALLOWED: Record<string, string> = {
  // Legacy readers through the compatibility views (posted markers go through the view triggers).
  'automation/src/config/strategy-preview.service.ts': 'dashboard strategy previews',
  'automation/src/strategies/ai0-prompts/prompts.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/assets/assets.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/curated-prompts/curated-prompts.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/facts/facts.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/motivation-biography/motivation-biography.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/pdr-quiz/pdr-quiz.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/quotes/quotes.repository.ts': 'legacy strategy repository',
  'automation/src/strategies/recipes/recipes.repository.ts': 'legacy strategy repository (reads only; writes use DataStore)',
  'pipeline/src/tg/adapt-biographies.js': 'reads birthdays to draft biography posts',
  'pipeline/src/calculator/server.js': 'local content calculator (read-only counts)',
  // Tests that exercise the legacy SQL or the compatibility views themselves.
  'automation/src/common/content-runway/count-eligible.test.ts': 'asserts legacy repository SQL',
  'automation/src/editor/db/readonly-query.service.test.ts': 'example SQL for the read-only guard',
  'automation/src/editor/db/readonly-sql.test.ts': 'example SQL for the read-only guard',
  'automation/src/data/data-store.migration.pg.test.ts': 'tests the 058 compatibility views',
  'pipeline/src/lib/loader.test.js': 'checks loader output through the recipes view',
  'automation/src/data/content-table-lint.test.ts': "the lint's own fixtures",
};

const APPS = join(__dirname, '..', '..', '..');
const ROOTS = ['automation/src', 'automation/evals', 'automation/scripts', 'pipeline/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'raw-data']);

function walk(dir: string, out: string[]) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (SKIP_DIRS.has(f) || p.endsWith(join('pipeline', 'src', 'data'))) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(f)) out.push(p);
  }
}

test('no code outside the legacy allow-list names a content table', () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(join(APPS, r), files);
  assert.ok(files.length > 100, 'the scan found the sources');
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const rel = relative(APPS, f).split(sep).join('/');
    const refs = findContentTableRefs(readFileSync(f, 'utf8'));
    if (!refs.length) continue;
    seen.add(rel);
    if (ALLOWED[rel]) continue;
    for (const r of refs) offenders.push(`${rel}:${r.line} names "${r.table}": ${r.text}`);
  }
  assert.deepEqual(offenders, [],
    'Content tables are compatibility views since migration 058. Use DataStore / loadData(schemaKey) instead:\n' + offenders.join('\n'));
  const stale = Object.keys(ALLOWED).filter((k) => !seen.has(k));
  assert.deepEqual(stale, [], 'these files no longer reference a content table; remove them from the allow-list');
});

test('the lint catches new references and ignores prose', () => {
  assert.deepEqual(findContentTableRefs('const q = `SELECT * FROM recipes WHERE id = $1`;').map((r) => r.table), ['recipes']);
  assert.equal(findContentTableRefs('await pool.query(`UPDATE public."facts" SET x = 1`)').length, 1);
  assert.equal(findContentTableRefs('db.query("insert into name_days(month) values (1)")').length, 1);
  assert.equal(findContentTableRefs(`await loadRows('jokes', rows, opts)`).length, 1);
  assert.equal(findContentTableRefs('x JOIN birthdays b ON b.id = y.id').length, 1);
  assert.deepEqual(findContentTableRefs('// draw a quote from quotes of the day'), []);
  assert.deepEqual(findContentTableRefs(' * Loader: data → facts table'), []);
  assert.deepEqual(findContentTableRefs('SELECT * FROM legacy_recipes'), []);
  assert.deepEqual(findContentTableRefs('SELECT * FROM recipes_archive'), []);
  assert.deepEqual(findContentTableRefs(`await store.upsert('recipes', rows)`), [], 'schema keys are fine');
});
