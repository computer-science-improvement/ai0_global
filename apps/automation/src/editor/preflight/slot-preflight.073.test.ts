// Spec 073 A18 (T12): the config repair writes `series:<name>` plus the series' next row into the slot's hints; the pre-flight then
// merges the same next row into the hints it judges. The row must be judged exactly once — not twice (a doubled ledger / row read),
// and the repaired slot must pass where the unrepaired PromptHero one had no material of its dataset at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotPreflight, type PreflightDeps, type PreflightMaterial } from './slot-preflight';
import { checkSlotConfig, repairSlotConfig } from '../readiness/slot-config';
import { promptsCase } from '../readiness/fixtures/onboarding-1027';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-10-29T09:00:00Z');

function build(rows: Record<string, boolean>) {
  const calls = { ledger: [] as string[], row: [] as string[] };
  const material: PreflightMaterial = {
    row: async (ref) => { calls.row.push(ref); return ref in rows ? { active: true, postable: rows[ref], missing: [] } : null; },
    unposted: async () => null,
  };
  const d: PreflightDeps = {
    ledger: { check: async (_r: string, ref: string) => { calls.ledger.push(ref); return { used: false }; } } as any,
    material,
    hosts: { blocked: async () => null } as any,
    ideas: { idea: async () => null, accepted: async () => [], claim: async () => true, release: async () => {} },
    retopic: async () => {},
    env: () => undefined,
    freshnessHours: async () => 36,
    now: () => NOW,
  };
  return { pf: new SlotPreflight(d), calls };
}

const rowSlot = (c: ReturnType<typeof promptsCase>, hints: string[]): any => ({
  id: 's1', channelKey: c.channelKey, scheduledAt: NOW, kind: 'content', format: c.slot.format, topic: 'Тема', angle: null, sourceHints: hints,
  ideaId: null, seriesName: c.slot.seriesName, isExperiment: false, status: 'running', attempts: 0, resourceRef: c.resourceRef,
});

test('A18 a repaired slot: the next row is in its hints and in the pre-flight\'s merge, and is read once', async () => {
  const c = promptsCase();
  const ctx = c.ctx();
  const fix = repairSlotConfig(c.slot, checkSlotConfig(c.slot, ctx), ctx);
  assert.deepEqual(fix.sourceHints, ['series:Prompt', c.nextRow], 'the repair already carries the next row');
  const { pf, calls } = build({ [c.nextRow]: true });
  const r = await pf.run(rowSlot(c, fix.sourceHints!), makeCard({ channelKey: c.channelKey }), { nextRow: c.nextRow });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.row, [c.nextRow], 'one row read, not one for the hint and one for the merged next row');
  assert.deepEqual(calls.ledger, [c.nextRow], 'one ledger read');
  // The slot the pre-flight hands on is the repaired one, untouched (the merge is only what it judges).
  if (r.ok) assert.deepEqual(r.slot.sourceHints, ['series:Prompt', c.nextRow]);
});

test('A18 the same repair without a next row (the series has none yet) keeps the dataset hint and judges it as is', async () => {
  const c = promptsCase();
  const ctx = c.ctx({ nextRow: null });
  const fix = repairSlotConfig(c.slot, checkSlotConfig(c.slot, ctx), ctx);
  assert.deepEqual(fix.sourceHints, ['series:Prompt', 'library:nanobanana_prompts'], 'the series\' own dataset');
  const { pf, calls } = build({});
  const r = await pf.run(rowSlot(c, fix.sourceHints!), makeCard({ channelKey: c.channelKey }));
  assert.equal(r.ok, true, 'a dataset hint with nothing to count passes (unknown)');
  assert.deepEqual(calls.row, [], 'no row to read');
});

test('A18 a next row the dataset cannot post is judged once and ends the slot as no material (the repair does not hide it)', async () => {
  const c = promptsCase();
  const ctx = c.ctx();
  const fix = repairSlotConfig(c.slot, checkSlotConfig(c.slot, ctx), ctx);
  const { pf, calls } = build({ [c.nextRow]: false });
  const r = await pf.run(rowSlot(c, fix.sourceHints!), makeCard({ channelKey: c.channelKey }), { nextRow: c.nextRow });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'preflight_no_material');
  assert.deepEqual(calls.row, [c.nextRow]);
});
