import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeriesPause } from '../series-pause/series-pauses.repository';
import type { Fix } from '../sysadmin/audit.types';
import { isAutoSafeFix } from './auto-fix';
import { CH, makeFacts } from './testing/facts-fixture';
import { harness, mkF } from './testing/fake-readiness';

/** Spec 090 FR-005: readiness applies `series_resume` by itself, but only for `pause_cause_gone`, with a decision row and an undo. */

const RESUME: Fix = { kind: 'series_resume', channel: CH, pauseId: 'p1' };
const PAUSE = { id: 'p1', channelKey: CH, key: 'series:Daily tip', label: 'Daily tip', cause: 'no_material', reason: '', streak: 3, pausedAt: new Date('2026-10-18T10:00:00Z'), resumedAt: null, resumedBy: null } as SeriesPause;

function recorder() {
  const rows: any[] = [];
  return { rows, decisions: { record: async (d: any) => { rows.push(d); return rows.length; } } };
}

test('the guard: series_resume is auto-safe for pause_cause_gone only; the other two kinds are unchanged', () => {
  assert.equal(isAutoSafeFix('series_resume', 'pause_cause_gone'), true);
  assert.equal(isAutoSafeFix('series_resume', 'series_paused'), false, 'a pause that is still justified stays one tap');
  assert.equal(isAutoSafeFix('series_resume'), false, 'no code = no guard proof');
  assert.equal(isAutoSafeFix('tools_allow_add'), true);
  assert.equal(isAutoSafeFix('hashtag_min_zero'), true);
  assert.equal(isAutoSafeFix('source_drop'), false);
});

test('pause_cause_gone is resumed by code, with a decision row and an undo to re-pause', async () => {
  const rec = recorder();
  const h = harness({ deps: { decisions: rec.decisions as any, load: async (_k, now) => makeFacts({ now, pauses: [PAUSE] }) } });
  h.state.findings = [mkF('pause_cause_gone', 'warn', { id: 'p1', fix: RESUME })];
  h.onFix.current = () => { h.state.findings = []; };
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.calls.resumed, ['p1']);
  assert.equal(rec.rows.length, 1);
  assert.equal(rec.rows[0].gate, 'readiness_fix:series_resume');
  assert.equal(rec.rows[0].action, 'resumed');
  assert.deepEqual(rec.rows[0].undo, { kind: 'series_pause', channelKey: CH, seriesKey: 'series:Daily tip', label: 'Daily tip' });
});

test('series_paused (the cause still holds) keeps its one-tap fix and is never applied by code', async () => {
  const rec = recorder();
  const h = harness({ deps: { decisions: rec.decisions as any, load: async (_k, now) => makeFacts({ now, pauses: [PAUSE] }) } });
  h.state.findings = [mkF('series_paused', 'info', { id: 'p1', fix: RESUME })];
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.calls.resumed, []);
  assert.equal(rec.rows.length, 0);
});

test('OWNER_SILENCE=wait turns the code resume back into one tap', async () => {
  const rec = recorder();
  const h = harness({ deps: { decisions: rec.decisions as any, env: (k) => (k === 'OWNER_SILENCE' ? 'wait' : undefined), load: async (_k, now) => makeFacts({ now, pauses: [PAUSE] }) } });
  h.state.findings = [mkF('pause_cause_gone', 'warn', { id: 'p1', fix: RESUME })];
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.calls.resumed, []);
  assert.equal(rec.rows.length, 0);
});

test('an owner pause is refused by the fix runner, so no decision is written', async () => {
  const rec = recorder();
  const h = harness({
    deps: { decisions: rec.decisions as any, load: async (_k, now) => makeFacts({ now, pauses: [{ ...PAUSE, cause: 'owner' }] }) },
    fixes: { seriesPause: async () => ({ cause: 'owner', resumed: false }) },
  });
  h.state.findings = [mkF('pause_cause_gone', 'warn', { id: 'p1', fix: RESUME })];
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.calls.resumed, []);
  assert.equal(rec.rows.length, 0);
});
