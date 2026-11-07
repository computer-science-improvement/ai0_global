/**
 * Spec 090 FR-002 unit tests: which directive kinds are applied on owner silence (registry + override + OWNER_SILENCE), the
 * same-pass hand-off to the executor, the decision rows, and that the "owner is not responding" memory line is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENCE_APPLY_DIRECTIVE_KINDS, SILENCE_DROP_DIRECTIVE_KINDS } from '../autonomy/owner-gates';
import { channelKeyOf, ManagerRunner } from './manager-runner';
import { directiveSilence, ownerAnswersLine, parseKinds } from './directive-silence';
import { ownerAnswersOf } from './kpi-digest.service';

const envOf = (m: Record<string, string> = {}) => (k: string) => m[k];

test('directiveSilence: an empty or absent setting means the registry default, not nothing', () => {
  for (const k of SILENCE_APPLY_DIRECTIVE_KINDS) assert.equal(directiveSilence(k, envOf()), 'apply', k);
  for (const k of SILENCE_APPLY_DIRECTIVE_KINDS) assert.equal(directiveSilence(k, envOf({ DIRECTIVE_TIMEOUT_APPLY_KINDS: '' })), 'apply', k);
  for (const k of SILENCE_DROP_DIRECTIVE_KINDS) assert.equal(directiveSilence(k, envOf()), 'drop', k);
});

test('directiveSilence: a non-empty setting decides among apply-capable kinds, and can never apply a drop kind', () => {
  const env = envOf({ DIRECTIVE_TIMEOUT_APPLY_KINDS: 'frequency, cross_promo,pause_resource' });
  assert.equal(directiveSilence('frequency', env), 'apply');
  assert.equal(directiveSilence('voice_fix', env), 'drop', 'not in the override list');
  assert.equal(directiveSilence('cross_promo', env), 'drop', 'registry wins on safety');
  assert.equal(directiveSilence('pause_resource', env), 'drop');
  assert.equal(directiveSilence('frequency', envOf(), ['voice_fix']), 'drop', 'an explicit override list also decides');
  assert.deepEqual(parseKinds(' a, b ,,c'), ['a', 'b', 'c']);
});

test('directiveSilence: OWNER_SILENCE=wait applies nothing', () => {
  for (const k of SILENCE_APPLY_DIRECTIVE_KINDS) assert.equal(directiveSilence(k, envOf({ OWNER_SILENCE: 'wait' })), 'drop', k);
  assert.equal(directiveSilence('frequency', envOf({ OWNER_SILENCE: 'wait', DIRECTIVE_TIMEOUT_APPLY_KINDS: 'frequency' })), 'drop');
});

test('channelKeyOf reads the channel a directive names', () => {
  assert.equal(channelKeyOf({ params: { resource_ref: 'telegram:@space' } } as any), '@space');
  assert.equal(channelKeyOf({ params: { channel_key: '@x', resource_ref: 'telegram:@y' } } as any), '@x');
  assert.equal(channelKeyOf({ params: {} } as any), null);
});

function setup(o: { awaiting: any[]; env?: Record<string, string>; exec?: any; orch?: any; decisions?: any[] }) {
  const updates: any[] = [];
  const memory: any[] = [];
  const posts: any[] = [];
  const decisions: any[] = o.decisions ?? [];
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => ({ id: 'm', handle: 'manager', mode: 'live' }) as any, get: async () => o.orch ?? null, list: async () => [] },
    repo: {
      awaitingOwnerOlderThan: async () => o.awaiting,
      // The row after the update: status/ownerDecision as written, the rest as filed.
      update: async (id: string, p: any, only?: string[]) => {
        const row = o.awaiting.find((x) => x.id === id) ?? { id, kind: 'frequency', binding: 'directive', toAgentId: 'o1', params: {} };
        if (only?.includes('new') && row.status !== 'new') return null;
        updates.push([id, p]);
        Object.assign(row, p);
        return row;
      },
      droppedInARow: async () => 5,
      unanswered: async () => [], expireShadowUnanswered: async () => 0, contestedOlderThan: async () => [],
      acceptedForExecution: async () => [], dueSeriesResumes: async () => [], awaitingVerification: async () => [], dueForEvaluation: async () => [],
      overdueTasks: async () => [], addMemory: async (...a: any[]) => { memory.push(a); },
    } as any,
    digest: { build: async () => ({ resources: [], raw: new Map() }) as any, render: () => '', snapshot: async () => 0 },
    inbox: { post: async (i: any) => { posts.push(i); return 1; } },
    env: envOf(o.env), exec: o.exec,
    decisions: { record: async (d: any) => { decisions.push(d); return decisions.length; } },
  });
  return { runner, updates, memory, posts, decisions };
}

const fakeExec = (log: any[], status = 'applied') => ({
  executorFor: () => ({}), execute: async (d: any) => { log.push(d.id); return { ...d, status }; },
  retryPending: async () => [], resumeSeries: async () => 0, verifyApplied: async () => 0, closeQuotas: async () => 0, executeAccepted: async () => [],
});
const dir = (id: string, kind: string, extra: any = {}) => ({ id, kind, binding: 'directive', toAgentId: 'o1', status: 'awaiting_owner', body: 'b', params: { resource_ref: 'telegram:@space' }, ...extra });
const orch = { id: 'o1', handle: 'kira', mode: 'live', pausedUntil: null };

test('housekeeping: a timeout_applied directive runs its executor in the same pass, with a decision row and no undo', async () => {
  const ran: string[] = [];
  const s = setup({ awaiting: [dir('d1', 'frequency')], exec: fakeExec(ran), orch });
  const r = await s.runner.housekeeping();
  assert.equal(r.timedOut, 1);
  assert.deepEqual(ran, ['d1'], 'no second wait: the executor ran in this pass');
  assert.deepEqual(s.updates.map((u) => u[1].ownerDecision ?? u[1].status), ['timeout_applied', 'accepted']);
  assert.equal(s.decisions.length, 1);
  assert.deepEqual([s.decisions[0].gate, s.decisions[0].refType, s.decisions[0].refId, s.decisions[0].channelKey, s.decisions[0].action, s.decisions[0].undo],
    ['directive:frequency', 'directive', 'd1', '@space', 'applied', null]);
  assert.match(s.decisions[0].summary, /applied/);
  assert.equal(s.posts[0].kind, 'directive_auto_applied');
});

test('housekeeping: a drop kind expires with a dropped decision, whatever the override says', async () => {
  const ran: string[] = [];
  const s = setup({ awaiting: [dir('d2', 'cross_promo')], env: { DIRECTIVE_TIMEOUT_APPLY_KINDS: 'cross_promo,frequency' }, exec: fakeExec(ran), orch });
  await s.runner.housekeeping();
  assert.deepEqual(ran, []);
  assert.deepEqual(s.updates.map((u) => u[1].ownerDecision), ['timeout_dropped']);
  assert.equal(s.decisions[0].action, 'dropped');
  assert.equal(s.decisions[0].gate, 'directive:cross_promo');
});

test('housekeeping: OWNER_SILENCE=wait drops every timeout; an empty setting applies the registry default', async () => {
  const w = setup({ awaiting: [dir('d3', 'frequency')], env: { OWNER_SILENCE: 'wait' }, exec: fakeExec([]), orch });
  await w.runner.housekeeping();
  assert.deepEqual(w.updates.map((u) => u[1].ownerDecision), ['timeout_dropped']);
  const e = setup({ awaiting: [dir('d4', 'voice_fix')], env: { DIRECTIVE_TIMEOUT_APPLY_KINDS: '' }, exec: fakeExec([]), orch });
  await e.runner.housekeeping();
  assert.equal(e.updates[0][1].ownerDecision, 'timeout_applied');
});

test('housekeeping: advice / task (no executor to hand off to) stay for the orchestrator; a failed executor is logged as failed', async () => {
  const ran: string[] = [];
  const s = setup({ awaiting: [dir('d5', 'task', { binding: 'directive' }), dir('d6', 'advice', { binding: 'advice' })], exec: { ...fakeExec(ran), executorFor: () => null }, orch });
  await s.runner.housekeeping();
  assert.deepEqual(ran, []);
  assert.deepEqual(s.updates.map((u) => u[1].ownerDecision), ['timeout_applied', 'timeout_applied']);
  assert.deepEqual(s.decisions.map((d) => d.action), ['applied', 'applied']);
  const f = setup({ awaiting: [dir('d7', 'frequency')], exec: fakeExec([], 'failed'), orch });
  await f.runner.housekeeping();
  assert.equal(f.decisions[0].action, 'failed');
});

test('housekeeping: five timeouts in a row no longer write a "propose less" memory line', async () => {
  const s = setup({ awaiting: [dir('d8', 'cross_promo')], exec: fakeExec([]), orch });
  await s.runner.housekeeping();
  assert.equal(s.memory.length, 0);
});

test('owner_answers: the fact line and its query', async () => {
  assert.equal(ownerAnswersLine(2, 5), 'owner answered 2 of 5 structural directives in 14 days');
  const pool = { query: async () => ({ rows: [{ answered: 2, total: 5 }] }) } as any;
  assert.deepEqual(await ownerAnswersOf(pool), { answered: 2, total: 5, days: 14, line: 'owner answered 2 of 5 structural directives in 14 days' });
  assert.equal(await ownerAnswersOf({ query: async () => ({ rows: [{ answered: 0, total: 0 }] }) } as any), undefined);
  assert.equal(await ownerAnswersOf({ query: async () => { throw new Error('no table'); } } as any), undefined);
});
