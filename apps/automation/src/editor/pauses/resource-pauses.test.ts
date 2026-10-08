/**
 * Spec 025 T4 (FR-013) without a database: the pause_resource executor (plan / apply / verify, idempotent
 * re-apply), and every guard — networkContext, the scheduler (held channel, skipped slots, auto-lift),
 * ReservedDispatcher (promo skipped, ads untouched), PromoExecutor write-ahead, PromoPlanner, ApprovalPublisher,
 * the mirrors — plus the REST API's validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { pauseResourceExecutor, DirectiveExecution, PENDING_EXECUTOR_KINDS, type ExecContext } from '../manager/executors';
import { networkContext } from '../network/network-context';
import { EditorScheduler } from '../editor.scheduler';
import { ReservedDispatcher } from '../publish/reserved-dispatcher';
import { EditorCrossPoster } from '../publish/editor-crosspost';
import { PromoExecutor } from '../promo/promo-executor';
import { PromoPlanner } from '../promo/promo-planner';
import { ApprovalPublisher } from '../approval/approval-publisher';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { channelHeldBy, isActivePause, slotRef, type ResourcePause } from './resource-pauses';
import { ResourcePausesApi } from './resource-pauses.controller';

const TG = 'telegram:@space';
const IG = 'instagram:42';
const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live', scope: 'resource', scopeId: TG } as any;
const NOW = new Date('2026-10-20T09:00:00Z');
const DAY = 86_400_000;

function ctx(o: { pauses?: Array<{ ref: string; until: Date }>; resources?: any[] } = {}): ExecContext {
  return {
    orch: ORCH, card: makeCard({ channelKey: '@space' }), playbook: null, mode: 'live', now: NOW, pauses: o.pauses,
    net: {
      orchestrator: ORCH, anchorKey: '@space', groupId: 'g', groupName: 'Space', mode: 'independent', playbook: null, playbookVersion: null,
      resources: o.resources ?? [{ ref: TG, platform: 'telegram' }, { ref: IG, platform: 'instagram' }], telegramFormats: ['text'],
    },
  };
}

const pauseRow = (o: Partial<ResourcePause> = {}): ResourcePause => ({
  id: 1, resourceRef: IG, agentId: 'o1', directiveId: 'd1', reason: 'reason text', startsAt: NOW, until: new Date(NOW.getTime() + 7 * DAY),
  liftedAt: null, liftedBy: null, createdAt: NOW, ...o,
});

/** In-memory pauses with the service's semantics (idempotent per directive, one active per resource). */
function fakePauses() {
  const rows: ResourcePause[] = [];
  let published = 0;
  return {
    rows,
    setPublished: (n: number) => { published = n; },
    pause: async (i: any) => {
      const mine = rows.find((r) => r.directiveId === i.directiveId);
      if (mine) return { pause: mine, created: false };
      const other = rows.find((r) => r.resourceRef === i.resourceRef && !r.liftedAt);
      if (other) return { error: 'already_paused' as const, pause: other };
      const p = pauseRow({ id: rows.length + 1, resourceRef: i.resourceRef, directiveId: i.directiveId, reason: i.reason, until: i.until, agentId: i.agentId });
      rows.push(p);
      return { pause: p, created: true };
    },
    byDirective: async (id: string) => rows.find((r) => r.directiveId === id) ?? null,
    publishedIn: async () => published,
  };
}

// ── executor ────────────────────────────────────────────────────────────────

test('pause_resource plan: refuses bad params, a resource outside the network and one already paused', () => {
  const ex = pauseResourceExecutor({ pauses: fakePauses() as any, now: () => NOW });
  const plan = (params: Record<string, unknown>, c = ctx()) => ex.plan({ kind: 'pause_resource', params, toAgentId: 'o1' }, c) as any;
  assert.match(plan({ days: 3, reason: 'Охоплення впали' }).details, /resource_ref/);
  assert.match(plan({ resource_ref: 'tiktok:9', reason: 'Охоплення впали' }).details, /не в мережі/);
  assert.match(plan({ resource_ref: IG, days: 0, reason: 'Охоплення впали' }).details, /days/);
  assert.match(plan({ resource_ref: IG, days: 15, reason: 'Охоплення впали' }).details, /days/);
  assert.match(plan({ resource_ref: IG, days: 2.5, reason: 'Охоплення впали' }).details, /days/);
  assert.match(plan({ resource_ref: IG }).details, /reason/);
  const busy = plan({ resource_ref: IG, reason: 'Охоплення впали' }, ctx({ pauses: [{ ref: IG, until: new Date('2026-10-25T10:00:00Z') }] }));
  assert.equal(busy.error, 'not_executable');
  assert.match(busy.details, /уже на паузі до 2026-10-25 12:00/);
});

