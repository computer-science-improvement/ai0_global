import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesRepository } from './recipes.repository';

function fakePool(rows: any[]) {
  const captured: { sql?: string; params?: any[] } = {};
  const pool = {
    query: async (sql: string, params: any[]) => { captured.sql = sql; captured.params = params; return { rows }; },
  };
  return { pool, captured };
}

test('getNextForCarousel filters Telegram-published, per-destination, with nutrition', async () => {
  const row = { id: 'r1' };
  const { pool, captured } = fakePool([row]);
  const repo = new RecipesRepository(pool as any);

  const result = await repo.getNextForCarousel('IG:acc1');

  assert.equal(result, row);
  assert.deepEqual(captured.params, ['IG:acc1']);
  assert.match(captured.sql!, /posted \? 'TELEGRAM'/);
  assert.match(captured.sql!, /NOT \(posted \? \$1\)/);
  assert.match(captured.sql!, /kcal IS NOT NULL/);
});

test('getNextForCarousel returns null when no row', async () => {
  const { pool } = fakePool([]);
  const repo = new RecipesRepository(pool as any);
  assert.equal(await repo.getNextForCarousel('IG:acc1'), null);
});
