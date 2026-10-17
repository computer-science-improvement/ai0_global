import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQualityReview, DEFAULT_MIN_CHANGE_PCT, fileDirective, FileDirectiveInput } from './directive-tools';
import { canSkip, openDirectivesText } from './manager-runner';
import { reviewSignature } from './kpi-digest.service';
import { DirectiveExecution } from './executors';
import { alreadySatisfied } from './executors/playbook-change';

/** Spec 040 FR-007: directives and manager runs. */

const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live' } as any;

function setup(o: { applied?: any; satisfied?: string } = {}) {
  const inserted: any[] = [];
  const updates: any[] = [];
  const repo = {
    openFor: async () => null,
    appliedFor: async () => o.applied ?? null,
    lastRejected: async () => null, countForRun: async () => 0, countOpenBinding: async () => 0, lastDeclinedAdvice: async () => null,
    insert: async (d: any) => { const x = { id: `d${inserted.length + 1}`, ...d, createdAt: new Date() }; inserted.push(x); return x; },
    update: async (id: string, p: any, onlyIf?: string[]) => { updates.push([id, p, onlyIf]); return { id, ...p }; },
  } as any;
  const deps = {
    repo, agents: { getByHandle: async (h: string) => (h.replace('@', '') === 'kira' ? ORCH : null), findTop: async () => null } as any,
    digest: { build: async () => ({}) as any, render: () => '{}' }, inbox: { post: async () => 1 },
    memory: { listActive: async () => [] as any }, actions: { propose: async () => ({}) as any }, channelKeyOf: async () => '@space',
    exec: {
      executorFor: () => ({}) as any,
      dryRun: async () => (o.satisfied ? alreadySatisfied(o.satisfied) : { op: 'format_weight', structural: false, reasons: [] } as any),
    },
  };
  return { deps, inserted, updates };
}

const input = (extra: Record<string, unknown> = {}) => FileDirectiveInput.parse({
  kind: 'format_shift', to: '@kira', body: 'Більше каруселей в Instagram', params: { format: 'ig_carousel', weight_delta: 0.2 },
  rationale: 'Каруселі дають на 60% більше переглядів за 28 днів', evidence: { views_per_post: { carousel: 1600, photo: 1000 } },
  expected: { metric: 'views_per_post', direction: 'up' }, ...extra,
});

test('file_directive schema: kind first, binding defaults to advice, min_change_pct has a default', () => {
  assert.equal(Object.keys(FileDirectiveInput.shape)[0], 'kind');
  const i = input();
  assert.equal(i.binding, 'advice');
  assert.equal(i.expected?.min_change_pct, DEFAULT_MIN_CHANGE_PCT);
});

test('an applied directive of the same kind must be named in supersedes, and is then closed as superseded', async () => {
  const applied = { id: '11111111-1111-4111-8111-111111111111', body: 'Більше каруселей', reviewAt: new Date('2026-10-20T00:00:00Z'), status: 'applied' };
  const a = setup({ applied });
  const r1: any = await fileDirective(a.deps, input(), { from: null, runId: 'r', shadow: false });
  assert.equal(r1.error, 'supersedes_required');
  assert.match(r1.details, /11111111-1111-4111-8111-111111111111/);
  assert.equal(a.inserted.length, 0);

  const wrong: any = await fileDirective(a.deps, input({ supersedes: '22222222-2222-4222-8222-222222222222' }), { from: null, runId: 'r', shadow: false });
  assert.equal(wrong.error, 'supersedes_mismatch');

  const ok: any = await fileDirective(a.deps, input({ supersedes: applied.id }), { from: null, runId: 'r', shadow: false });
  assert.equal(ok.ok, true);
  assert.equal(a.inserted[0].supersedes, applied.id);
  const closed = a.updates.find(([id]) => id === applied.id);
  assert.deepEqual([closed[1].status, closed[2]], ['superseded', ['accepted', 'applied']]);

  // A shadow filing never closes the live one.
  const s = setup({ applied });
  await fileDirective(s.deps, input({ supersedes: applied.id }), { from: null, runId: 'r', shadow: true });
  assert.equal(s.updates.filter(([id]) => id === applied.id).length, 0);

  // supersedes without an applied directive is a mistake, not ignored.
  const none: any = await fileDirective(setup().deps, input({ supersedes: applied.id }), { from: null, runId: 'r', shadow: false });
  assert.equal(none.error, 'supersedes_mismatch');
});

test('046: an accepted directive is replaceable too (named in supersedes), and the error says it was accepted', async () => {
  const accepted = { id: '33333333-3333-4333-8333-333333333333', body: 'Додай чек-лист у бриф', reviewAt: null, status: 'accepted' };
  const a = setup({ applied: accepted });
  const r1: any = await fileDirective(a.deps, input(), { from: null, runId: 'r', shadow: false });
  assert.equal(r1.error, 'supersedes_required');
  assert.match(r1.details, /прийнята/);
  const ok: any = await fileDirective(a.deps, input({ supersedes: accepted.id }), { from: null, runId: 'r', shadow: false });
  assert.equal(ok.ok, true);
  assert.equal(a.updates.find(([id]) => id === accepted.id)[1].status, 'superseded');
});