test('pause_resource plan: default 7 days, always structural, until from now', () => {
  const ex = pauseResourceExecutor({ pauses: fakePauses() as any, now: () => NOW });
  const c = ex.plan({ kind: 'pause_resource', params: { resource_ref: IG, reason: 'Охоплення впали втричі' }, toAgentId: 'o1' }, ctx()) as any;
  assert.equal(c.op, 'pause_resource');
  assert.equal(c.target, 'resource');
  assert.equal(c.structural, true);
  assert.equal(c.days, 7);
  assert.equal(c.until, new Date(NOW.getTime() + 7 * DAY).toISOString());
  const two = ex.plan({ kind: 'pause_resource', params: { resource_ref: TG, days: 2, reason: 'Ребрендинг каналу' }, toAgentId: 'o1' }, ctx()) as any;
  assert.equal(two.until, new Date(NOW.getTime() + 2 * DAY).toISOString());
});

test('pause_resource apply: one row per directive (re-apply is a no-op); another pause on the resource fails the attempt', async () => {
  const pauses = fakePauses();
  const ex = pauseResourceExecutor({ pauses: pauses as any, now: () => NOW });
  const change = ex.plan({ kind: 'pause_resource', params: { resource_ref: IG, days: 3, reason: 'Охоплення впали' }, toAgentId: 'o1' }, ctx()) as any;
  assert.deepEqual(await ex.apply(change, { id: 'd1', toAgentId: 'o1', kind: 'pause_resource' }), { noop: false });
  assert.deepEqual(await ex.apply(change, { id: 'd1', toAgentId: 'o1', kind: 'pause_resource' }), { noop: true });
  assert.equal(pauses.rows.length, 1);
  assert.equal(pauses.rows[0].until.toISOString(), change.until);
  await assert.rejects(ex.apply(change, { id: 'd2', toAgentId: 'o1', kind: 'pause_resource' }), /already paused/);
  const late = pauseResourceExecutor({ pauses: pauses as any, now: () => new Date(NOW.getTime() + 4 * DAY) });
  await assert.rejects(late.apply({ ...change, resource_ref: TG }, { id: 'd3', toAgentId: 'o1', kind: 'pause_resource' }), /has passed/);
});

test('pause_resource verify: pending while active, violated at once, followed after the window', async () => {
  const pauses = fakePauses();
  let now = new Date(NOW.getTime() + DAY);
  const ex = pauseResourceExecutor({ pauses: pauses as any, now: () => now });
  const change = { op: 'pause_resource', resource_ref: IG, days: 3, until: new Date(NOW.getTime() + 3 * DAY).toISOString(), reason: 'r' };
  const dir = { id: 'd1', kind: 'pause_resource', change } as any;
  assert.equal(((await ex.verify(dir)) as any).detail.reason, 'no pause row');
  pauses.rows.push(pauseRow({ until: new Date(change.until) }));
  assert.equal((await ex.verify(dir)).pending, true);
  pauses.setPublished(1);
  assert.deepEqual([(await ex.verify(dir) as any).verified, (await ex.verify(dir) as any).adherence], [false, 'violated']);
  pauses.setPublished(0);
  now = new Date(NOW.getTime() + 4 * DAY);
  const r: any = await ex.verify(dir);
  assert.deepEqual([r.verified, r.adherence, r.detail.to], [true, 'followed', change.until]);
  // An owner lift closes the window early.
  pauses.rows[0].liftedAt = new Date(NOW.getTime() + DAY);
  pauses.rows[0].liftedBy = 'owner';
  assert.equal(((await ex.verify(dir)) as any).detail.to, pauses.rows[0].liftedAt.toISOString());
});

