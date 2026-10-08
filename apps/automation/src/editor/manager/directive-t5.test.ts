/**
 * Spec 025 T5: the experiment quota in both plan validators, the experiment / strategy executors, promo
 * verification, report_directive_done for a task, and the quota deadline (closeQuotas).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../roles/plan-rules';
import { validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import { makeCard } from '../post/testing/fixtures';
import { experimentQuotaErrors, renderExperimentQuotas, type ExperimentQuota } from './experiment-quota';
import {
  DirectiveExecution, experimentExecutor, PlaybookBuildPort, promoVerifier, strategyExecutor, type ExecContext, type ExperimentChange, type StrategyChange,
} from './executors';
import { buildDirectiveTools } from './directive-tools';

const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const TG = 'telegram:@space';
const IG = 'instagram:ig1';
const quota = (o: Partial<ExperimentQuota> = {}): ExperimentQuota => ({
  directiveId: D1, resourceRef: TG, angle: 'Питання до аудиторії замість висновку', format: null, remaining: 2, deadline: '2026-10-04T05:00:00.000Z', ...o,
});

// ── single-channel validator (roles/plan-rules) ─────────────────────────────

const card = makeCard({ channelKey: '@space', postsPerDayMin: 2, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8, exploreRatio: 0.25 });
const now = new Date('2026-10-01T04:00:00Z'); // 07:00 Kyiv
const slot = (time: string, extra: any = {}) => ({ time, format: 'photo', topic: 'Тема поста про космос', source_hints: [], is_experiment: false, ...extra });

test('single-channel plan without the required experiment slot is refused with a Ukrainian error naming the directive', () => {
  const v = validatePlan({ rationale: 'Два пости у найкращі години', slots: [slot('09:00'), slot('19:30')] }, card, '2026-10-01', now, [], undefined, [quota()]);
  assert.equal(v.ok, false);
  const errors = (v as any).errors.join('\n');
  assert.match(errors, new RegExp(`директива ${D1} \\(експеримент «Питання до аудиторії`));
  assert.match(errors, /потрібен щонайменше 1 слот з directive_id/);
});

test('single-channel plan with the experiment slot: hint directive:<id>, is_experiment, not counted against explore_ratio, the directive format allowed', () => {
  const plan = { rationale: 'Два пости і експеримент', slots: [slot('09:00'), slot('13:00', { directive_id: D1, format: 'poll' }), slot('19:30', { is_experiment: true })] };
  const v = validatePlan(plan, { ...card, formats: { photo: 1, text: 0.5 } }, '2026-10-01', now, [], undefined, [quota({ format: 'poll' })]);
  assert.equal(v.ok, true, (v as any).errors?.join('\n'));
  if (!v.ok) return;
  assert.deepEqual(v.slots[1].sourceHints, [`directive:${D1}`]);
  assert.equal(v.slots[1].isExperiment, true);
  // explore_ratio 0.25 × 3 = 1: the own experiment fits because the directive slot does not count.
  // Without the quota the poll format is not allowed and the directive id is unknown.
  const bare = validatePlan(plan, { ...card, formats: { photo: 1, text: 0.5 } }, '2026-10-01', now);
  assert.equal(bare.ok, false);
  assert.match((bare as any).errors.join('\n'), /не має відкритої квоти/);
  assert.match((bare as any).errors.join('\n'), /формат poll не дозволений/);
});

test('single-channel quota rule: too many slots, wrong format, no capacity late in the day', () => {
  const two = validatePlan({ rationale: 'Забагато експериментів', slots: [slot('09:00', { directive_id: D1 }), slot('13:00', { directive_id: D1 })] }, card, '2026-10-01', now, [], undefined, [quota({ remaining: 1 })]);
  assert.match((two as any).errors.join('\n'), /слотів експерименту 2, а лишилось 1/);
  const fmt = validatePlan({ rationale: 'Не той формат', slots: [slot('09:00', { directive_id: D1 }), slot('13:00')] }, card, '2026-10-01', now, [], undefined, [quota({ format: 'text' })]);
  assert.match((fmt as any).errors.join('\n'), /у форматі text/);
  // 22:58 Kyiv: nothing fits today → the quota is not required (the next plan day takes it).
  const late = new Date('2026-10-01T19:58:00Z');
  const v = validatePlan({ rationale: 'Пізно, план порожній', slots: [] }, card, '2026-10-01', late, [], undefined, [quota()]);
  assert.equal(v.ok, true, (v as any).errors?.join('\n'));
});

// ── network validator (network/network-plan) ─────────────────────────────────

const RES = [{ ref: TG, platform: 'telegram' as const }, { ref: IG, platform: 'instagram' as const }];
const pb = (): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 0, max: 3 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 } },
  ],
});
const net = (): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
  resources: RES, playbook: pb(), playbookVersion: 1, telegramFormats: ['text', 'photo', 'carousel', 'longread'],
});
const ncard = { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 };
const NOW = new Date('2026-10-05T05:00:00Z'); // Monday 08:00 Kyiv
const runNet = (slots: any[], experiments: ExperimentQuota[]) => validateNetworkPlan({ rationale: 'День мережі', slots, skips: [] } as any, {
  net: net(), card: ncard, planDate: '2026-10-05', weekday: 1, now: NOW, ideas: new Map(), reservedAt: [], experiments,
});
const igExp = (o: any = {}) => ({ resource_ref: IG, time: '12:00', format: 'ig_carousel', topic: 'Питання до аудиторії', source_hints: [], directive_id: D1, ...o });

test('network plan without the required experiment slot is refused with a Ukrainian error naming the directive', () => {
  const v = runNet([{ resource_ref: TG, time: '10:00', format: 'photo', topic: 'Фото дня', series: undefined, source_hints: [], directive_id: D2 }], [quota({ resourceRef: IG })]);
  assert.equal(v.ok, false);
  const errors = (v as any).errors.join('\n');
  assert.match(errors, new RegExp(`директива ${D1} \\(експеримент «Питання до аудиторії замість висновку»\\): у плані потрібен щонайменше 1 слот з directive_id "${D1}" на ${IG}`));
  assert.match(errors, new RegExp(`директива ${D2} не має відкритої квоти`));
});

test('network plan with the experiment slot: no idea/series needed, is_experiment + hint, the directive format allowed on the platform', () => {
  const v = runNet([igExp({ format: 'ig_photo' })], [quota({ resourceRef: IG, format: 'ig_photo' })]);
  assert.equal(v.ok, true, (v as any).errors?.join('\n'));
  if (!v.ok) return;
  assert.deepEqual([v.slots[0].isExperiment, v.slots[0].sourceHints], [true, [`directive:${D1}`]]);
  assert.match((runNet([igExp()], [quota({ resourceRef: TG })]) as any).errors.join('\n'), /на telegram:@space, не на instagram:ig1/);
  assert.match((runNet([igExp({ treatment: 'duplicate', from_slot: 1 })], [quota({ resourceRef: IG })]) as any).errors.join('\n'), /лише unique/);
  // A resource outside the usable network (or without a section) is not required.
  assert.equal(runNet([], [quota({ resourceRef: 'threads:gone' })]).ok, true);
});

test('quota prompt block lists each open quota', () => {
  assert.equal(renderExperimentQuotas([]), null);
  const text = renderExperimentQuotas([quota({ format: 'poll' })])!;
  assert.match(text, new RegExp(`directive_id ${D1} → ${TG}: кут «Питання до аудиторії замість висновку», формат poll; ще 2 слот\\(и\\) до 2026-10-04`));
  assert.deepEqual(experimentQuotaErrors([quota()], [], () => false), [], 'no capacity → not required');
});

// ── experiment executor (FR-014) ─────────────────────────────────────────────

const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live', scopeId: TG } as any;
const CNOW = new Date('2026-10-20T09:00:00Z');
const ctx = (o: { mode?: any; playbook?: Playbook | null } = {}): ExecContext => {
  const playbook = o.playbook === undefined ? pb() : o.playbook;
  return {
    orch: ORCH, card: { channelKey: '@space', postsPerDayMax: 4, formats: { photo: 1 } } as any, playbook, now: CNOW, mode: 'live',
    net: { ...net(), mode: o.mode ?? 'independent', playbook },
  };
};
const dir = (kind: any, params: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id: D1, toAgentId: 'o1', kind, params, binding: 'directive', body: 'Спробуй питання до аудиторії в кінці поста', status: 'accepted', change: null, ...over }) as any;

test('experiment plan: params checked, the quota change (resource, angle, slots, deadline); not_executable cases', () => {
  const counts = { planned: 0, done: 0 };
  const ex = experimentExecutor({ quotas: { counts: async () => counts }, now: () => CNOW });
  const c = ex.plan(dir('experiment', { resource_ref: IG, angle: 'Питання до аудиторії замість висновку', format: 'ig_photo', slots: 2, within_days: 3 }), ctx()) as ExperimentChange;
  assert.deepEqual([c.op, c.target, c.channel_key, c.resource_ref, c.format, c.slots, c.within_days, c.structural], ['experiment', 'quota', '@space', IG, 'ig_photo', 2, 3, false]);
  assert.equal(c.deadline, '2026-10-23T09:00:00.000Z');
  const anchor = ex.plan(dir('experiment', { angle: 'Питання до аудиторії замість висновку' }), ctx()) as ExperimentChange;
  assert.deepEqual([anchor.resource_ref, anchor.slots, anchor.within_days], [TG, 1, 3], 'defaults: the anchor, 1 slot, 3 days');
  const bad = (p: Record<string, unknown>, c2 = ctx()) => (ex.plan(dir('experiment', { angle: 'Питання до аудиторії замість висновку', ...p }), c2) as any).error;
  assert.equal(bad({ angle: 'коротко' }), 'not_executable');
  assert.equal(bad({ slots: 4 }), 'not_executable');
  assert.equal(bad({ within_days: 0 }), 'not_executable');
  assert.equal(bad({ format: 'ig_reel', resource_ref: IG }), 'not_executable');
  assert.equal(bad({ resource_ref: 'facebook:9' }), 'not_executable');
  assert.equal(bad({ resource_ref: IG }, ctx({ mode: 'legacy_duplicate' })), 'not_executable', 'only an independent network plans other resources');
});

test('experiment apply: pending until a slot is planned, then applied; verify: verified when `slots` are published, not followed after the grace', async () => {
  const counts = { planned: 0, done: 0 };
  let at = CNOW;
  const ex = experimentExecutor({ quotas: { counts: async () => counts }, now: () => at });
  const c = ex.plan(dir('experiment', { angle: 'Питання до аудиторії замість висновку', slots: 2 }), ctx()) as ExperimentChange;
  assert.deepEqual(await ex.apply(c, dir('experiment', {})), { noop: false, pending: true });
  counts.planned = 1;
  assert.deepEqual(await ex.apply(c, dir('experiment', {})), { noop: false });
  const applied = dir('experiment', {}, { status: 'applied', change: c });
  assert.equal((await ex.verify(applied) as any).pending, true);
  counts.done = 2;
  assert.deepEqual(await ex.verify(applied).then((r: any) => [r.verified, r.adherence]), [true, 'followed']);
  counts.done = 1;
  at = new Date(new Date(c.deadline).getTime() + 25 * 3600_000);
  assert.deepEqual(await ex.verify(applied).then((r: any) => [r.verified, r.adherence]), [false, 'not_followed']);
});

/** DirectiveExecution over an in-memory row store. */
function execOver(executors: any[], o: { counts?: { planned: number; done: number } } = {}) {
  const rows = new Map<string, any>();
  const inbox: any[] = [];
  const repo = {
    get: async (id: string) => rows.get(id) ?? null,
    acceptedForExecution: async () => [...rows.values()].filter((r) => r.status === 'accepted'),
    setChange: async (id: string, c: any) => { rows.get(id).change = c; },
    mergeChange: async (id: string, p: any) => { const r = rows.get(id); r.change = { ...(r.change ?? {}), ...p }; },
    execFailed: async (id: string, e: string) => { const r = rows.get(id); r.execAttempts = (r.execAttempts ?? 0) + 1; r.execError = e; return r.execAttempts; },
    markApplied: async (id: string, p: any) => { const r = rows.get(id); if (r.status !== 'accepted') return null; Object.assign(r, { status: 'applied', appliedAt: new Date() }, p.change ? { change: p.change } : {}); return r; },
    markFailed: async () => null,
    update: async (id: string, p: any, onlyIf?: string[]) => { const r = rows.get(id); if (!r || (onlyIf && !onlyIf.includes(r.status))) return null; Object.assign(r, p); return r; },
    awaitingVerification: async (kinds: string[]) => [...rows.values()].filter((r) => r.status === 'applied' && kinds.includes(r.kind) && !r.verification?.adherence),
    setVerification: async (id: string, v: any, ok: boolean) => { const r = rows.get(id); r.verification = { ...(r.verification ?? {}), ...v }; if (ok) r.verifiedAt = new Date(); },
    dueSeriesResumes: async () => [], playbookLocks: async () => [],
    openExperiments: async () => [...rows.values()].filter((r) => r.kind === 'experiment' && ['accepted', 'applied'].includes(r.status) && r.change?.op === 'experiment'),
    failOpen: async (id: string, e: string) => { const r = rows.get(id); if (!['accepted', 'applied'].includes(r.status)) return null; Object.assign(r, { status: 'failed', execError: e }); return r; },
  };
  const exec = new DirectiveExecution({
    repo: repo as any, inbox: { post: async (i: any) => { inbox.push(i); return 1; } }, agents: { get: async () => ORCH } as any,
    context: async () => ctx(), executors, now: () => CNOW,
    quotas: { counts: async () => o.counts ?? { planned: 0, done: 0 } },
  });
  const add = (r: any) => { rows.set(r.id, { status: 'accepted', binding: 'directive', change: null, execAttempts: 0, body: 'b', toAgentId: 'o1', params: {}, ...r }); return rows.get(r.id); };
  return { exec, rows, inbox, add };
}

