/**
 * Spec 025 T3: the orchestrator's answers (decline_advice, contest_directive with the FR-006 checks), the owner's
 * decision on a contested directive (uphold / accept-refusal / timeout), and non-response handling (FR-007).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectiveTools, checkContest } from './directive-tools';
import { AUTO_APPLIED, ManagerRunner } from './manager-runner';
import { ManagerService } from './manager.service';
import type { Directive } from './directives.repository';

const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live', status: 'active', scopeId: 'telegram:@space' } as any;
const TG = 'telegram:@space';
const IG = 'instagram:42';

/** An in-memory agent_directives with the repository's guarded transitions. */
function store(rows: Array<Partial<Directive>>) {
  const map = new Map<string, Directive>();
  for (const r of rows) {
    map.set(r.id!, {
      toAgentId: 'o1', kind: 'format_shift', binding: 'directive', status: 'new', shadow: false, params: {}, body: `body ${r.id}`,
      rationale: 'r', resolution: null, reasonKind: null, ownerDecision: null, verification: null, deliveredAt: new Date(Date.now() - 25 * 3600_000),
      createdAt: new Date(Date.now() - 26 * 3600_000), contestedAt: null, execError: null, change: null, ...r,
    } as Directive);
  }
  const memory: any[] = [];
  const repo = {
    rows: map, memory,
    get: async (id: string) => (map.has(id) ? { ...map.get(id)! } : null),
    update: async (id: string, p: any, onlyIf?: string[]) => {
      const x = map.get(id);
      if (!x || (onlyIf && !onlyIf.includes(x.status))) return null;
      const next = { ...x, ...(p.status ? { status: p.status } : {}), ...(p.resolution ? { resolution: p.resolution } : {}),
        ...(p.reasonKind ? { reasonKind: p.reasonKind } : {}), ...(p.ownerDecision ? { ownerDecision: p.ownerDecision } : {}) };
      map.set(id, next);
      return { ...next };
    },
    contest: async (id: string, p: any) => {
      const x = map.get(id);
      if (!x || x.status !== 'new' || x.binding !== 'directive') return null;
      const next = { ...x, status: 'contested' as const, contestedAt: new Date(), resolution: p.reason, reasonKind: p.reasonKind, verification: { ...(x.verification ?? {}), contest: p.check } };
      map.set(id, next);
      return { ...next };
    },
    unanswered: async () => [...map.values()].filter((x) => x.status === 'new' && !x.shadow),
    expireShadowUnanswered: async () => 0,
    contestedOlderThan: async (ms: number) => [...map.values()].filter((x) => x.status === 'contested' && x.contestedAt && Date.now() - x.contestedAt.getTime() > ms),
    addMemory: async (...a: any[]) => { memory.push(a); },
  };
  return repo;
}

function toolsFor(repo: any, o: { usable?: boolean; dry?: any; inbox?: any[] } = {}) {
  const inbox = o.inbox ?? [];
  const tools = buildDirectiveTools({
    repo, agents: { getByHandle: async () => ORCH, findTop: async () => null } as any,
    digest: { build: async () => ({}) as any, render: () => '{}' }, inbox: { post: async (i: any) => { inbox.push(i); return inbox.length; } },
    memory: { listActive: async () => [{ id: 5, kind: 'rule', text: 'Без мемів', createdBy: 'owner' }, { id: 6, kind: 'insight', text: 'x', createdBy: 'reviewer' }] as any },
    actions: { propose: async () => ({}) as any }, channelKeyOf: async () => '@space',
    exec: { dryRun: async () => o.dry ?? { kind: 'format_shift' }, executorFor: (k: string) => (['format_shift', 'frequency'].includes(k) ? ({} as any) : null) } as any,
    scopeOf: async () => [TG, IG], usable: async () => o.usable ?? true,
  });
  const ctx = { runId: 'r', role: 'orchestrator' as const, channelKey: '@space', extras: { orchestrator: ORCH } };
  const call = (name: string, input: any) => tools.find((t) => t.name === name)!.execute(input, ctx) as Promise<any>;
  return { call, inbox };
}