test('execution: pause_resource is no longer a pending kind — an accepted one runs its executor', async () => {
  assert.ok(!PENDING_EXECUTOR_KINDS.includes('pause_resource'));
  const pauses = fakePauses();
  const row: any = { id: 'd9', kind: 'pause_resource', status: 'accepted', binding: 'directive', change: null, execAttempts: 0, toAgentId: 'o1', params: { resource_ref: IG, days: 2, reason: 'Охоплення впали' } };
  const exec = new DirectiveExecution({
    repo: {
      acceptedForExecution: async () => (row.status === 'accepted' ? [row] : []),
      setChange: async (_id: string, c: any) => { row.change = c; },
      markApplied: async (_id: string, p: any) => { Object.assign(row, { status: 'applied', ...(p.change ? { change: p.change } : {}) }); return row; },
    } as any,
    inbox: { post: async () => 1 }, agents: { get: async () => ORCH } as any,
    context: async () => ctx(), executors: [pauseResourceExecutor({ pauses: pauses as any, now: () => NOW })], now: () => NOW,
  });
  await exec.executeAccepted(ORCH);
  assert.equal(row.status, 'applied');
  assert.equal(row.change.op, 'pause_resource');
  assert.equal(row.change.noop, false);
  assert.equal(row.verification, undefined, 'not marked unverified');
  assert.equal(pauses.rows[0].directiveId, 'd9');
});

// ── networkContext ──────────────────────────────────────────────────────────

test('networkContext: a paused resource is left out and a paused Telegram anchor is not added back', async () => {
  const repo = {
    groupOfChannel: async () => ({ id: 'g1', name: 'Космос', mode: 'independent' as const }),
    groupResources: async () => [{ ref: TG, platform: 'telegram', title: null }, { ref: IG, platform: 'instagram', title: null }],
    activePlaybook: async () => null,
  };
  const card = makeCard({ channelKey: '@space' });
  const refs = async (paused: string[]) => (await networkContext({ repo, paused: async (r) => paused.includes(r) }, ORCH, card))!.resources.map((r) => r.ref);
  assert.deepEqual(await refs([]), [TG, IG]);
  assert.deepEqual(await refs([IG]), [TG]);
  assert.deepEqual(await refs([TG]), [IG]);
  const single = { groupOfChannel: async () => null, groupResources: async () => [], activePlaybook: async () => null };
  assert.deepEqual((await networkContext({ repo: single, paused: async (r) => r === TG }, ORCH, card))!.resources, []);
  assert.deepEqual((await networkContext({ repo: single }, ORCH, card))!.resources.map((r) => r.ref), [TG]);
});

test('channelHeldBy: single and legacy channels are held when Telegram is paused; an independent network only when all are', async () => {
  const net = (mode: string | null) => ({
    groupOfChannel: async () => (mode ? { id: 'g', name: 'n', mode: mode as any } : null),
    groupResources: async () => [{ ref: TG, platform: 'telegram', title: null }, { ref: IG, platform: 'instagram', title: null }],
  });
  const card = { channelKey: '@space' };
  assert.equal(await channelHeldBy(net(null))(card, new Set([IG])), false);
  assert.equal(await channelHeldBy(net(null))(card, new Set([TG])), true);
  assert.equal(await channelHeldBy(net('legacy_duplicate'))(card, new Set([TG])), true);
  assert.equal(await channelHeldBy(net('independent'))(card, new Set([TG])), false);
  assert.equal(await channelHeldBy(net('independent'))(card, new Set([TG, IG])), true);
});

test('isActivePause / slotRef', () => {
  assert.equal(isActivePause(pauseRow(), NOW), true);
  assert.equal(isActivePause(pauseRow({ until: NOW }), NOW), false, 'ends at until');
  assert.equal(isActivePause(pauseRow({ liftedAt: NOW }), NOW), false);
  assert.equal(isActivePause(pauseRow({ startsAt: new Date(NOW.getTime() + 1) }), NOW), false);
  assert.equal(slotRef({ channelKey: '@space', resourceRef: null }), TG);
  assert.equal(slotRef({ channelKey: '@space', resourceRef: IG }), IG);
});

