// Spec 091 FR-006: the manager's prompt line, the digest's slo signal (outside the hash), the directive slot mark. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestHash, digestView, reviewSignature, sloSignalsOf, type KpiDigest, type ResourceDigest } from './kpi-digest.service';
import { SLO_PROMPT_LINE, managerSystemPrompt } from './manager-runner';
import { DIRECTIVE_SLO_MARK, markDirectiveSlot } from './executors/task-report';

test('the manager prompt tells the manager not to file task directives to make up a missed post', () => {
  const sys = managerSystemPrompt({ agent: { name: 'Manager', handle: 'manager' } as any, now: new Date('2026-11-07T10:00:00Z'), digest: '{}', memory: '', skills: { inline: '', listed: '' } });
  assert.ok(sys.includes('The SLO controller recovers missed posts and dark channels by itself. Do not file `task` directives to make up a missed post. File directives for strategy, format or frequency.'));
  assert.ok(sys.includes(SLO_PROMPT_LINE));
});

const res = (slo?: ResourceDigest['slo']): ResourceDigest => ({
  ref: 'telegram:@a', title: 'A', agent: 'a', health: null, kpis: {} as any, anomalies: [], ...(slo ? { slo } : {}),
});

test('the slo signal is in the digest the manager reads but not in the hash or the review signature', () => {
  const slo = { state: 'starved', target: 2, published: 0, replacements: 1, reason: 'no material left' };
  const plain = { resources: [res()], directives: { open: [], outcomes: [] } };
  const withSlo = { resources: [res(slo)], directives: { open: [], outcomes: [] } };
  assert.equal(digestHash(withSlo as any), digestHash(plain as any));
  assert.equal(reviewSignature(withSlo as any), reviewSignature(plain as any));
  const d = { generatedAt: '2026-11-07T10:00:00Z', today: '2026-11-07', ...withSlo, agents: [], budget: { spentTodayUsd: 0, capUsd: 3 }, hash: 'x', raw: new Map() } as unknown as KpiDigest;
  const text = digestView(d).text;
  assert.deepEqual(JSON.parse(text).resources[0].slo, slo);
});

test('sloSignalsOf: today\'s rows by resource ref; a missing table is an empty map', async () => {
  const ok = await sloSignalsOf({ query: async () => ({ rows: [{ channel_key: '@a', state: 'dark', target: 2, published: 0, replacements: 2, reason: 'x'.repeat(300) }] }) } as any, '2026-11-07');
  assert.deepEqual([...ok.keys()], ['telegram:@a']);
  assert.equal(ok.get('telegram:@a')!.state, 'dark');
  assert.equal(ok.get('telegram:@a')!.reason!.length, 160);
  assert.equal((await sloSignalsOf({ query: async () => { throw new Error('no table'); } } as any, '2026-11-07')).size, 0);
});

test('markDirectiveSlot: updates only an unmarked slot of a recovering or dark channel (the SQL carries the guards)', async () => {
  const seen: Array<{ sql: string; params: any[] }> = [];
  const pool: any = { query: async (sql: string, params: any[]) => { seen.push({ sql, params }); return { rowCount: 1 }; } };
  assert.equal(await markDirectiveSlot(pool, 'slot-1'), true);
  assert.match(seen[0].sql, /s\.slo IS NULL/);
  assert.match(seen[0].sql, /state IN \('recovering', 'dark'\)/);
  assert.deepEqual(JSON.parse(seen[0].params[1]), { replaces: null, rung: 'directive', cause: null, depth: 1 });
  assert.deepEqual(DIRECTIVE_SLO_MARK, { replaces: null, rung: 'directive', cause: null, depth: 1 });
  assert.equal(await markDirectiveSlot({ query: async () => ({ rowCount: 0 }) } as any, 's'), false);
  assert.equal(await markDirectiveSlot({ query: async () => { throw new Error('no column'); } } as any, 's'), false);
});