test('decline_advice: advice → declined (no Inbox, no cooldown basis); a binding directive → binding_directive_use_contest', async () => {
  const repo = store([{ id: 'adv', binding: 'advice' }, { id: 'dir' }]);
  const { call, inbox } = toolsFor(repo);
  const r = await call('decline_advice', { id: 'adv', reason_kind: 'data', reason: 'каруселі в нас слабші за фото' });
  assert.equal(r.ok, true);
  assert.deepEqual([repo.rows.get('adv')!.status, repo.rows.get('adv')!.reasonKind], ['declined', 'data']);
  assert.equal(inbox.length, 0, 'no Inbox entry');
  assert.equal((await call('decline_advice', { id: 'dir', reason_kind: 'preference', reason: 'не подобається нам' })).error, 'binding_directive_use_contest');
  assert.equal(repo.rows.get('dir')!.status, 'new');
  assert.equal((await call('decline_advice', { id: 'adv', reason_kind: 'data', reason: 'ще раз відхиляю' })).error, 'not_open');
});

test('contest_directive: advice → advice_use_decline; playbook/data/preference → directive_is_binding', async () => {
  const repo = store([{ id: 'adv', binding: 'advice' }, { id: 'dir' }]);
  const { call, inbox } = toolsFor(repo);
  assert.equal((await call('contest_directive', { id: 'adv', reason_kind: 'owner_rule', reason: 'суперечить правилу власника #5', rule_ids: [5] })).error, 'advice_use_decline');
  for (const k of ['playbook', 'data', 'preference']) {
    assert.equal((await call('contest_directive', { id: 'dir', reason_kind: k, reason: 'плейбук каже інакше, тому не буду' })).error, 'directive_is_binding', k);
  }
  assert.equal(inbox.length, 0);
});

