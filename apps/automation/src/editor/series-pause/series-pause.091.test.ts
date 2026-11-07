import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeriesBreaker } from './series-breaker';
import { SeriesPausesRepository, type SeriesPause } from './series-pauses.repository';
import type { StreakSlot } from './streak';

/** Spec 091 FR-002 (T4): the breaker no longer pauses a whole channel (it hands the streak to the controller); the repository refuses one. */

const H = 3600_000;
const NOW = new Date('2026-11-07T12:00:00Z');
let n = 0;
function plain(hoursAgo: number, channelKey = '@c', resourceRef: string | null = null): StreakSlot {
  const at = new Date(NOW.getTime() - hoursAgo * H);
  n++;
  return { id: `s${n}`, channelKey, resourceRef, seriesName: null, scheduleRuleId: null, topic: 'x', scheduledAt: at, updatedAt: at, status: 'skipped', error: 'no_fresh_item: nothing', criticVerdict: null };
}
const series = (hoursAgo: number): StreakSlot => ({ ...plain(hoursAgo), seriesName: 'Prompt' });

function setup(o: { sloOn?: boolean; slots: StreakSlot[] }) {
  const inserted: any[] = [];
  const streaks: Array<[string, any]> = [];
  const repo: any = {
    closedSlots: async () => o.slots, lastResumes: async () => new Map(), open: async () => [], skipPlanned: async () => 0, agentOf: async () => null,
    insertOpen: async (p: any) => { inserted.push(p); return { id: `p${inserted.length}`, ...p, pausedAt: NOW, resumedAt: null, resumedBy: null }; },
  };
  const breaker = new SeriesBreaker({
    repo, inbox: { post: async () => 1 }, threshold: () => 3, everyMs: 0,
    ...(o.sloOn === undefined ? {} : { sloOn: () => o.sloOn! }), onPlainStreak: (k, hit) => { streaks.push([k, hit]); },
  });
  return { breaker, inserted, streaks };
}

test('SLO_CONTROLLER on: a streak of plain slots goes to onPlainStreak, no resource: pause; series pauses are unchanged', async () => {
  const slots = [plain(60), plain(30), plain(2), series(50), series(30), series(3)];
  const { breaker, inserted, streaks } = setup({ sloOn: true, slots });
  const created = await breaker.check(NOW, true);
  assert.equal(created, 1);
  assert.deepEqual(inserted.map((p) => p.key), ['series:Prompt']);
  assert.equal(streaks.length, 1);
  assert.equal(streaks[0][0], '@c');
  assert.equal(streaks[0][1].key, 'resource:telegram:@c');
  assert.equal(streaks[0][1].n, 3);
});

test('SLO_CONTROLLER on: a platform resource (not Telegram) is still paused; the controller covers Telegram channels', async () => {
  const slots = [plain(60, '@c', 'instagram:abc'), plain(30, '@c', 'instagram:abc'), plain(2, '@c', 'instagram:abc')];
  const { breaker, inserted, streaks } = setup({ sloOn: true, slots });
  await breaker.check(NOW, true);
  assert.deepEqual(inserted.map((p) => p.key), ['resource:instagram:abc']);
  assert.equal(streaks.length, 0);
});

test('SLO_CONTROLLER off (or no flag): the old behaviour, a resource: pause', async () => {
  for (const sloOn of [false, undefined]) {
    const { breaker, inserted, streaks } = setup({ sloOn, slots: [plain(60), plain(30), plain(2)] });
    await breaker.check(NOW, true);
    assert.deepEqual(inserted.map((p) => p.key), ['resource:telegram:@c'], String(sloOn));
    assert.equal(streaks.length, 0);
  }
});

test('a throwing onPlainStreak never stops the breaker', async () => {
  const logs: string[] = [];
  const repo: any = {
    closedSlots: async () => [plain(60), plain(30), plain(2), series(50), series(30), series(3)], lastResumes: async () => new Map(), open: async () => [],
    skipPlanned: async () => 0, agentOf: async () => null, insertOpen: async (p: any) => ({ id: 'p', ...p, pausedAt: NOW, resumedAt: null, resumedBy: null } as SeriesPause),
  };
  const breaker = new SeriesBreaker({ repo, inbox: { post: async () => 1 }, threshold: () => 3, everyMs: 0, sloOn: () => true, onPlainStreak: () => { throw new Error('x'); }, log: (m) => logs.push(m) });
  assert.equal(await breaker.check(NOW, true), 1);
  assert.equal(logs.length, 1);
});

test('repository guard: with the controller on, a resource:telegram: pause needs cause owner', async () => {
  const queries: any[][] = [];
  const pool: any = { query: async (_s: string, p: any[]) => { queries.push(p); return { rows: [{ id: 'x', channel_key: p[0], series_key: p[1], label: p[2], cause: p[3], reason: p[4], streak: p[5], paused_at: NOW }] }; } };
  const on = new SeriesPausesRepository(pool, { sloOn: () => true });
  const base = { channelKey: '@c', key: 'resource:telegram:@c', label: 'telegram:@c', reason: '', streak: 3 };
  assert.equal(await on.insertOpen({ ...base, cause: 'no_material' }), null);
  assert.equal(await on.insertOpen({ ...base, cause: 'source_unreachable' }), null);
  assert.equal(queries.length, 0, 'refused before the database');
  assert.ok(await on.insertOpen({ ...base, cause: 'owner' }));
  assert.ok(await on.insertOpen({ ...base, key: 'series:P', cause: 'no_material' }), 'a series pause is not a channel pause');
  assert.ok(await on.insertOpen({ ...base, key: 'resource:instagram:abc', cause: 'no_material' }));
  assert.equal(queries.length, 3);
  const off = new SeriesPausesRepository(pool, { sloOn: () => false });
  assert.ok(await off.insertOpen({ ...base, cause: 'no_material' }), 'SLO_CONTROLLER=off keeps today\'s behaviour');
  assert.ok(await new SeriesPausesRepository(pool).insertOpen({ ...base, cause: 'no_material' }), 'no option = off');
});
