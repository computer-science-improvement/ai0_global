import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, stateOfRole, unitState, type UnitFacts } from './unit-state';
import { levelLine, levelOf, levelScore } from './level';

const NOW = new Date('2026-10-20T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const agent = (o: Partial<{ kind: any; status: 'active' | 'paused'; pausedUntil: Date | null }> = {}) => ({ kind: 'orchestrator' as const, status: 'active' as const, pausedUntil: null, ...o });
const facts = (o: Partial<UnitFacts> = {}): UnitFacts => ({ effectiveMode: 'live', resourcePaused: false, ...o });

test('idle by default; since is the last run', () => {
  assert.deepEqual(unitState(agent(), facts({ lastRunAt: ago(90) }), NOW), { state: 'idle', since: ago(90), detail: null });
  assert.equal(unitState(agent(), facts(), NOW).since, null);
});

test('rule 1: paused by status, by paused_until, or by the home resource', () => {
  assert.equal(unitState(agent({ status: 'paused' }), facts(), NOW).state, 'paused');
  assert.equal(unitState(agent({ pausedUntil: new Date(NOW.getTime() + 60_000) }), facts(), NOW).state, 'paused');
  assert.equal(unitState(agent({ pausedUntil: ago(5) }), facts(), NOW).state, 'idle', 'an expired pause is not a pause');
  const r = unitState(agent(), facts({ resourcePaused: true }), NOW);
  assert.equal(r.state, 'paused');
  assert.match(r.detail!, /resource/);
});

test('rule 2: off mode', () => {
  assert.equal(unitState(agent(), facts({ effectiveMode: 'off' }), NOW).state, 'off');
});

test('rule 3: a running run maps its role to a state, with the slot topic or the role as detail', () => {
  const run = (role: string, topic: string | null = null) => unitState(agent(), facts({ runningRun: { role, startedAt: ago(2), topic } }), NOW);
  for (const [role, state] of [
    ['planner', 'planning'], ['orchestrator', 'planning'], ['manager', 'planning'], ['onboarder', 'planning'], ['builder', 'planning'],
    ['executor', 'writing'], ['composer', 'writing'],
    ['reviewer', 'reviewing'], ['checker', 'reviewing'], ['idea_reviewer', 'reviewing'],
  ] as const) assert.equal(run(role).state, state, role);
  assert.deepEqual(run('executor', 'Bridge opens'), { state: 'writing', since: ago(2), detail: 'Bridge opens' });
  assert.equal(run('executor').detail, 'executor');
  assert.equal(stateOfRole('whatever'), 'planning');
});

test('rule 3: a "running" run older than 30 minutes is stuck, not work', () => {
  const r = unitState(agent(), facts({ runningRun: { role: 'executor', startedAt: ago(31), topic: null } }), NOW);
  assert.equal(r.state, 'idle');
});

test('rule 4: a failed run or a failed slot within 2 hours is an error; older is not', () => {
  for (const status of ['error', 'budget_exceeded', 'max_steps', 'no_terminal']) {
    const r = unitState(agent(), facts({ lastRun: { status, finishedAt: ago(30), error: null } }), NOW);
    assert.equal(r.state, 'error', status);
    assert.ok(r.detail);
  }
  assert.equal(unitState(agent(), facts({ lastRun: { status: 'ok', finishedAt: ago(30), error: null } }), NOW).state, 'idle');
  assert.equal(unitState(agent(), facts({ lastRun: { status: 'error', finishedAt: ago(121), error: 'x' } }), NOW).state, 'idle');
  assert.equal(unitState(agent(), facts({ lastRun: { status: 'error', finishedAt: ago(119), error: 'boom\nline two' } }), NOW).detail, 'boom line two');
  const slot = unitState(agent(), facts({ slots: { failed: { at: ago(10), error: 'publish_failed: 400 and the post said secret words' } } }), NOW);
  assert.deepEqual(slot, { state: 'error', since: ago(10), detail: 'publish_failed' }, 'only the error code of a slot reaches the map');
  assert.equal(unitState(agent(), facts({ slots: { failed: { at: ago(130), error: 'x' } } }), NOW).state, 'idle');
});

test('rule 4: the newer of a failed run and a failed slot gives the detail', () => {
  const r = unitState(agent(), facts({
    lastRun: { status: 'error', finishedAt: ago(20), error: 'run broke' },
    slots: { failed: { at: ago(5), error: 'lint_failed' } },
  }), NOW);
  assert.equal(r.detail, 'lint_failed');
  const r2 = unitState(agent(), facts({
    lastRun: { status: 'error', finishedAt: ago(5), error: 'run broke' },
    slots: { failed: { at: ago(20), error: 'lint_failed' } },
  }), NOW);
  assert.equal(r2.detail, 'run broke');
});

test('rule 5: publishing — a running slot, or an approved one due within 10 minutes', () => {
  assert.deepEqual(unitState(agent(), facts({ slots: { running: { at: ago(1), topic: 'Topic' } } }), NOW), { state: 'publishing', since: ago(1), detail: 'Topic' });
  const soon = { at: new Date(NOW.getTime() + 9 * 60_000), topic: 'Soon' };
  assert.equal(unitState(agent(), facts({ slots: { approvedDue: soon } }), NOW).state, 'publishing');
  const later = { at: new Date(NOW.getTime() + 11 * 60_000), topic: 'Later' };
  assert.equal(unitState(agent(), facts({ slots: { approvedDue: later } }), NOW).state, 'idle');
});

test('rule 6: waiting — an orchestrator whose resource has posts to approve; role children do not wait', () => {
  const slots = { awaiting: 3, awaitingSince: ago(50) };
  assert.deepEqual(unitState(agent(), facts({ slots }), NOW), { state: 'waiting', since: ago(50), detail: '3 posts wait for you' });
  assert.equal(unitState(agent(), facts({ slots: { awaiting: 1 } }), NOW).detail, '1 post waits for you');
  assert.equal(unitState(agent({ kind: 'executor' }), facts({ slots }), NOW).state, 'idle');
});

test('precedence: paused > off > running > error > publishing > waiting > idle', () => {
  const all = (o: Partial<UnitFacts>): UnitFacts => facts({
    runningRun: { role: 'executor', startedAt: ago(1), topic: null },
    lastRun: { status: 'error', finishedAt: ago(5), error: 'e' },
    slots: { running: { at: ago(1), topic: 't' }, awaiting: 2 },
    ...o,
  });
  assert.equal(unitState(agent({ status: 'paused' }), all({ effectiveMode: 'off' }), NOW).state, 'paused');
  assert.equal(unitState(agent(), all({ effectiveMode: 'off' }), NOW).state, 'off');
  assert.equal(unitState(agent(), all({}), NOW).state, 'writing');
  assert.equal(unitState(agent(), all({ runningRun: null }), NOW).state, 'error');
  assert.equal(unitState(agent(), all({ runningRun: null, lastRun: null }), NOW).state, 'publishing');
  assert.equal(unitState(agent(), all({ runningRun: null, lastRun: null, slots: { awaiting: 2 } }), NOW).state, 'waiting');
});

test('errorCode keeps only the part before the first colon', () => {
  assert.equal(errorCode('waiting for budget: agents cap'), 'waiting for budget');
  assert.equal(errorCode(null), null);
  assert.equal(errorCode('  '), null);
});

test('level: clean + passes - 2 x rejections - failed runs; level = clamp(1, 10, 1 + floor(score / 10))', () => {
  assert.equal(levelScore({ clean: 12, pass: 18, rejected: 1, failedRuns: 0 }), 28);
  assert.equal(levelOf(28), 3);
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(-40), 1, 'never below 1');
  assert.equal(levelOf(9), 1);
  assert.equal(levelOf(10), 2);
  assert.equal(levelOf(90), 10);
  assert.equal(levelOf(5000), 10, 'never above 10');
});

test('level: volume does not help — rejections and failed runs cost more than a pass earns', () => {
  const careful = levelScore({ clean: 10, pass: 10, rejected: 0, failedRuns: 0 });
  const spammy = levelScore({ clean: 10, pass: 10, rejected: 8, failedRuns: 5 });
  assert.ok(spammy < careful);
  assert.equal(spammy, -1);
});

test('levelLine explains the score in one line', () => {
  assert.equal(levelLine({ clean: 12, pass: 18, rejected: 1, failedRuns: 0 }), '12 clean approvals, 18 critic passes, 1 rejection in 30 days');
  assert.equal(levelLine({ clean: 1, pass: 1, rejected: 0, failedRuns: 2 }), '1 clean approval, 1 critic pass, 0 rejections, 2 failed runs in 30 days');
});
