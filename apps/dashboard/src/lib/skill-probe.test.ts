// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 059: the probe badge of a skill version, the tally line, "Adopt anyway", and the memory "why".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProbeRecord, ProbeSample } from '../api/agents';
import { BETTER_LABEL, canAdoptAnyway, criticTone, hasProbeDetails, memoryWhy, probeBadge, probeSummary, probeTally } from './skill-probe';

const side = (critic: 'pass' | 'revise' = 'pass') => ({ critic, lint: 0, chars: 10, preview: 'text' });
const sample = (better: ProbeSample['judge']['better']): ProbeSample => ({
  slotId: 's', topic: 't', old: side(), new: side(), judge: { better, reasons: ['r'], risks: [], by: 'judge' },
});
const rec = (verdict: ProbeRecord['verdict'], over: Partial<ProbeRecord> = {}): ProbeRecord => ({ verdict, samples: [sample('new'), sample('same'), sample('old')], costUsd: 0.1234, at: '2030-05-06T09:00:00Z', ...over });

test('probeBadge: the state decides Probing and Rejected, the record decides the rest', () => {
  assert.deepEqual(probeBadge({ outcome: 'probing', probe: rec('probing') }), { label: 'Probing…', tone: 'warning', title: probeBadge({ outcome: 'probing' })!.title });
  assert.equal(probeBadge({ outcome: 'rejected', probe: rec('rejected', { reason: 'worse' }) })!.label, 'Rejected by probe');
  assert.equal(probeBadge({ outcome: 'rejected', probe: rec('rejected', { reason: 'worse' }) })!.title, 'worse');
  assert.equal(probeBadge({ outcome: 'pending', probe: rec('adopted') })!.label, 'Adopted after probe');
  assert.equal(probeBadge({ outcome: 'kept', probe: rec('adopted') })!.tone, 'success');
  assert.equal(probeBadge({ outcome: 'pending', probe: rec('owner_override') })!.label, 'Adopted anyway');
  assert.equal(probeBadge({ outcome: 'pending', probe: rec('inconclusive') })!.label, 'Inconclusive');
  assert.equal(probeBadge({ outcome: 'pending', probe: rec('unprobed', { samples: [] }) })!.label, 'Unprobed');
});

test('probeBadge: nothing to say for old rows, a replaced probe or a server without the field', () => {
  assert.equal(probeBadge({ outcome: 'kept' }), null);
  assert.equal(probeBadge({ outcome: null, probe: null }), null);
  assert.equal(probeBadge({ outcome: 'superseded', probe: rec('superseded') }), null);
});

test('probeSummary counts the pairs and shows the cost; null without samples', () => {
  assert.equal(probeSummary(rec('adopted')), 'The new text won 1, tied 1, lost 1 of 3 posts · $0.12');
  assert.equal(probeSummary(rec('adopted', { samples: [sample('new')] })), 'The new text won 1, tied 0, lost 0 of 1 post · $0.12');
  assert.equal(probeSummary(rec('unprobed', { samples: [] })), null);
  assert.equal(probeSummary(null), null);
  assert.equal(probeSummary(undefined), null);
  assert.deepEqual(probeTally([sample('new'), sample('new'), sample('old')]), { wins: 2, ties: 0, losses: 1 });
});

test('hasProbeDetails: samples or a reason; canAdoptAnyway: only the newest rejected version', () => {
  assert.equal(hasProbeDetails({ outcome: 'pending', probe: rec('adopted') }), true);
  assert.equal(hasProbeDetails({ outcome: 'pending', probe: rec('unprobed', { samples: [], reason: 'probes are switched off' }) }), true);
  assert.equal(hasProbeDetails({ outcome: 'pending', probe: rec('unprobed', { samples: [] }) }), false);
  assert.equal(hasProbeDetails({ outcome: 'kept' }), false);

  const all = [{ version: 3 }, { version: 2 }, { version: 1 }];
  assert.equal(canAdoptAnyway({ outcome: 'rejected', version: 3 }, all), true);
  assert.equal(canAdoptAnyway({ outcome: 'rejected', version: 2 }, all), false, 'a newer version exists');
  assert.equal(canAdoptAnyway({ outcome: 'pending', version: 3 }, all), false);
});

test('labels and tones for the dialog', () => {
  assert.equal(criticTone('pass'), 'success');
  assert.equal(criticTone('revise'), 'warning');
  assert.equal(criticTone('reject'), 'danger');
  assert.equal(BETTER_LABEL.new, 'New text is better');
});

test('memoryWhy: a probe rejection and a KPI rollback explain themselves; other memory has no why', () => {
  assert.equal(
    memoryWhy({ source: 'skill_probe', skill: 'hooks', version: 3, wins: 0, ties: 1, losses: 2, why: ['too generic', 'x'] }),
    'Probe rejected "hooks" v3: new text won 0, tied 1, lost 2 · too generic',
  );
  assert.equal(memoryWhy({ source: 'skill_probe' }), 'Probe rejected the skill: new text won 0, tied 0, lost 0');
  assert.equal(memoryWhy({ source: 'kpi_rollback', skill: 'hooks', version: 4, deltaPct: -23.4, z: -2.1 }), 'Rolled back "hooks" v4 after the 7-day KPI review: views per post -23%');
  assert.equal(memoryWhy({ source: 'approval' }), null);
  assert.equal(memoryWhy(null), null);
  assert.equal(memoryWhy('text'), null);
});
