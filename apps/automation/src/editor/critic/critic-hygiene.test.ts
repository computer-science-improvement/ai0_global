/** Spec 037 T6: the critic gate stops a broken character; the critic reads every lint warning. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CriticGate } from './critic-gate';
import { criticUserPrompt, type CriticRequest, type CriticResult } from './critic.service';
import type { StoredCritic } from './critic';
import { makeSpec } from '../post/testing/fixtures';

const passed: StoredCritic = {
  verdict: 'pass', scores: null, notes: 'ok', reason: 'pass', pass: 1, slop_warnings: [], model: null, run_id: null, cost_usd: 0, at: '2026-10-15T00:00:00Z',
};

function gateWith(seen: CriticRequest[], updates: unknown[] = []) {
  const critic = { review: async (r: CriticRequest): Promise<CriticResult> => { seen.push(r); return { ok: true, critic: passed }; } };
  return new CriticGate({ critic, plans: { updateSlot: async (_id: string, u: unknown) => { updates.push(u); } } as any },
    { slotId: 's1', channelKey: '@chan', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} });
}

test('critic gate: a broken character is blocked before the critic — no review, nothing stored', async () => {
  const seen: CriticRequest[] = [];
  const updates: unknown[] = [];
  const gate = gateWith(seen, updates);
  const out = await gate.check({ text: 'Постраждалі пе��еважно в Азії.', spec: makeSpec(), format: 'photo', warnings: [] });
  assert.equal(out.kind, 'blocked');
  assert.equal((out as any).result.error, 'text_replacement_char');
  assert.match((out as any).result.details, /пе��еважно/);
  assert.equal(seen.length, 0);
  assert.equal(updates.length, 0);
  // The rewritten post goes to the critic as usual.
  assert.equal((await gate.check({ text: 'Постраждалі переважно в Азії.', spec: makeSpec(), format: 'photo', warnings: [] })).kind, 'proceed');
  assert.equal(seen.length, 1);
});

test('critic gate: every lint warning reaches the critic prompt; the verdict still counts only the slop ones', async () => {
  const seen: CriticRequest[] = [];
  const warnings = [
    { code: 'slop_em_dash', message: '3 тире' },
    { code: 'lead_too_long', message: 'лід 180 символів' },
    { code: 'duplicate_attribution', message: 'джерело двічі' },
  ];
  await gateWith(seen).check({ text: 'Текст поста.', spec: makeSpec(), format: 'photo', warnings });
  assert.deepEqual(seen[0].slopWarnings.map((w) => w.code), ['slop_em_dash']);
  assert.deepEqual(seen[0].lintWarnings?.map((w) => w.code), ['slop_em_dash', 'lead_too_long', 'duplicate_attribution']);
  const prompt = criticUserPrompt(seen[0]);
  assert.match(prompt, /- lead_too_long: лід 180 символів/);
  assert.match(prompt, /- duplicate_attribution: джерело двічі/);
  // A request without lintWarnings (chat drafts, older callers) shows the slop ones as before.
  const { lintWarnings: _l, ...legacy } = seen[0];
  assert.doesNotMatch(criticUserPrompt(legacy as CriticRequest), /lead_too_long/);
  assert.match(criticUserPrompt(legacy as CriticRequest), /- slop_em_dash: 3 тире/);
});