// ── scheduler ───────────────────────────────────────────────────────────────

function sched(o: { paused: string[]; held?: boolean; due?: any[] }) {
  const calls: string[] = [];
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [{ ...makeCard({ channelKey: '@space', planHour: 0 }), createdAt: new Date('2026-01-01') }] },
    plans: {
      getActivePlan: async () => null, claimDue: async () => o.due ?? [], skipStale: async () => 0, sweepStuck: async () => [],
      consecutiveFailures: async () => 0, updateSlot: async (id: string, p: any) => { calls.push(`update:${id}:${p.status}:${p.error}`); },
    },
    runner: {
      runPlanner: async () => { calls.push('plan'); return {} as any; },
      runExecutor: async (slot: any) => { calls.push(`exec:${slot.id}`); return {} as any; },
      runReviewer: async () => ({}) as any,
    },
    orchestrate: async () => { calls.push('orchestrate'); },
    enabled: () => true, notify: async () => {},
    pauses: {
      liftDue: async () => { calls.push('liftDue'); },
      pausedRefs: async () => new Set(o.paused),
      held: async () => o.held ?? false,
    },
  });
  return { s, calls };
}

test('scheduler: a held channel is neither orchestrated nor planned; claimed slots on a paused resource are skipped', async () => {
  const due = [{ id: 'tg', channelKey: '@space', resourceRef: null }, { id: 'ig', channelKey: '@space', resourceRef: IG }];
  const a = sched({ paused: [TG], held: true, due });
  await a.s.tick(NOW);
  assert.equal(a.calls[0], 'liftDue');
  assert.ok(!a.calls.includes('orchestrate') && !a.calls.includes('plan'));
  assert.deepEqual(a.calls.filter((c) => c.startsWith('update:') || c.startsWith('exec:')), ['update:tg:skipped:resource_paused', 'exec:ig']);

  const b = sched({ paused: [IG], held: false, due });
  await b.s.tick(NOW);
  assert.ok(b.calls.includes('orchestrate') && b.calls.includes('plan'));
  assert.deepEqual(b.calls.filter((c) => c.startsWith('update:') || c.startsWith('exec:')), ['update:ig:skipped:resource_paused', 'exec:tg']);
});

test('scheduler (approval mode): a write-ahead slot on a paused resource is skipped, never written for the owner', async () => {
  const calls: string[] = [];
  const slot = { id: 'ahead', channelKey: '@space', resourceRef: null, scheduledAt: new Date(NOW.getTime() + 3600_000), format: 'text', topic: 't', sourceHints: [] };
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [{ ...makeCard({ channelKey: '@space', planHour: 0, mode: 'approve' }), createdAt: new Date('2026-01-01') }] },
    plans: {
      getActivePlan: async () => ({ id: 'p', rationale: null }) as any, claimDue: async () => [], skipStale: async () => 0, sweepStuck: async () => [],
      consecutiveFailures: async () => 0, plannedBefore: async () => [slot] as any, claimSlot: async () => slot as any,
      updateSlot: async (id: string, p: any) => { calls.push(`update:${id}:${p.status}:${p.error}`); },
    },
    runner: { runPlanner: async () => ({}) as any, runExecutor: async (x: any) => { calls.push(`exec:${x.id}`); return {} as any; }, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {},
    approval: { mode: async () => 'approve', tick: async () => {} },
    pauses: { liftDue: async () => {}, pausedRefs: async () => new Set([TG]), held: async () => true },
  });
  await s.tick(NOW);
  assert.deepEqual(calls, ['update:ahead:skipped:resource_paused']);
});

