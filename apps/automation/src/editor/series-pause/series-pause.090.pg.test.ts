/**
 * Spec 090 FR-005/FR-010 against a throwaway Postgres with every migration applied: the breaker lifts a stale no_material pause
 * and logs it; the logged undo re-pauses the series with cause owner, which code never lifts again. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AutonomyDecisionsRepository, AutonomyUndo } from '../autonomy/autonomy-decisions.repository';
import { registerSeriesPauseUndo, SeriesBreaker } from './series-breaker';
import { SeriesPausesRepository } from './series-pauses.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;

before(async () => { if (url) db = await createProbeDb(url, 'p090b_pause'); });
after(async () => { await db?.drop(); });

test('a resumed no_material pause is logged, and Undo re-pauses it as an owner pause that the breaker leaves alone', { skip }, async () => {
  const repo = new SeriesPausesRepository(db.pool);
  const decisions = new AutonomyDecisionsRepository(db.pool);
  const undo = new AutonomyUndo(decisions);
  registerSeriesPauseUndo(undo, repo);
  const p = await repo.insertOpen({ channelKey: '@p090b', key: 'series:Tip', label: 'Tip', cause: 'no_material', reason: 'nothing', streak: 3 });
  assert.ok(p);
  await db.pool.query(`UPDATE series_pauses SET paused_at = now() - interval '30 hours' WHERE id = $1`, [p!.id]);

  const breaker = new SeriesBreaker({ repo, inbox: { post: async () => 1 } as any, threshold: () => 0, retryHours: () => 24, everyMs: 0, decisions });
  assert.equal(await breaker.retryStale(new Date()), 1);
  assert.equal((await repo.open('@p090b')).length, 0);

  const [d] = await decisions.list({ channelKey: '@p090b' });
  assert.equal(d.gate, 'series_pause:no_material');
  assert.equal(d.action, 'resumed');
  assert.equal(d.refId, p!.id);
  assert.equal(d.undo?.kind, 'series_pause');

  const r = await undo.undo(d.id, 'owner');
  assert.equal(r.ok, true);
  const open = await repo.open('@p090b');
  assert.equal(open.length, 1);
  assert.equal(open[0].key, 'series:Tip');
  assert.equal(open[0].cause, 'owner');

  // Owner pauses are never resumed by code, however old.
  await db.pool.query(`UPDATE series_pauses SET paused_at = now() - interval '300 hours' WHERE id = $1`, [open[0].id]);
  assert.equal(await breaker.retryStale(new Date()), 0);
  assert.equal((await repo.open('@p090b')).length, 1);
});
