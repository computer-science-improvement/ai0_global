// Spec 091 FR-007: dark_day reads the day's channel_slo target; a starved or dark channel is reported even under a pause; held has no dark day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard } from '../post/testing/fixtures';
import { evaluateSilentDays, SilentDaysWatch, type WatchResource, type WatchSlot } from './silent-days';

const REF = 'telegram:@birzha';
const NOW = new Date('2026-10-12T16:00:00Z');   // 19:00 Kyiv, past the 18:00 dark hour
const res = (o: Partial<WatchResource> = {}): WatchResource => ({ ref: REF, tz: 'Europe/Kyiv', minPerDay: 0, agentId: 'orch-1', ...o });
const darkOf = (resources: WatchResource[], slots: WatchSlot[] = [], paused?: Set<string>) =>
  evaluateSilentDays({ now: NOW, resources, slots, paused }).filter((a) => a.kind === 'dark_day');

test('the slo target replaces the card minimum: target 2 makes a dark day where the lowered minimum 0 would not', () => {
  assert.equal(darkOf([res({ minPerDay: 0 })]).length, 0, 'minimum 0 and no slot: no dark day');
  const out = darkOf([res({ minPerDay: 0, slo: { target: 2, state: 'starved' } })]);
  assert.equal(out.length, 1);
  assert.match(out[0].body, /daily target is 2/);
});

test('a starved or dark channel is reported although its resource is paused; a behind one is not', () => {
  const paused = new Set([REF]);
  assert.equal(darkOf([res({ slo: { target: 1, state: 'dark' } })], [], paused).length, 1);
  assert.equal(darkOf([res({ slo: { target: 1, state: 'starved' } })], [], paused).length, 1);
  assert.equal(darkOf([res({ slo: { target: 1, state: 'behind' } })], [], paused).length, 0);
  assert.equal(darkOf([res({ minPerDay: 1 })], [], paused).length, 0, 'no slo row: today\'s behaviour, a paused resource is skipped');
});

test('a held channel has no dark day, even with a planned slot that did not go out', () => {
  const planned: WatchSlot = {
    id: 's', ref: REF, scheduledAt: new Date('2026-10-12T09:00:00Z'), updatedAt: NOW, status: 'skipped', error: 'critic_rejected: x', format: 'text', topic: 't',
    seriesName: null, scheduleRuleId: null, criticVerdict: 'reject', fallback: null,
  };
  assert.equal(darkOf([res({ slo: { target: 0, state: 'held' } })], [planned]).length, 0);
  assert.equal(darkOf([res({ minPerDay: 1 })], [planned]).length, 1);
});

test('SilentDaysWatch.load: the card day row wins over the pause-aware hook; no table falls back to the hook, then to dailyTarget of the card', async () => {
  const mkPool = (slo: any[] | 'missing') => ({
    query: async (sql: string) => {
      if (/FROM channel_slo/.test(sql)) { if (slo === 'missing') throw new Error('no table'); return { rows: slo }; }
      if (/FROM editor_slots/.test(sql)) return { rows: [] };
      if (/resource_tz/.test(sql)) return { rows: [{ ref: REF, tz: 'Europe/Kyiv' }] };
      if (/FROM agents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  });
  const card = makeCard({ channelKey: '@birzha', mode: 'live', postsPerDayMin: 3 });
  const inbox = { postOnce: async () => null };
  const hook = async () => 1;
  const row = { channel_key: '@birzha', day: '2026-10-12', target: 2, state: 'starved' };
  const a = await new SilentDaysWatch({ pool: mkPool([row]) as any, inbox, minPerDay: hook }).load([card], NOW);
  assert.deepEqual([a.resources[0].minPerDay, a.resources[0].slo], [2, { target: 2, state: 'starved' }]);
  const b = await new SilentDaysWatch({ pool: mkPool('missing') as any, inbox, minPerDay: hook }).load([card], NOW);
  assert.deepEqual([b.resources[0].minPerDay, b.resources[0].slo], [1, null]);
  const c = await new SilentDaysWatch({ pool: mkPool('missing') as any, inbox }).load([card], NOW);
  assert.equal(c.resources[0].minPerDay, 3);
});