test('scheduler: a failing pause lookup does not stop the tick', async () => {
  const calls: string[] = [];
  const s = new EditorScheduler({
    pool: { query: async () => ({ rows: [] }) } as any,
    channels: { listActive: async () => [{ ...makeCard({ channelKey: '@space', planHour: 0 }), createdAt: new Date('2026-01-01') }] },
    plans: { getActivePlan: async () => null, claimDue: async () => [{ id: 'x', channelKey: '@space' }] as any, skipStale: async () => 0, sweepStuck: async () => [], consecutiveFailures: async () => 0 },
    runner: { runPlanner: async () => { calls.push('plan'); return {} as any; }, runExecutor: async () => { calls.push('exec'); return {} as any; }, runReviewer: async () => ({}) as any },
    enabled: () => true, notify: async () => {}, log: (m) => calls.push(m),
    pauses: { liftDue: async () => { throw new Error('db down'); }, pausedRefs: async () => new Set(), held: async () => true },
  });
  await s.tick(NOW);
  assert.ok(calls.includes('plan') && calls.includes('exec'));
  assert.ok(calls.some((c) => /resource pauses failed: db down/.test(c)));
});

// ── reserved lane, promo, approval, mirrors ─────────────────────────────────

const reserved = (id: string, o: any = {}) => ({
  id, planId: 'p', channelKey: '@space', scheduledAt: NOW, kind: 'reserved', format: 'text', topic: 't', angle: null, sourceHints: [],
  isExperiment: false, status: 'running', attempts: 1, runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...o,
}) as any;

test('ReservedDispatcher: a promo slot on a paused resource is skipped; paid ads and other promos still go out', async () => {
  const calls: string[] = [];
  const d = new ReservedDispatcher({
    plans: { claimDueReserved: async () => [reserved('ad'), reserved('promo-tg', { promo: { kind: 'cross_promo' } }), reserved('promo-ig', { promo: { kind: 'cross_promo' }, resourceRef: IG })],
      updateSlot: async (id: string, p: any) => { calls.push(`update:${id}:${p.status}:${p.error}`); } },
    orders: { findBySlot: async (id) => (id === 'ad' ? { id: 'o1' } as any : null) },
    sponsored: { publishClaimed: async (s) => { calls.push(`ad:${s.id}`); return true; } },
    manual: { publishScheduled: async (s) => { calls.push(`chat:${s.id}`); return true; } },
    promo: { publishPromo: async (s) => { calls.push(`promo:${s.id}`); return true; } },
    paused: async (ref) => ref === TG,
  });
  assert.equal(await d.publishDue(NOW), 2);
  assert.deepEqual(calls, ['ad:ad', 'update:promo-tg:skipped:resource_paused', 'promo:promo-ig']);
});

test('PromoExecutor.writeAhead: promo slots of a paused resource are not written ahead', async () => {
  const claimed: string[] = [];
  const pe = new PromoExecutor({
    plans: {
      updateSlot: async () => {}, getSlot: async () => null,
      plannedPromoBefore: async () => [reserved('a', { status: 'planned', promo: { kind: 'repost', post_ref: 'telegram:@x/1' } }), reserved('b', { status: 'planned', resourceRef: IG, promo: { kind: 'repost', post_ref: 'telegram:@x/1' } })],
      claimPromoSlot: async (id: string) => { claimed.push(id); return null; },
    },
    card: async () => makeCard({ channelKey: '@space' }), catalog: { list: async () => [] }, profiles: { get: async () => null },
    runExecutor: async () => ({}) as any, mode: async () => 'approve', cards: async () => [makeCard({ channelKey: '@space', mode: 'approve' })],
    paused: async (ref) => ref === TG,
  });
  await pe.writeAhead(new Date(NOW.getTime() + 12 * 3600_000));
  assert.deepEqual(claimed, ['b']);
});

