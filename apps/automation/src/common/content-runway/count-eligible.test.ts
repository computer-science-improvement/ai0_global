import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesRepository } from '../../strategies/recipes/recipes.repository';
import { QuotesRepository } from '../../strategies/quotes/quotes.repository';
import { FactsRepository } from '../../strategies/facts/facts.repository';
import { CuratedPromptsRepository } from '../../strategies/curated-prompts/curated-prompts.repository';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { PdrQuizRepository } from '../../strategies/pdr-quiz/pdr-quiz.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';

function fakePool(count: string) {
  const captured: { sql?: string; params?: unknown[] } = {};
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      captured.sql = sql; captured.params = params;
      return { rows: [{ count }] };
    },
  };
  return { pool, captured };
}

test('recipes.countEligible parses count and keeps TELEGRAM + kcal + title_uk predicates', async () => {
  const { pool, captured } = fakePool('42');
  assert.equal(await new RecipesRepository(pool as any).countEligible(), 42);
  assert.match(captured.sql!, /count\(\*\)/);
  assert.match(captured.sql!, /NOT \(posted \? 'TELEGRAM'\)/);
  assert.match(captured.sql!, /kcal IS NOT NULL/);
  assert.match(captured.sql!, /title_uk IS DISTINCT FROM ''/);
});

test('quotes.countEligible binds channel key, appends category when present', async () => {
  const { pool, captured } = fakePool('7');
  assert.equal(await new QuotesRepository(pool as any).countEligible('@c', 'wisdom'), 7);
  assert.match(captured.sql!, /NOT \(posted \? \$1\)/);
  assert.deepEqual(captured.params, ['@c', 'wisdom']);
});

test('quotes.countEligible omits category param when absent', async () => {
  const { pool, captured } = fakePool('5');
  await new QuotesRepository(pool as any).countEligible('@c');
  assert.deepEqual(captured.params, ['@c']);
});

test('facts.countEligible binds channel key', async () => {
  const { pool, captured } = fakePool('3');
  assert.equal(await new FactsRepository(pool as any).countEligible('@c'), 3);
  assert.match(captured.sql!, /FROM facts/);
  assert.deepEqual(captured.params, ['@c']);
});

test('curated-prompts.countEligible keeps provider/status predicates, binds filter', async () => {
  const { pool, captured } = fakePool('9');
  assert.equal(await new CuratedPromptsRepository(pool as any).countEligible({ provider: undefined, mediaType: 'image' }), 9);
  assert.match(captured.sql!, /provider <> 'prompthero'/);
  assert.match(captured.sql!, /status IS DISTINCT FROM 'ERROR'/);
  assert.deepEqual(captured.params, [null, 'image']);
});

test('ai0-prompts.countEligibleAll counts all prompthero/status-null unposted, no category filter', async () => {
  const { pool, captured } = fakePool('4');
  assert.equal(await new PromptsRepository(pool as any).countEligibleAll(), 4);
  assert.match(captured.sql!, /provider = 'prompthero'/);
  assert.match(captured.sql!, /status IS NULL/);
  assert.match(captured.sql!, /NOT \(posted \? 'TELEGRAM'\)/);
  assert.doesNotMatch(captured.sql!, /category = \$1/);
});

test('pdr-quiz.countEligible binds channel key', async () => {
  const { pool, captured } = fakePool('2');
  assert.equal(await new PdrQuizRepository(pool as any).countEligible('@c'), 2);
  assert.match(captured.sql!, /FROM pdr_questions/);
  assert.deepEqual(captured.params, ['@c']);
});

test('motivation-biography.countEligible counts ALL unposted (no today filter)', async () => {
  const { pool, captured } = fakePool('6');
  assert.equal(await new MotivationBiographyRepository(pool as any).countEligible('@c'), 6);
  assert.match(captured.sql!, /FROM birthdays/);
  assert.doesNotMatch(captured.sql!, /CURRENT_DATE/);
  assert.deepEqual(captured.params, ['@c']);
});

test('assets.countEligible binds data_source + channel key', async () => {
  const { pool, captured } = fakePool('8');
  assert.equal(await new AssetsRepository(pool as any).countEligible('epic', '@c'), 8);
  assert.match(captured.sql!, /data_source = \$1/);
  assert.match(captured.sql!, /NOT \(posted \? \$2\)/);
  assert.deepEqual(captured.params, ['epic', '@c']);
});

test('countEligible returns 0 when no rows', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await new FactsRepository(pool as any).countEligible('@c'), 0);
});
