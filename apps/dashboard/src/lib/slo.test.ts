import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSlo, sloPath, type SloResponse, type SloRow } from '../api/slo';
import { barPct, belowTarget, channelViews, dayMark, effortText, shiftDay, strip, stripText } from './slo';

const row = (channelKey: string, day: string, p: Partial<SloRow> = {}): SloRow => ({
  channelKey, day, target: 2, published: 2, plannedAhead: 0, skipped: 0, replacements: 0, recoveryRuns: 0, state: 'met', reason: null,
  lastPostAt: null, darkSince: null, updatedAt: '2026-11-07T10:00:00.000Z', ...p,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
  return calls;
}

test('the path carries the day', () => {
  assert.equal(sloPath(), '/api/editor/slo');
  assert.equal(sloPath('2026-11-07'), '/api/editor/slo?day=2026-11-07');
});

test('fetchSlo calls the API and returns rows and history', async () => {
  const body: SloResponse = { day: '2026-11-07', rows: [row('@a', '2026-11-07')], history: [row('@a', '2026-11-07'), row('@a', '2026-11-06')] };
  const calls = mockFetch(200, body);
  const r = await fetchSlo('2026-11-07');
  assert.deepEqual(calls, [{ url: '/api/editor/slo?day=2026-11-07', method: 'GET' }]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.history.length, 2);
});

test('shiftDay crosses month and year ends', () => {
  assert.equal(shiftDay('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDay('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01');
});

test('day marks: held is neutral, finished days are met or missed, the running day waits', () => {
  const T = '2026-11-07';
  assert.equal(dayMark(undefined, T, '2026-11-05'), 'none');
  assert.equal(dayMark(row('@a', '2026-11-05', { state: 'held', target: 0, published: 0 }), T, '2026-11-05'), 'held');
  assert.equal(dayMark(row('@a', '2026-11-05', { published: 2 }), T, '2026-11-05'), 'met');
  assert.equal(dayMark(row('@a', '2026-11-05', { published: 1, state: 'behind' }), T, '2026-11-05'), 'missed');
  assert.equal(dayMark(row('@a', T, { published: 1, state: 'behind' }), T, T), 'today');
  assert.equal(dayMark(row('@a', T, { published: 2 }), T, T), 'met');
  assert.equal(dayMark(row('@a', '2026-11-05', { state: 'dark', target: 0, published: 0 }), T, '2026-11-05'), 'missed', 'a dark day whose target fell to 0 is still missed');
  assert.equal(dayMark(row('@a', T, { state: 'dark', target: 2, published: 0 }), T, T), 'today');
});

test('the strip is seven days ending today, oldest first, only for the channel', () => {
  const T = '2026-11-07';
  const h = [row('@a', T, { published: 1, state: 'behind' }), row('@a', '2026-11-06'), row('@a', '2026-11-04', { published: 0, state: 'dark' }),
    row('@a', '2026-11-03', { target: 0, published: 0, state: 'held' }), row('@b', '2026-11-05', { published: 0 })];
  const s = strip(h, '@a', T);
  assert.deepEqual(s.map((c) => c.day), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(s.map((c) => c.mark), ['none', 'none', 'held', 'missed', 'none', 'met', 'today']);
  assert.match(stripText(s), /2026-11-04 missed, 2026-11-05 no data/);
});

test('the panel rows: worst state first, then the channel; percent bar and missed count', () => {
  const T = '2026-11-07';
  const data: SloResponse = {
    day: T,
    rows: [row('@z', T), row('@b', T, { state: 'behind', published: 1 }), row('@a', T, { state: 'dark', published: 0 }), row('@h', T, { state: 'held', target: 0, published: 0 }),
      row('@s', T, { state: 'starved', published: 0 })],
    history: [row('@a', '2026-11-06', { published: 0, state: 'dark' }), row('@a', '2026-11-05', { published: 1, state: 'behind' }), row('@a', T, { published: 0, state: 'dark' })],
  };
  const v = channelViews(data);
  assert.deepEqual(v.map((x) => x.row.channelKey), ['@a', '@s', '@b', '@z', '@h']);
  assert.equal(v[0].missed, 2);
  assert.equal(v[2].pct, 50);
  assert.equal(belowTarget(v), 3);
});

test('bar percent and effort text', () => {
  assert.equal(barPct(1, 3), 33);
  assert.equal(barPct(5, 3), 100);
  assert.equal(barPct(0, 0), 0, 'a held channel owes nothing: an empty bar');
  assert.equal(effortText({ replacements: 0, recoveryRuns: 0 }), '');
  assert.equal(effortText({ replacements: 1, recoveryRuns: 2 }), '1 replacement · 2 recovery runs');
});
