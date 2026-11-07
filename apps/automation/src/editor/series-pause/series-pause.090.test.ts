import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { registerSeriesPauseUndo, SeriesBreaker } from './series-breaker';
import type { SeriesPause } from './series-pauses.repository';

/** Spec 090 FR-005/FR-010: the no_material resume writes a decision row with an undo; OWNER_SILENCE=wait stops it. */

const now = new Date('2026-11-07T18:00:00.000Z');
const mk = (id: string, cause: SeriesPause['cause'], hoursAgo: number): SeriesPause => ({
  id, channelKey: '@c', key: `series:${id}`, label: id, cause, reason: '', streak: 3,
  pausedAt: new Date(now.getTime() - hoursAgo * 3_600_000), resumedAt: null, resumedBy: null,
} as SeriesPause);

function setup(env?: (k: string) => string | undefined) {
  let open = [mk('old', 'no_material', 30), mk('own', 'owner', 100), mk('dead', 'source_unreachable', 100)];
  const rows: any[] = [];
  const repo: any = {
    closedSlots: async () => [], lastResumes: async () => new Map(), insertOpen: async () => null, agentOf: async () => null,
    open: async () => open, skipPlanned: async () => 0,
    autoResume: async (id: string) => { open = open.filter((p) => p.id !== id); return mk(id, 'no_material', 0); },
  };
  const breaker = new SeriesBreaker({
    repo, inbox: { post: async () => 1 }, threshold: () => 3, retryHours: () => 24, everyMs: 0, env,
    decisions: { record: async (d: any) => { rows.push(d); return rows.length; } },
  });
  return { breaker, rows };
}

test('a lifted no_material pause writes one decision row with the series_pause undo; owner and unreadable pauses write none', async () => {
  const { breaker, rows } = setup();
  await breaker.check(now, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gate, 'series_pause:no_material');
  assert.equal(rows[0].action, 'resumed');
  assert.equal(rows[0].refType, 'series_pause');
  assert.equal(rows[0].refId, 'old');
  assert.equal(rows[0].channelKey, '@c');
  assert.deepEqual(rows[0].undo, { kind: 'series_pause', channelKey: '@c', seriesKey: 'series:old', label: 'old' });
  assert.match(rows[0].summary, /resumed/);
});

test('OWNER_SILENCE=wait: the pause is not lifted by code and nothing is logged', async () => {
  const { breaker, rows } = setup((k) => (k === 'OWNER_SILENCE' ? 'wait' : undefined));
  assert.equal(await breaker.retryStale(now), 0);
  assert.equal(rows.length, 0);
});

test('the series_pause undo handler re-pauses the key with cause owner and skips its planned slots', async () => {
  const inserted: any[] = [], skipped: any[] = [];
  const undo = new AutonomyUndo({} as any);
  registerSeriesPauseUndo(undo, {
    insertOpen: async (p: any) => { inserted.push(p); return { ...p, id: 'new', pausedAt: now, resumedAt: null, resumedBy: null } as SeriesPause; },
    skipPlanned: async (p: any) => { skipped.push(p.key); return 1; },
  });
  assert.equal(undo.has('series_pause'), true);
  const decision: any = { id: 1, undo: null };
  await (undo as any).handlers.get('series_pause')({ kind: 'series_pause', channelKey: '@c', seriesKey: 'series:old', label: 'old' }, { decision, by: 'owner' });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].cause, 'owner');
  assert.equal(inserted[0].key, 'series:old');
  assert.deepEqual(skipped, ['series:old']);
});