test('contest with an unknown rule id → reason_not_verified; a valid one → contested with exactly one directive_contested entry', async () => {
  const repo = store([{ id: 'dir' }]);
  const { call, inbox } = toolsFor(repo);
  const bad = await call('contest_directive', { id: 'dir', reason_kind: 'owner_rule', reason: 'суперечить правилу власника про меми', rule_ids: [99] });
  assert.equal(bad.error, 'reason_not_verified');
  assert.match(bad.details, /#99/);
  const notOwner = await call('contest_directive', { id: 'dir', reason_kind: 'owner_rule', reason: 'суперечить нотатці рецензента про меми', rule_ids: [6] });
  assert.equal(notOwner.error, 'reason_not_verified', 'a reviewer note is not an owner rule');
  assert.equal((await call('contest_directive', { id: 'dir', reason_kind: 'owner_rule', reason: 'немає id правила, але воно є', rule_ids: [] })).error, 'reason_not_verified');
  assert.equal(repo.rows.get('dir')!.status, 'new');

  const ok = await call('contest_directive', { id: 'dir', reason_kind: 'owner_rule', reason: 'власник заборонив меми (#5), а директива про меми', rule_ids: [5] });
  assert.equal(ok.ok, true);
  const row = repo.rows.get('dir')!;
  assert.equal(row.status, 'contested');
  assert.ok(row.contestedAt);
  assert.equal(row.verification.contest.verified, true);
  assert.deepEqual(row.verification.contest.rule_ids, [5]);
  assert.equal((await call('contest_directive', { id: 'dir', reason_kind: 'owner_rule', reason: 'власник заборонив меми (#5), ще раз', rule_ids: [5] })).error, 'not_open');
  assert.equal(inbox.length, 1);
  assert.deepEqual([inbox[0].kind, inbox[0].severity, inbox[0].refType, inbox[0].refId], ['directive_contested', 'action', 'directive', 'dir']);
  assert.match(inbox[0].body, /layer 1 · owner rules/);
  assert.match(inbox[0].body, /Uphold/);
});

test('contest checks: health (in scope and unusable), capability (plan fails now), safety (unverified)', async () => {
  const d = (o: { usable?: boolean; dry?: any } = {}) => ({
    memory: { listActive: async () => [] } as any, channelKeyOf: async () => '@space', scopeOf: async () => [TG, IG],
    usable: async () => o.usable ?? true,
    exec: { dryRun: async () => o.dry ?? { kind: 'frequency' }, executorFor: (k: string) => (k === 'frequency' ? ({} as any) : null) } as any,
  });
  const dir = { kind: 'frequency' as const, params: {}, toAgentId: 'o1' };
  const now = new Date();
  assert.equal((await checkContest(d({ usable: false }), dir, ORCH, { reason_kind: 'health', resource_ref: IG }, now)).verified, true);
  assert.equal((await checkContest(d({ usable: true }), dir, ORCH, { reason_kind: 'health', resource_ref: IG }, now)).verified, false);
  assert.equal((await checkContest(d({ usable: false }), dir, ORCH, { reason_kind: 'health', resource_ref: 'facebook:1' }, now)).verified, false, 'out of scope');
  assert.equal((await checkContest(d({ usable: false }), dir, ORCH, { reason_kind: 'health' }, now)).verified, false, 'no resource_ref');
  assert.equal((await checkContest(d({ dry: { error: 'not_executable', details: 'series gone' } }), dir, ORCH, { reason_kind: 'capability' }, now)).verified, true);
  assert.equal((await checkContest(d(), dir, ORCH, { reason_kind: 'capability' }, now)).verified, false);
  assert.equal((await checkContest(d(), { ...dir, kind: 'task' }, ORCH, { reason_kind: 'capability' }, now)).verified, false, 'no executor → not checkable');
  assert.equal((await checkContest(d(), dir, ORCH, { reason_kind: 'safety' }, now)).verified, 'unverified');
  // A safety contest is accepted and the card says "unverified".
  const repo = store([{ id: 'dir' }]);
  const { call, inbox } = toolsFor(repo);
  assert.equal((await call('contest_directive', { id: 'dir', reason_kind: 'safety', reason: 'це порушить тихі години каналу' })).ok, true);
  assert.equal(repo.rows.get('dir')!.verification.contest.verified, 'unverified');
  assert.match(inbox[0].body, /unverified/);
});

/** A ManagerRunner over the in-memory store with a stub executor runner. */
function runner(repo: any, o: { dry?: any; usable?: boolean; agent?: any; inbox?: any[] } = {}) {
  const executed: string[] = [];
  const baselines: string[] = [];
  const inbox = o.inbox ?? [];
  const exec = {
    executorFor: (k: string) => (['format_shift', 'frequency'].includes(k) ? ({} as any) : null),
    dryRun: async () => o.dry ?? { kind: 'format_shift' },
    execute: async (dir: Directive) => {
      executed.push(dir.id);
      return repo.update(dir.id, { status: 'applied' }, ['accepted']);
    },
  } as any;
  const r = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => ({ id: 'm', handle: 'manager' }) as any, get: async () => o.agent ?? ORCH, list: async () => [ORCH] } as any,
    repo, digest: { build: async () => ({ resources: [], raw: new Map() }) as any, render: () => '', snapshot: async () => 0 },
    inbox: { post: async (i: any) => { inbox.push(i); return 1; } }, env: () => undefined, exec,
    usable: async () => o.usable ?? true,
  });
  (r as any).recordBaseline = async (dir: Directive) => { baselines.push(dir.id); };
  return { r, executed, baselines, inbox };
}

test('uphold runs the executor (owner_decision upheld); a guard that fails → not_executable; a repeat → not_contested', async () => {
  const repo = store([{ id: 'c1', status: 'contested' }, { id: 'c2', status: 'contested' }, { id: 'c3', status: 'contested', kind: 'frequency', params: { resource_ref: IG } }]);
  const s = runner(repo);
  const up: any = await s.r.uphold('c1');
  assert.equal(up.directive.status, 'applied');
  assert.equal(up.directive.ownerDecision, 'upheld');
  assert.deepEqual(s.executed, ['c1']);
  assert.deepEqual(s.baselines, ['c1']);
  assert.deepEqual(await s.r.uphold('c1'), { error: 'not_contested', details: 'applied' });

  const blocked = runner(repo, { dry: { error: 'not_executable', details: 'format gone' } });
  assert.deepEqual(await blocked.r.uphold('c2'), { error: 'not_executable', details: 'format gone' });
  assert.equal(repo.rows.get('c2')!.status, 'contested', 'stays contested');
  const sick = runner(repo, { usable: false });
  assert.equal(((await sick.r.uphold('c3')) as any).error, 'not_executable');
  assert.equal(repo.rows.get('c3')!.status, 'contested');
  assert.deepEqual(await s.r.uphold('ghost'), { error: 'directive_not_found' });
});

