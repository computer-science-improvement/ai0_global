import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decisionsPath, fetchDecisions, undoDecision, type AutonomyDecision } from '../api/autonomy';
import { ApiError } from '../api/client';
import { decisionState, familyLabel, sinceIso, undoErrorText, visibleDecisions } from './autonomy';

const d = (id: number, p: Partial<AutonomyDecision> = {}): AutonomyDecision => ({
  id, gate: 'directive:frequency', family: 'directive', refType: 'directive', refId: 'x', channelKey: '@a', action: 'applied', summary: 's',
  decidedAt: '2026-10-19T10:00:00.000Z', undoneAt: null, undoneBy: null, canUndo: true, ...p,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return { ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) } as Response;
  }) as typeof fetch;
  return calls;
}

test('the list path carries the filters', () => {
  assert.equal(decisionsPath(), '/api/autonomy/decisions');
  assert.equal(decisionsPath({ channel: '@a', since: '2026-10-01T00:00:00.000Z', limit: 200 }),
    '/api/autonomy/decisions?channel=%40a&since=2026-10-01T00%3A00%3A00.000Z&limit=200');
});

test('fetchDecisions and undoDecision call the API', async () => {
  const calls = mockFetch(200, { decisions: [d(1)] });
  assert.equal((await fetchDecisions({ limit: 5 })).decisions[0].id, 1);
  assert.deepEqual(calls, [{ url: '/api/autonomy/decisions?limit=5', method: 'GET' }]);

  const u = mockFetch(200, { decision: d(1, { undoneAt: '2026-10-20T00:00:00.000Z', canUndo: false }) });
  assert.equal((await undoDecision(1)).decision.canUndo, false);
  assert.deepEqual(u, [{ url: '/api/autonomy/decisions/1/undo', method: 'POST' }]);
});

test('an undo failure surfaces as an ApiError the toast words', async () => {
  mockFetch(409, { error: 'already_undone' });
  const err = await undoDecision(1).catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.status, 409);
  assert.equal(undoErrorText(err), 'This decision was already undone.');
  assert.equal(undoErrorText(new ApiError(422, JSON.stringify({ error: 'failed', details: 'boom' }))), 'Undo failed: boom');
  assert.equal(undoErrorText(new ApiError(404, JSON.stringify({ error: 'not_found' }))), 'This decision no longer exists.');
  assert.equal(undoErrorText(new Error('plain')), 'plain');
});

test('state: undone wins, then failed, dropped, done', () => {
  assert.equal(decisionState(d(1)), 'done');
  assert.equal(decisionState(d(1, { action: 'resumed' })), 'done');
  assert.equal(decisionState(d(1, { action: 'dropped' })), 'dropped');
  assert.equal(decisionState(d(1, { action: 'failed' })), 'failed');
  assert.equal(decisionState(d(1, { action: 'failed', undoneAt: '2026-10-20T00:00:00Z' })), 'undone');
});

test('visible decisions: undone log rows hidden, failed first, then newest', () => {
  const list = [
    d(1, { decidedAt: '2026-10-10T00:00:00Z' }), d(2, { action: 'undone' }), d(3, { decidedAt: '2026-10-12T00:00:00Z' }),
    d(4, { action: 'failed', decidedAt: '2026-10-01T00:00:00Z' }),
  ];
  assert.deepEqual(visibleDecisions(list).map((x) => x.id), [4, 3, 1]);
});

test('labels and the window', () => {
  assert.equal(familyLabel('series_pause'), 'Series pause');
  assert.equal(familyLabel('new_family'), 'new family');
  assert.equal(sinceIso(14, new Date('2026-10-29T12:00:00Z')), '2026-10-15T12:00:00.000Z');
});
