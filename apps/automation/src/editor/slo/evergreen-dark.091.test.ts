// Spec 091 FR-004: the evergreen step keeps its cap on a normal day and raises it only while the channel is dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evergreenCap, evergreenDarkMax, EvergreenStep } from '../silent/evergreen';
import { makeCard } from '../post/testing/fixtures';

const slot: any = { id: '00000000-0000-4000-8000-000000000001', channelKey: '@chan', scheduledAt: new Date('2026-11-07T09:00:00Z'), kind: 'content', format: 'text', topic: 'T', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };
const failure: any = { kind: 'critic_reject', reason: 'x' };

function step(used: number, o: { dark?: boolean; darkMax?: number; perDay?: number } = {}) {
  let ran = 0;
  const s = new EvergreenStep({
    pool: { query: async () => ({ rows: [{ n: used }] }) } as any, plans: { getSlot: async () => null } as any, perDay: o.perDay ?? 1,
    ...(o.darkMax !== undefined ? { darkMax: () => o.darkMax!, isDark: async () => !!o.dark } : {}),
  });
  return { run: async () => { await s.run({ slot, card: makeCard(), failure, steps: [], run: async () => { ran++; return null; } } as any); return ran; } };
}

test('evergreenDarkMax / evergreenCap', () => {
  assert.equal(evergreenDarkMax(() => undefined), 2);
  assert.equal(evergreenDarkMax((k) => (k === 'SLO_EVERGREEN_DARK_MAX' ? '4' : undefined)), 4);
  assert.equal(evergreenDarkMax(() => '99'), 5);
  assert.equal(evergreenCap(1, 2, false), 1);
  assert.equal(evergreenCap(1, 2, true), 2);
  assert.equal(evergreenCap(3, 2, true), 3);
});

test('normal day: the second evergreen is refused, dark day: the second is allowed and the third refused', async () => {
  assert.equal(await step(1, { darkMax: 2, dark: false }).run(), 0);
  assert.equal(await step(1, { darkMax: 2, dark: true }).run(), 1);
  assert.equal(await step(2, { darkMax: 2, dark: true }).run(), 0);
  assert.equal(await step(1).run(), 0, 'without the dark deps the plain cap applies');
});

test('EDITOR_EVERGREEN_PER_DAY=0 stays off even while dark', async () => {
  assert.equal(await step(0, { perDay: 0, darkMax: 2, dark: true }).run(), 0);
});