test('execution: an experiment stays accepted (quota open) until its first slot; a quota unfilled at the deadline → failed + Inbox', async () => {
  const counts = { planned: 0, done: 0 };
  const x = execOver([experimentExecutor({ quotas: { counts: async () => counts }, now: () => CNOW })], { counts });
  x.add({ id: 'e1', kind: 'experiment', params: { angle: 'Питання до аудиторії замість висновку', slots: 2 } });
  await x.exec.executeAccepted(ORCH);
  const e1 = x.rows.get('e1');
  assert.equal(e1.status, 'accepted');
  assert.equal(e1.change.op, 'experiment', 'the quota (change) is stored → open');
  assert.equal(e1.execAttempts, 0, 'pending is not a failure');
  counts.planned = 1;
  await x.exec.execute(e1, ORCH);
  assert.equal(e1.status, 'applied');
  assert.equal(await x.exec.closeQuotas(), 0, 'before the deadline nothing closes');
  e1.change.deadline = new Date(CNOW.getTime() - 60_000).toISOString();
  assert.equal(await x.exec.closeQuotas(), 1);
  assert.equal(e1.status, 'failed');
  assert.match(e1.execError, /1\/2 slot/);
  assert.equal(e1.verification.adherence, 'not_followed');
  assert.deepEqual(x.inbox.map((i) => [i.kind, i.severity]), [['directive_failed', 'action']]);
  // A filled quota is not failed at its deadline.
  x.add({ id: 'e2', kind: 'experiment', status: 'applied', change: { ...e1.change, slots: 1 } });
  assert.equal(await x.exec.closeQuotas(), 0);
});

