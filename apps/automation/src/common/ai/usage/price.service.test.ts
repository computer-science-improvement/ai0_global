import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceService, costFromPrice, normalizeModel } from './price.service';
import type { PriceRow } from './llm-prices.repository';

const row = (p: Partial<PriceRow>): PriceRow => ({
  provider: 'anthropic', model: 'claude-haiku-4-5', inPerM: 1, outPerM: 5, cachedReadPerM: 0.1, cachedWritePerM: 1.25,
  perRequestUsd: null, effectiveFrom: '2026-01-01', ...p,
});

const svc = (rows: PriceRow[], extra: ConstructorParameters<typeof PriceService>[1] = {}) => {
  let loads = 0;
  const s = new PriceService({ list: async () => { loads++; return rows; } }, extra);
  return { s, loads: () => loads };
};

test('normalizeModel strips date suffixes, -latest and applies aliases', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(normalizeModel('gpt-4o-2024-08-06'), 'gpt-4o');
  assert.equal(normalizeModel(' GPT-4o '), 'gpt-4o');
  assert.equal(normalizeModel('claude-haiku-4-5-latest'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('haiku'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('z-ai/glm-5.3-flash'), 'z-ai/glm-5.3-flash');
});

test('price: date-suffixed id finds the seeded row', async () => {
  const { s } = svc([row({})]);
  const p = await s.price('anthropic', 'claude-haiku-4-5-20251001', new Date('2026-10-06T10:00:00Z'));
  assert.equal(p?.inPerM, 1);
});

test('price: latest effective_from ≤ the Kyiv day of `at`', async () => {
  const { s } = svc([
    row({ effectiveFrom: '2026-01-01', inPerM: 1 }),
    row({ effectiveFrom: '2026-10-01', inPerM: 2 }),
    row({ effectiveFrom: '2026-12-01', inPerM: 3 }),
  ]);
  assert.equal((await s.price('anthropic', 'claude-haiku-4-5', new Date('2026-09-30T12:00:00Z')))?.inPerM, 1);
  assert.equal((await s.price('anthropic', 'claude-haiku-4-5', new Date('2026-10-06T12:00:00Z')))?.inPerM, 2);
  // 2026-09-30 22:30 UTC is already 2026-10-01 in Kyiv.
  assert.equal((await s.price('anthropic', 'claude-haiku-4-5', new Date('2026-09-30T22:30:00Z')))?.inPerM, 2);
  assert.equal((await s.price('anthropic', 'claude-haiku-4-5', new Date('2027-01-01T12:00:00Z')))?.inPerM, 3);
  assert.equal(await s.price('anthropic', 'claude-haiku-4-5', new Date('2025-12-01T12:00:00Z')), null, 'before the first row');
});

test('unknown model or provider → unpriced', async () => {
  const { s } = svc([row({})]);
  assert.deepEqual(await s.estimate('anthropic', 'claude-opus-9', { tokensIn: 10, tokensOut: 10 }), { costUsd: null, source: 'unpriced' });
  assert.deepEqual(await s.estimate('openai', 'claude-haiku-4-5', { tokensIn: 10, tokensOut: 10 }), { costUsd: null, source: 'unpriced' });
});

test('accuracy: Anthropic estimate with cache read and cache write matches a hand calculation', async () => {
  const { s } = svc([row({})]);
  // tokens_in 12 000 = 2 000 plain + 8 000 cache read + 2 000 cache write; 1 500 out.
  // 2000*1 + 8000*0.1 + 2000*1.25 + 1500*5 = 2000 + 800 + 2500 + 7500 = 12 800 per 1M → $0.0128
  const r = await s.estimate('anthropic', 'claude-haiku-4-5-20251001',
    { tokensIn: 12_000, tokensOut: 1_500, tokensCachedRead: 8_000, tokensCachedWrite: 2_000 });
  assert.deepEqual(r, { costUsd: 0.0128, source: 'estimate' });
});

test('accuracy: OpenAI estimate with cached prompt tokens matches a hand calculation', () => {
  const p = row({ provider: 'openai', model: 'gpt-4o', inPerM: 2.5, outPerM: 10, cachedReadPerM: 1.25, cachedWritePerM: null });
  // 10 000 prompt (4 000 cached) + 500 out: 6000*2.5 + 4000*1.25 + 500*10 = 15000 + 5000 + 5000 = 25 000 → $0.025
  assert.equal(costFromPrice(p, { tokensIn: 10_000, tokensOut: 500, tokensCachedRead: 4_000 }), 0.025);
});

test('per-request fee (Perplexity) and missing cached rates fall back to the input rate', () => {
  const p = row({ provider: 'perplexity', model: 'sonar-pro', inPerM: 3, outPerM: 15, cachedReadPerM: null, cachedWritePerM: null, perRequestUsd: 0.006 });
  // 1000*3 + 1000*15 = 18 000 per 1M = 0.018, + 0.006
  assert.equal(costFromPrice(p, { tokensIn: 1_000, tokensOut: 1_000 }), 0.024);
  assert.equal(costFromPrice(p, { tokensIn: 1_000, tokensOut: 0, tokensCachedRead: 500, requests: 0 }), 0.003);
});

test('rows are cached for the TTL and reloaded after it; a failed reload keeps the old rows', async () => {
  let t = 0;
  let fail = false;
  let loads = 0;
  const s = new PriceService({ list: async () => { loads++; if (fail) throw new Error('db down'); return [row({})]; } }, { ttlMs: 1000, now: () => t });
  await s.price('anthropic', 'claude-haiku-4-5');
  await s.price('anthropic', 'claude-haiku-4-5');
  assert.equal(loads, 1);
  t = 2000; fail = true;
  assert.ok(await s.price('anthropic', 'claude-haiku-4-5'), 'stale rows survive a failed reload');
  assert.equal(loads, 2);
  s.invalidate(); fail = false;
  await s.price('anthropic', 'claude-haiku-4-5');
  assert.equal(loads, 3);
});