test('accept-refusal: rejected + refusal_accepted (the cooldown basis) and a MANAGER lesson; REST maps errors to 409/404', async () => {
  const repo = store([{ id: 'c1', status: 'contested', kind: 'frequency', reasonKind: 'owner_rule', resolution: 'правило власника #5' }]);
  const s = runner(repo);
  const svc = new ManagerService({ repo: repo as any, agents: {} as any, digest: {} as any, runner: s.r });
  const out: any = await svc.ownerDecision('c1', 'accept_refusal');
  assert.deepEqual([out.directive.status, out.directive.ownerDecision], ['rejected', 'refusal_accepted']);
  assert.equal(repo.memory.length, 1);
  assert.match(repo.memory[0][2], /став на бік @kira щодо frequency/);
  assert.deepEqual(s.executed, [], 'nothing executed');
  await assert.rejects(svc.ownerDecision('c1', 'uphold'), (e: any) => e.status === 409 && e.response.error === 'not_contested');
  await assert.rejects(svc.ownerDecision('c1', 'accept_refusal'), (e: any) => e.status === 409);
  await assert.rejects(svc.ownerDecision('ghost', 'uphold'), (e: any) => e.status === 404);
});

test('contest timeout: the refusal stands (rejected, timeout_dropped) after DIRECTIVE_CONTEST_TIMEOUT_HOURS', async () => {
  const repo = store([
    { id: 'old', status: 'contested', contestedAt: new Date(Date.now() - 25 * 3600_000) },
    { id: 'fresh', status: 'contested', contestedAt: new Date(Date.now() - 3600_000) },
  ]);
  const s = runner(repo);
  assert.equal(await s.r.contestTimeouts(), 1);
  assert.deepEqual([repo.rows.get('old')!.status, repo.rows.get('old')!.ownerDecision], ['rejected', 'timeout_dropped']);
  assert.equal(repo.rows.get('fresh')!.status, 'contested');
});

test('non-response (FR-007): advice expires silently; a directive with an executor is auto-applied; task → ignored; paused target → expired + info', async () => {
  const repo = store([
    { id: 'adv', binding: 'advice' },
    { id: 'fs', kind: 'format_shift' },
    { id: 'task', kind: 'task' },
    { id: 'promo', kind: 'cross_promo' },
    { id: 'undelivered', kind: 'frequency', deliveredAt: null },
  ]);
  const s = runner(repo);
  const r = await s.r.resolveUnanswered();
  assert.deepEqual(r, { expired: 2, autoApplied: 2, ignored: 1 });
  assert.equal(repo.rows.get('adv')!.status, 'expired');
  assert.deepEqual([repo.rows.get('fs')!.status, repo.rows.get('fs')!.resolution], ['applied', AUTO_APPLIED]);
  assert.deepEqual(s.executed, ['fs']);
  assert.equal(repo.rows.get('promo')!.status, 'accepted', 'promo kinds wait for PromoPlanner');
  assert.equal(repo.rows.get('task')!.status, 'expired');
  assert.equal(repo.rows.get('undelivered')!.status, 'expired');
  const kinds = s.inbox.map((i) => [i.refId, i.kind, i.severity]).sort();
  assert.deepEqual(kinds, [
    ['fs', 'directive_auto_applied', 'info'], ['promo', 'directive_auto_applied', 'info'],
    ['task', 'directive_ignored', 'action'], ['undelivered', 'directive_expired', 'info'],
  ]);

  const paused = store([{ id: 'p1' }]);
  const ps = runner(paused, { agent: { ...ORCH, mode: 'off' } });
  assert.deepEqual(await ps.r.resolveUnanswered(), { expired: 1, autoApplied: 0, ignored: 0 });
  assert.equal(paused.rows.get('p1')!.status, 'expired');
  assert.deepEqual(ps.executed, []);
  assert.deepEqual(ps.inbox.map((i) => [i.kind, i.severity]), [['directive_expired', 'info']]);
});
