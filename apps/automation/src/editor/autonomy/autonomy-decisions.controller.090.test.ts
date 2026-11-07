// Spec 090 FR-010: the decisions API on fakes — the list with canUndo, and the undo's error mapping (404 / 409 / 422).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, NotFoundException, UnprocessableEntityException, BadRequestException } from '@nestjs/common';
import { AutonomyDecisionsController } from './autonomy-decisions.controller';
import { AutonomyUndo, type AutonomyDecision } from './autonomy-decisions.repository';

const d = (id: number, o: Partial<AutonomyDecision> = {}): AutonomyDecision => ({
  id, gate: 'series_pause:no_material', refType: 'series_pause', refId: 'p', channelKey: '@a', action: 'resumed', summary: 's',
  undo: { kind: 'repause' }, decidedAt: new Date('2026-10-19T10:00:00Z'), undoneAt: null, undoneBy: null, ...o,
});

function setup(rows: AutonomyDecision[]) {
  const asked: any[] = [];
  const state = new Map(rows.map((r) => [r.id, r]));
  const repo: any = {
    async list(o: any) { asked.push(o); return rows; },
    async get(id: number) { return state.get(id) ?? null; },
    async markUndone(id: number, by: string) { const r = state.get(id)!; if (r.undoneAt) return false; state.set(id, { ...r, undoneAt: new Date(), undoneBy: by }); return true; },
    async releaseUndone() {},
    async record() { return 99; },
  };
  const undo = new AutonomyUndo(repo);
  undo.register('repause', async () => {});
  undo.register('boom', async () => { throw new Error('nope'); });
  return { c: new AutonomyDecisionsController({ repo, undo }), asked };
}

test('list: passes the filters and adds family and canUndo', async () => {
  const { c, asked } = setup([d(1), d(2, { undo: null }), d(3, { undoneAt: new Date('2026-10-20T00:00:00Z') }), d(4, { undo: { kind: 'unregistered' } })]);
  const r = await c.list('@a', '2026-10-01T00:00:00Z', '20');
  assert.equal(asked[0].channelKey, '@a');
  assert.equal(asked[0].since.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(asked[0].limit, 20);
  assert.deepEqual(r.decisions.map((x) => [x.id, x.family, x.canUndo]), [[1, 'series_pause', true], [2, 'series_pause', false], [3, 'series_pause', false], [4, 'series_pause', false]]);
  assert.equal(typeof r.decisions[0].decidedAt, 'string');
  await assert.rejects(() => c.list(undefined, 'not a date'), BadRequestException);
});

test('undo: ok, then 409 on the second click, 404 unknown, 422 without an undo or a failing handler', async () => {
  const { c } = setup([d(1), d(2, { undo: null }), d(3, { undo: { kind: 'boom' } })]);
  const ok = await c.undo(1);
  assert.equal(ok.decision.canUndo, false);
  await assert.rejects(() => c.undo(1), ConflictException);
  await assert.rejects(() => c.undo(99), NotFoundException);
  await assert.rejects(() => c.undo(2), UnprocessableEntityException);
  await assert.rejects(() => c.undo(3), UnprocessableEntityException);
});
