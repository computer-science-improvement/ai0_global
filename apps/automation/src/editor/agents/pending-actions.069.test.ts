import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingActionsService, type PendingAction } from './pending-actions';

/** Spec 069 FR-001 / A2 / A3: a card's follow-ups run after the main handler, one by one, through the same handlers. */

function fake() {
  const rows = new Map<string, PendingAction>();
  let n = 0;
  const repo: any = {
    create: async (a: any) => { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; const r = { ...a, id, status: 'pending', result: null, error: null, createdAt: new Date(), decidedAt: null, agentId: a.agentId ?? null }; rows.set(id, r); return r; },
    get: async (id: string) => rows.get(id) ?? null,
    decide: async (id: string, status: any, result?: unknown, error?: string | null) => {
      const r = rows.get(id); if (!r || r.status !== 'pending') return null;
      const u = { ...r, status, result: result ?? null, error: error ?? null, decidedAt: new Date() }; rows.set(id, u); return u;
    },
    listForChat: async () => [...rows.values()],
    expireOld: async () => 0,
  };
  const calls: string[] = [];
  const svc = new PendingActionsService(repo);
  svc.register('main', async (p) => { calls.push('main'); if (p.fail) throw new Error('main_broke'); return { inserted: Number(p.inserted ?? 3), updated: 0, skipped: 0 }; });
  svc.register('step', async (p, a, input) => {
    calls.push(`step:${String(p.name)}`);
    assert.equal(input, null, 'item handlers get no input');
    assert.ok(a.id, 'and the main action');
    if (p.fail) throw new Error('step_broke');
    return { done: p.name };
  });
  return { svc, calls, rows };
}

const item = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: 'step', payload: { name: key }, summary: key, ...extra });

test('follow-ups: the main handler runs first, then the items in order, with their outcomes in result.then', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { then: [item('one'), item('two')] }, summary: 'x' });
  const done = await svc.apply(a.id);
  assert.equal(done.status, 'applied');
  assert.deepEqual(calls, ['main', 'step:one', 'step:two']);
  const r = done.result as any;
  assert.equal(r.inserted, 3, 'the main result is kept');
  assert.deepEqual(r.then, [{ key: 'one', ok: true, result: { done: 'one' } }, { key: 'two', ok: true, result: { done: 'two' } }]);
});

test('follow-ups: a key in input.skip_then is skipped and recorded', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { then: [item('one'), item('two')] }, summary: 'x' });
  const done = await svc.apply(a.id, { skip_then: ['one'] });
  assert.deepEqual(calls, ['main', 'step:two']);
  assert.deepEqual((done.result as any).then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['one', false, 'skipped'], ['two', true, null]]);
});

test('follow-ups: a failing item is shown while the card stays applied, and the next item still runs', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { then: [{ ...item('bad'), payload: { name: 'bad', fail: true } }, item('good')] }, summary: 'x' });
  const done = await svc.apply(a.id);
  assert.equal(done.status, 'applied');
  assert.equal(done.error, null);
  assert.deepEqual(calls, ['main', 'step:bad', 'step:good']);
  const then = (done.result as any).then;
  assert.deepEqual([then[0].ok, then[0].error, then[1].ok], [false, 'step_broke', true]);
});

test('follow-ups: a failing main handler runs no item', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { fail: true, then: [item('one')] }, summary: 'x' });
  const done = await svc.apply(a.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error!, /main_broke/);
  assert.deepEqual(calls, ['main']);
});

test('follow-ups: an unticked-by-default item stays off without the owner\'s choice, and runs when the owner ticked it', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { then: [item('hard'), item('soft', { ticked: false })] }, summary: 'x' });
  const api = await svc.apply(a.id); // API / owner bot: no input
  assert.deepEqual(calls, ['main', 'step:hard']);
  assert.deepEqual((api.result as any).then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['hard', true, null], ['soft', false, 'not_ticked']]);

  calls.length = 0;
  const b = await svc.propose({ chatId: 'c', kind: 'main', payload: { then: [item('hard'), item('soft', { ticked: false })] }, summary: 'x' });
  await svc.apply(b.id, { skip_then: [] }); // the dashboard: the owner ticked the soft one
  assert.deepEqual(calls, ['main', 'step:hard', 'step:soft']);
});

test('follow-ups: requires main_rows is skipped as import_empty when the import found nothing; an unchanged list is not empty', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { inserted: 0, then: [item('series', { requires: 'main_rows' }), item('rule')] }, summary: 'x' });
  const empty = await svc.apply(a.id);
  assert.deepEqual(calls, ['main', 'step:rule']);
  assert.deepEqual((empty.result as any).then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['series', false, 'import_empty'], ['rule', true, null]]);

  // inserted 0, updated 0, skipped 5: a re-import of an unchanged list — not empty.
  const { svc: s2, calls: c2 } = fake();
  s2.register('unchanged', async () => ({ inserted: 0, updated: 0, skipped: 5 }));
  const b = await s2.propose({ chatId: 'c', kind: 'unchanged', payload: { then: [item('series', { requires: 'main_rows' })] }, summary: 'x' });
  await s2.apply(b.id);
  assert.deepEqual(c2, ['step:series']);
});

test('follow-ups: an item cannot nest (its own then is ignored)', async () => {
  const { svc, calls } = fake();
  const a = await svc.propose({ chatId: 'c', kind: 'main', payload: { then: [{ ...item('outer'), payload: { name: 'outer', then: [item('inner')] } }] }, summary: 'x' });
  await svc.apply(a.id);
  assert.deepEqual(calls, ['main', 'step:outer']);
});

test('follow-ups: propose refuses an unregistered kind, a duplicate key, a malformed item and too many items', async () => {
  const { svc } = fake();
  const propose = (then: unknown) => () => svc.propose({ chatId: 'c', kind: 'main', payload: { then }, summary: 'x' });
  assert.throws(propose([{ key: 'a', kind: 'nope', payload: {}, summary: '' }]), /unknown action kind nope/);
  assert.throws(propose([item('a'), item('a')]), /duplicate follow-up key a/);
  assert.throws(propose([{ kind: 'step' }]), /invalid follow-ups/);
  assert.throws(propose(Array.from({ length: 9 }, (_, i) => item(`k${i}`))), /at most 8/);
});

test('input.skip of fix_config_conflicts is unaffected: the handler still gets the whole input', async () => {
  const { svc } = fake();
  let seen: unknown;
  svc.register('fix', async (_p, _a, input) => { seen = input; return { ok: true }; });
  const a = await svc.propose({ chatId: 'c', kind: 'fix', payload: { items: [] }, summary: 'x' });
  await svc.apply(a.id, { skip: ['k1'], skip_then: [] });
  assert.deepEqual(seen, { skip: ['k1'], skip_then: [] });
});