test('PromoPlanner: a promo from or to a paused resource is refused with resource_paused (the directive is rejected)', async () => {
  const updates: any[] = [];
  const catalog = [
    { ref: TG, platform: 'telegram', groupId: 'g', title: 'Space', username: 'space' },
    { ref: 'telegram:@astro', platform: 'telegram', groupId: 'g', title: 'Astro', username: 'astro' },
  ];
  const planner = (paused: string[]) => new PromoPlanner({
    pool: { query: async () => { throw new Error('the guard runs before any query'); } } as any,
    plans: { reserveSlot: async () => 's' } as any, catalog: { list: async () => catalog as any }, profiles: { get: async () => null },
    links: {} as any, directives: { update: async (id: string, p: any) => { updates.push([id, p]); return null as any; } },
    card: async () => makeCard({ channelKey: '@space' }), usable: async () => true, paused: async (r) => paused.includes(r), now: () => NOW,
  });
  const dir = { id: 'd1', kind: 'cross_promo', shadow: false, params: { source_ref: TG, target_ref: 'telegram:@astro' } } as any;
  const a: any = await planner([TG]).schedule(dir, ORCH, '@space');
  assert.equal(a.error, 'resource_paused');
  assert.match(a.details, /telegram:@space на паузі/);
  const b: any = await planner(['telegram:@astro']).schedule(dir, ORCH, '@space');
  assert.equal(b.error, 'resource_paused');
  assert.equal(updates[0][1].status, 'rejected');
  assert.match(updates[0][1].resolution, /^resource_paused:/);
});

test('ApprovalPublisher: an approved post on a paused resource is skipped (resource_paused), its platform post canceled', async () => {
  const updates: any[] = [];
  const canceled: any[] = [];
  const pub = new ApprovalPublisher({
    repo: {
      claimApprovedDue: async () => [{ id: 'r1', channelKey: '@space', resourceRef: IG, approvedAt: NOW, status: 'running', platformPostId: 5, renderMessages: { kind: 'platform' } } as any],
      publishedSource: async () => false, publishedTexts: async () => [], cancelPlatformPosts: async (ids: number[], reason: string) => { canceled.push([ids, reason]); },
    },
    plans: { updateSlot: async (id: string, p: any) => { updates.push([id, p]); }, countPublishedSince: async () => 0 },
    card: async () => makeCard({ channelKey: '@space', mode: 'approve' }), mode: async () => 'approve',
    telegram: {} as any, platform: {} as any, paused: async (ref) => ref === IG,
  });
  assert.deepEqual(await pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
  assert.deepEqual(updates[0], ['r1', { status: 'skipped', error: 'resource_paused' }]);
  assert.deepEqual(canceled, [[[5], 'resource_paused']]);
});

test('EditorCrossPoster: a paused mirror platform gets no copy; the others still do', async () => {
  const seen: Record<string, unknown> = {};
  const poster = new EditorCrossPoster({
    crossPost: { afterPublish: async (input) => { seen.ig = input.render!('instagram', null); seen.th = input.render!('threads', null); return []; } },
    groupFanOut: { fanOut: async (_s, content) => { seen.fb = content.render!('facebook'); return []; } },
    postLink: () => null,
    pausedPlatforms: async () => new Set(['instagram', 'facebook']),
  });
  await poster.fanOut({ channelKey: '@space', messageId: 1, spec: makeSpec(), card: makeCard(), prepared: {} });
  assert.equal(seen.ig, null);
  assert.equal(seen.fb, null);
  assert.ok(seen.th);
});

// ── REST ────────────────────────────────────────────────────────────────────

test('ResourcePausesApi: filters, lift (400 invalid ref, 409 not paused) and the view', async () => {
  const lifted: string[] = [];
  const api = new ResourcePausesApi({
    list: async (o: any) => (o.active === false ? [] : [pauseRow({ agentHandle: 'kira' })]),
    lift: async (ref: string, by: string) => { lifted.push(`${ref}:${by}`); return ref === IG ? pauseRow({ liftedAt: NOW, liftedBy: 'owner' }) : null; },
  } as any, () => NOW);
  const all = await api.list({});
  assert.deepEqual([all.pauses[0].resourceRef, all.pauses[0].agentHandle, all.pauses[0].active], [IG, 'kira', true]);
  assert.deepEqual((await api.list({ active: 'false' })).pauses, []);
  await assert.rejects(api.list({ active: 'yes' }), BadRequestException);
  await assert.rejects(api.list({ limit: '0' }), BadRequestException);
  await assert.rejects(api.lift('nope'), BadRequestException);
  await assert.rejects(api.lift(TG), ConflictException);
  const r = await api.lift(IG);
  assert.deepEqual([r.pause.active, r.pause.liftedBy], [false, 'owner']);
  assert.deepEqual(lifted, [`${TG}:owner`, `${IG}:owner`]);
});