test('a change already in place answers already_satisfied and files nothing', async () => {
  const a = setup({ satisfied: 'вага ig_carousel уже 0.6 — зміна нічого не дасть' });
  const r: any = await fileDirective(a.deps, input(), { from: null, runId: 'r', shadow: false });
  assert.deepEqual([r.ok, r.already_satisfied], [true, true]);
  assert.match(r.details, /уже 0\.6/);
  assert.equal(a.inserted.length, 0);
});

test('execution: a plan that became satisfied marks the directive applied, not failed', async () => {
  const marked: any[] = [];
  const failed: any[] = [];
  const ex = new DirectiveExecution({
    repo: { markApplied: async (id: string, p: any) => { marked.push([id, p]); return { id, status: 'applied' }; }, execFailed: async (id: string, e: string) => { failed.push([id, e]); return 1; }, get: async () => null } as any,
    inbox: { post: async () => 1 } as any, agents: { get: async () => ORCH } as any,
    context: async () => ({}) as any,
    executors: [{ kind: 'pause_series', plan: () => alreadySatisfied('серія «Дайджест» уже на паузі'), apply: async () => ({ noop: false }) } as any],
  });
  const r = await ex.execute({ id: 'dir1', kind: 'pause_series', params: {}, toAgentId: 'o1', change: null } as any, ORCH);
  assert.equal(r?.status, 'applied');
  assert.equal(failed.length, 0);
  assert.equal(marked[0][1].verification.kind, 'already_satisfied');
});

test('quality_check: resources without an agent are exempt', () => {
  const active = { posts: 3, critic: { total: 3 }, owner: { approved: 0, rejected: 0 }, polls: { slots: 0 }, flags: ['critic_reject'] } as any;
  const dg = { resources: [
    { ref: 'telegram:@space', agent: 'kira', quality: active, anomalies: [] },
    { ref: 'telegram:@orphan', agent: null, quality: active, anomalies: [] },
  ] } as any;
  const base = { verdict: 'continue' as const };
  const missing = checkQualityReview({ ...base, quality_check: [] }, dg);
  assert.equal(missing?.error, 'quality_check_missing');
  assert.doesNotMatch(missing!.details, /@orphan/);
  const ok = checkQualityReview({ ...base, quality_check: [{ resource_ref: 'telegram:@space', status: 'ok', evidence: '3 вердикти критика, 1 reject — «звучить як ШІ»', issues: [], note: 'Один reject за тиждень — нижче порогу, порада вже відкрита' }] }, dg);
  assert.equal(ok, null);
});

test('manager skip: the same anomalies and flags skip the run, but one forced review a day', () => {
  const resources = [
    { ref: 'telegram:@space', agent: 'kira', anomalies: ['views_per_post'], quality: { flags: ['critic_reject'] } },
    { ref: 'telegram:@orphan', agent: null, anomalies: ['posts'], quality: { flags: [] } },
  ] as any;
  const sig = reviewSignature({ resources });
  // Order and agentless resources do not change it.
  assert.equal(reviewSignature({ resources: [{ ...resources[0], anomalies: ['views_per_post'] }] }), sig);
  const now = new Date('2026-10-16T13:00:00+03:00');
  const digest = { hash: 'h2', resources };
  assert.equal(canSkip({ digestHash: 'h1', signature: sig, lastRunAt: new Date('2026-10-16T08:05:00+03:00') }, digest, { now }), true, 'reviewed today with the same signature');
  assert.equal(canSkip({ digestHash: 'h1', signature: sig, lastRunAt: new Date('2026-10-15T20:00:00+03:00') }, digest, { now }), false, 'first review of the day is forced');
  const changed = { hash: 'h2', resources: [{ ...resources[0], anomalies: ['views_per_post', 'engagement_rate'] }] } as any;
  assert.equal(canSkip({ digestHash: 'h1', signature: sig, lastRunAt: now }, changed, { now }), false, 'a new anomaly always gets a look');
  assert.equal(canSkip({ digestHash: 'h1', signature: null, lastRunAt: now }, digest, { now }), false, 'rows before 079 have no signature');
});

test('the manager prompt lists the open directives with target, kind, status and review date', () => {
  const text = openDirectivesText([
    { id: 'abc', to: 'kira', kind: 'format_mix', status: 'applied', body: '…', createdAt: '2026-10-10T00:00:00Z', binding: 'advice', reviewAt: '2026-10-17T08:00:00Z' },
  ]);
  assert.equal(text, '- @kira · format_mix (advice) · applied · перевірка 2026-10-17 · id abc');
  assert.equal(openDirectivesText([]), '- немає');
});