// ── strategy (FR-015) ─────────────────────────────────────────────────────────

test('strategy: the build writes a pending version (directive stays accepted); activated → applied + verified; rejected → rejected/declined', async () => {
  const versions: any[] = [];
  const port = new PlaybookBuildPort();
  const builds: string[] = [];
  port.bind(async (_orch, brief, directiveId) => { builds.push(brief); versions.push({ id: 'pb9', version: 9, status: 'pending_owner', directiveId }); });
  const ex = strategyExecutor({ network: { playbookHistory: async () => [...versions].reverse() }, builder: port });
  assert.equal((ex.plan(dir('strategy', {}, { body: 'коротко' }), ctx()) as any).error, 'not_executable');
  const x = execOver([ex]);
  const s1 = x.add({ id: 's1', kind: 'strategy', body: 'Перебудуй плейбук під каруселі в Instagram' });
  await x.exec.executeAccepted(ORCH);
  assert.deepEqual([s1.status, s1.change.playbook_id, s1.change.version], ['accepted', 'pb9', 9]);
  assert.deepEqual(builds, ['Перебудуй плейбук під каруселі в Instagram']);
  await x.exec.execute(s1, ORCH);
  assert.equal(builds.length, 1, 'no second build while the version waits for the owner');

  versions[0].status = 'active';
  const r = await x.exec.onPlaybookDecided({ id: 'pb9', version: 9, status: 'active', directiveId: 's1' }, true);
  assert.equal(r?.status, 'applied');
  assert.ok(s1.change.activated_at);
  assert.equal(await x.exec.verifyApplied(), 1);
  assert.ok(s1.verifiedAt);

  const s2 = x.add({ id: 's2', kind: 'strategy', body: 'Перебудуй плейбук під короткі тексти' });
  versions.length = 0;
  await x.exec.execute(s2, ORCH);
  assert.equal(s2.status, 'accepted');
  await x.exec.onPlaybookDecided({ id: 'pb9', version: 9, status: 'rejected', directiveId: 's2' }, false);
  assert.deepEqual([s2.status, s2.ownerDecision], ['rejected', 'declined']);
  // Polling sees a rejected version too.
  const s3 = x.add({ id: 's3', kind: 'strategy', body: 'Ще одна стратегія для плейбука' });
  versions.length = 0;
  versions.push({ id: 'pb10', version: 10, status: 'rejected', directiveId: 's3' });
  await x.exec.execute(s3, ORCH);
  assert.deepEqual([s3.status, s3.ownerDecision], ['rejected', 'declined']);
});

