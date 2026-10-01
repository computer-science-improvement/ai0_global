/** Regression tests for the agent-platform review (2026-10-02). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingActionsService } from './pending-actions';
import { ManagerRunner } from '../manager/manager-runner';
import { buildDirectiveTools } from '../manager/directive-tools';
import { isCrawler, publicUrlOf } from '../promo/tracked-links';
import { EditorScheduler } from '../editor.scheduler';

test('pending actions: concurrent applies run the handler once', async () => {
  let runs = 0;
  let status = 'pending';
  const row = { id: 'a1', status, kind: 'k', payload: {}, createdAt: new Date() } as any;
  const repo: any = {
    get: async () => ({ ...row, status }),
    decide: async (_id: string, st: string) => { status = st; return { ...row, status }; },
  };
  const svc = new PendingActionsService(repo);
  svc.register('k', async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return { ok: true }; });
  const results = await Promise.allSettled([svc.apply('a1'), svc.apply('a1')]);
  assert.equal(runs, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal((await svc.apply('a1')).status, 'applied');
});

test('manager wakes an orchestrator at most once an hour', async () => {
  const runner = new ManagerRunner({
    loop: {} as any, registry: {} as any, runtime: {} as any, digest: {} as any, inbox: {} as any, env: () => undefined,
    agents: { get: async () => ({ id: 'o1', status: 'active', pausedUntil: null }) as any, findTop: async () => null, list: async () => [] },
    repo: { undeliveredTargets: async () => ['o1'] } as any,
  });
  assert.equal((await runner.orchestratorsToWake()).length, 1);
  assert.equal((await runner.orchestratorsToWake()).length, 0, 'not again within the hour');
});

test('orchestrators never see or accept shadow directives', async () => {
  const dir = { id: 'd1', toAgentId: 'o1', status: 'new', shadow: true };
  const tools = buildDirectiveTools({
    repo: { get: async () => dir, list: async () => [dir, { ...dir, id: 'd2', shadow: false }], update: async () => null } as any,
    agents: {} as any, digest: {} as any, inbox: {} as any, memory: { listActive: async () => [] }, actions: {} as any, channelKeyOf: async () => '@x',
  });
  const ctx = { runId: 'r', role: 'orchestrator' as const, channelKey: '@x', extras: { orchestrator: { id: 'o1' } } };
  const accept = tools.find((t) => t.name === 'accept_directive')!;
  assert.equal(((await accept.execute({ id: 'd1', plan: 'зроблю як просять завтра', conflicting_rule_ids: [] }, ctx)) as any).error, 'directive_not_found');
  const list = tools.find((t) => t.name === 'list_directives')!;
  assert.deepEqual(((await list.execute({ limit: 20 }, ctx)) as any).directives.map((x: any) => x.id), ['d2']);
  assert.equal(accept.input.safeParse({ id: '00000000-0000-4000-8000-000000000001', plan: 'зроблю як просять завтра' }).success, false, 'rule ids must be stated');
});

test('click counting skips crawlers; public URLs per platform', () => {
  assert.equal(isCrawler('TelegramBot (like TwitterBot)'), true);
  assert.equal(isCrawler('facebookexternalhit/1.1'), true);
  assert.equal(isCrawler(null), true);
  assert.equal(isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148'), false);
  assert.equal(publicUrlOf({ platform: 'instagram', username: 'space_ig' }), 'https://www.instagram.com/space_ig/');
  assert.equal(publicUrlOf({ platform: 'tiktok', username: null }), null);
});

test('scheduler: reserved slots are published while a long main tick runs', async () => {
  let release!: () => void;
  const long = new Promise<void>((r) => { release = r; });
  let reservedRuns = 0;
  const sched = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => { await long; return []; } },
    plans: { skipStale: async () => 0, sweepStuck: async () => [], claimDue: async () => [], getActivePlan: async () => null, consecutiveFailures: async () => 0 } as any,
    runner: {} as any, enabled: () => true, notify: async () => {},
    reserved: { publishDue: async () => { reservedRuns++; return 0; } },
  });
  const first = sched.cronTick();
  await new Promise((r) => setTimeout(r, 5));
  await sched.cronTick(); // the main tick is still busy
  assert.equal(reservedRuns, 2);
  release();
  await first;
});
