import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentRunwayService, LOW_CONTENT_DEFAULT } from './content-runway.service';

function build() {
  const calls: any = {};
  const svc = new ContentRunwayService(
    { countEligible: async () => 5 } as any,                                                       // recipes
    { countEligible: async (k: string, c?: string) => { calls.quotes = { k, c }; return 7; } } as any, // quotes
    { countEligible: async (k: string) => { calls.facts = k; return 3; } } as any,                 // facts
    { countEligible: async () => 9 } as any,                                                       // curated-prompts
    { countEligible: async (cat: string) => { calls.ai0 = cat; return 4; } } as any,               // ai0-prompts
    { countEligible: async (_k: string) => 2 } as any,                                             // pdr-quiz
    { countEligible: async (_k: string) => 6 } as any,                                             // motivation-biography
    { countEligible: async (ds: string, k: string) => { calls.assets = { ds, k }; return 8; } } as any, // assets
  );
  return { svc, calls };
}

test('remainingFor returns null for RSA/unknown types', async () => {
  const { svc } = build();
  assert.equal(await svc.remainingFor('ua-news', '@c', {}), null);
  assert.equal(await svc.remainingFor('daily-photo', '@c', {}), null);
});

test('recipes ignores the channel key', async () => {
  const { svc } = build();
  assert.equal(await svc.remainingFor('recipes', null, {}), 5);
});

test('channel-keyed type returns null when key missing, number when present', async () => {
  const { svc } = build();
  assert.equal(await svc.remainingFor('facts', null, {}), null);
  assert.equal(await svc.remainingFor('facts', '@c', {}), 3);
});

test('quotes passes channel key + category', async () => {
  const { svc, calls } = build();
  assert.equal(await svc.remainingFor('quotes', '@c', { category: 'wisdom' }), 7);
  assert.deepEqual(calls.quotes, { k: '@c', c: 'wisdom' });
});

test('assets passes dataSource + channel key', async () => {
  const { svc, calls } = build();
  assert.equal(await svc.remainingFor('assets', '@c', { dataSource: 'epic' }), 8);
  assert.deepEqual(calls.assets, { ds: 'epic', k: '@c' });
});

test('ai0-prompts passes category (channel key irrelevant)', async () => {
  const { svc, calls } = build();
  assert.equal(await svc.remainingFor('ai0-prompts', null, { category: 'art' }), 4);
  assert.equal(calls.ai0, 'art');
});

test('effectiveThreshold falls back to the default', () => {
  const { svc } = build();
  assert.equal(svc.effectiveThreshold(null), LOW_CONTENT_DEFAULT);
  assert.equal(svc.effectiveThreshold(undefined), LOW_CONTENT_DEFAULT);
  assert.equal(svc.effectiveThreshold(50), 50);
});

test('a counter that throws yields null, not a crash', async () => {
  const svc = new ContentRunwayService(
    { countEligible: async () => { throw new Error('db down'); } } as any,
    ...(Array(7).fill({ countEligible: async () => 0 }) as [any, any, any, any, any, any, any]),
  );
  assert.equal(await svc.remainingFor('recipes', null, {}), null);
});