// ── promo verification ───────────────────────────────────────────────────────

test('promo verifier: verified when the promo slot is published or shadowed; skipped → not followed; planned → pending', async () => {
  const slots: any[] = [];
  const pool = { query: async () => ({ rows: slots }) } as any;
  const v = promoVerifier(pool, 'cross_promo', () => CNOW);
  const d = { id: 'p1', appliedAt: new Date(CNOW.getTime() - 86_400_000) } as any;
  assert.equal((await v.verify(d) as any).pending, true, 'no slot yet');
  slots.push({ id: 's', status: 'planned' });
  assert.equal((await v.verify(d) as any).pending, true);
  slots[0].status = 'shadowed';
  assert.deepEqual(await v.verify(d).then((r: any) => [r.verified, r.adherence]), [true, 'followed']);
  slots[0].status = 'skipped';
  assert.deepEqual(await v.verify(d).then((r: any) => [r.verified, r.adherence]), [false, 'not_followed']);
  slots.length = 0;
  assert.deepEqual(await v.verify({ ...d, appliedAt: new Date(CNOW.getTime() - 10 * 86_400_000) }).then((r: any) => [r.verified, r.adherence]), [false, 'not_followed']);
});

// ── report_directive_done (task) ─────────────────────────────────────────────

test('report_directive_done: only for a task, the reference is checked, then applied and verified', async () => {
  const rows = new Map<string, any>([
    ['t1', { id: 't1', toAgentId: 'o1', kind: 'task', status: 'accepted', shadow: false, deliveredAt: new Date('2026-10-20T08:00:00Z'), createdAt: new Date('2026-10-20T07:00:00Z') }],
    ['f1', { id: 'f1', toAgentId: 'o1', kind: 'format_shift', status: 'new', shadow: false }],
  ]);
  const reported: any[] = [];
  const refs: any[] = [];
  const tools = buildDirectiveTools({
    repo: {
      get: async (id: string) => rows.get(id) ?? null,
      reportDone: async (id: string, v: any) => { reported.push([id, v]); return { ...rows.get(id), status: 'applied' }; },
    } as any,
    agents: {} as any, digest: {} as any, inbox: { post: async () => 1 }, memory: { listActive: async () => [] } as any, actions: {} as any,
    channelKeyOf: async () => '@space',
    taskRef: async (type, id, _orch, since) => {
      refs.push([type, id, since.toISOString()]);
      return id === D2 ? { error: 'ref_too_old', details: 'створено раніше' } : { ok: true, at: new Date('2026-10-20T09:00:00Z') };
    },
    now: () => CNOW,
  });
  const call = (input: any) => tools.find((t) => t.name === 'report_directive_done')!.execute(input, { runId: 'r', role: 'orchestrator', channelKey: '@space', extras: { orchestrator: ORCH } }) as Promise<any>;
  assert.equal((await call({ id: 'f1', ref_type: 'idea', ref_id: D1 })).error, 'not_a_task');
  assert.equal((await call({ id: 't1', ref_type: 'idea', ref_id: D2 })).error, 'ref_too_old');
  assert.equal(reported.length, 0);
  const ok = await call({ id: 't1', ref_type: 'slot', ref_id: D1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(refs.at(-1), ['slot', D1, '2026-10-20T08:00:00.000Z'], 'checked against delivered_at');
  assert.deepEqual([reported[0][0], reported[0][1].kind, reported[0][1].ref_type, reported[0][1].adherence], ['t1', 'reported', 'slot', 'followed']);
});

test('the change of a T5 kind is described for the owner card (dry-run)', async () => {
  const { describe } = await import('./executors/playbook-executors');
  const exp: ExperimentChange = { kind: 'experiment', op: 'experiment', target: 'quota', channel_key: '@space', resource_ref: IG, angle: 'Питання до аудиторії', format: null, slots: 2, within_days: 3, deadline: CNOW.toISOString(), structural: false, reasons: [] };
  assert.match(describe(exp), /instagram:ig1: experiment "Питання до аудиторії" — 2 slot\(s\) within 3 day\(s\)/);
  const st: StrategyChange = { kind: 'strategy', op: 'playbook_build', target: 'owner', channel_key: '@space', brief: 'b', structural: true, reasons: [] };
  assert.match(describe(st), /playbook rebuild/);
});
