/**
 * Spec 025 T4 (FR-013) on a throwaway Postgres with every migration applied: an accepted pause_resource
 * directive pauses the resource (resource_pauses row, Inbox `resource_paused`, idempotent re-apply); while it
 * is active networkContext leaves it out, the scheduler holds the channel and skips its content slots, the
 * promo planner and the reserved lane refuse promos — and the paid ad slot still publishes; the owner lifts
 * it early through the REST API, or it lifts itself at `until` and the channel is planned again; verify()
 * reports the window. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ConflictException } from '@nestjs/common';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { NetworkRepository } from '../network/network.repository';
import { networkContext } from '../network/network-context';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository, RESERVED_ONLY_RATIONALE, type EditorSlot } from '../repo/editor-plans.repository';
import { EditorScheduler } from '../editor.scheduler';
import { ReservedDispatcher } from '../publish/reserved-dispatcher';
import { PromoPlanner } from '../promo/promo-planner';
import { DirectivesRepository } from '../manager/directives.repository';
import { DirectiveExecution, executionContextOf, pauseResourceExecutor } from '../manager/executors';
import { channelHeldBy, ResourcePauseService } from './resource-pauses';
import { ResourcePausesApi } from './resource-pauses.controller';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt025t4_space';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt025t4_orch';
const GROUP = 'pgt025t4 group';
const DAY = 86_400_000;
let pool: Pool;
let orchId: string;
let groupId: string;
let IG: string;

async function cleanup() {
  await pool.query(`DELETE FROM resource_pauses WHERE resource_ref = $1 OR resource_ref IN (SELECT 'instagram:' || id FROM meta_accounts WHERE account_id = 'pgt025t4-ig')`, [TG]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1) OR title LIKE '%pgt025t4%'`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM promo_pairs WHERE source_ref = $1 OR target_ref = $1`, [TG]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key IN ($1, '@pgt025t4_astro')`, [CH]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id = 'pgt025t4-ig'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name = $1`, [GROUP]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'independent') RETURNING id`, [GROUP])).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'pgt025t4_space', 'Космос', true, $2)`, [CH, groupId]);
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ('@pgt025t4_astro', 'pgt025t4_astro', 'Астро', true)`);
  IG = `instagram:${(await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at) VALUES ('instagram', 'pgt025t4-ig', 'X', 't', 'pgt025t4_ig', $1, now()) RETURNING id`,
    [groupId])).rows[0].id}`;
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: TG, name: 'Kira', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, plan_hour, formats) VALUES ($1, 'live', 0, '{"text":1}')`, [CH]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const inboxKinds = async () => (await pool.query(
  `SELECT kind, ref_type, ref_id FROM agent_inbox WHERE agent_id = $1 ORDER BY id`, [orchId])).rows as Array<{ kind: string; ref_type: string; ref_id: string }>;
const slotStatus = async (id: string) => (await pool.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [id])).rows[0];

async function plan(date: Date): Promise<string> {
  const day = date.toISOString().slice(0, 10);
  const found = await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [CH, day]);
  if (found.rows[0]) return found.rows[0].id;
  // A placeholder plan: the scheduler still plans the day (like a day with only reserved slots).
  return (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3) RETURNING id`, [CH, day, RESERVED_ONLY_RATIONALE])).rows[0].id;
}

async function slot(o: { at: Date; kind?: 'content' | 'reserved'; ref?: string | null; promo?: Record<string, unknown> | null }): Promise<string> {
  const planId = await plan(o.at);
  return (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, resource_ref, promo) VALUES ($1, $2, $3, $4, 'text', 'pgt025t4', $5, $6) RETURNING id`,
    [planId, CH, o.at, o.kind ?? 'content', o.ref ?? null, o.promo ? JSON.stringify(o.promo) : null])).rows[0].id;
}

function setup(now?: () => Date) {
  const inbox = new OwnerInbox(pool as any, async () => {});
  const pauses = new ResourcePauseService({ pool, inbox, now });
  const network = new NetworkRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const repo = new DirectivesRepository(pool);
  const exec = new DirectiveExecution({
    repo, inbox, agents: new AgentsRepository(pool),
    context: executionContextOf({ repo: network, channels, pauses }),
    executors: [pauseResourceExecutor({ pauses, now })], now,
  });
  return { inbox, pauses, network, channels, plans, repo, exec, api: new ResourcePausesApi(pauses, now) };
}

/** Claims scoped to this test's channel (a shared test database may hold other suites' rows). */
function scopedPlans(plans: EditorPlansRepository) {
  const mine = <T extends EditorSlot>(xs: T[]) => xs.filter((s) => s.channelKey === CH);
  return Object.assign(Object.create(plans), {
    claimDue: async (now: Date) => {
      const { rows } = await pool.query(
        `SELECT id FROM editor_slots WHERE channel_key = $1 AND status = 'planned' AND kind = 'content' AND scheduled_at <= $2 ORDER BY scheduled_at`, [CH, now]);
      const out: EditorSlot[] = [];
      for (const r of rows) { const s = await plans.claimSlot(r.id); if (s) out.push(s); }
      return mine(out);
    },
    claimDueReserved: async (now: Date) => {
      const { rows } = await pool.query(
        `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
          WHERE channel_key = $1 AND status = 'planned' AND kind = 'reserved' AND scheduled_at <= $2 RETURNING id`, [CH, now]);
      return Promise.all(rows.map(async (r) => (await plans.getSlot(r.id))!));
    },
    skipStale: async () => 0,
    sweepStuck: async () => [],
  }) as EditorPlansRepository;
}

function scheduler(s: ReturnType<typeof setup>, calls: string[]) {
  const held = channelHeldBy(s.network);
  return new EditorScheduler({
    pool, plans: scopedPlans(s.plans),
    channels: { listActive: async () => [(await s.channels.get(CH))!] },
    runner: {
      runPlanner: async (c) => { calls.push(`plan:${c.channelKey}`); return {} as any; },
      runExecutor: async (x) => { calls.push(`exec:${x.id}`); await s.plans.updateSlot(x.id, { status: 'published' }); return {} as any; },
      runReviewer: async () => ({}) as any,
    },
    orchestrate: async (c) => { calls.push(`orchestrate:${c.channelKey}`); },
    enabled: () => true, notify: async () => {},
    pauses: { liftDue: (n) => s.pauses.liftDue(n), pausedRefs: (n) => s.pauses.pausedRefs(n), held },
  });
}

async function setGroupMode(mode: 'independent' | 'legacy_duplicate') {
  await pool.query(`UPDATE meta_account_groups SET mode = $2 WHERE id = $1`, [groupId, mode]);
}

test('ResourcePauseService: one active pause per resource, idempotent per directive, owner lift, auto-lift, listing, Inbox', { skip }, async () => {
  const s = setup();
  const now = new Date();
  const a = await s.pauses.pause({ resourceRef: IG, agentId: orchId, directiveId: null, reason: 'pgt025t4 test pause', until: new Date(now.getTime() + DAY) });
  assert.ok('created' in a && a.created);
  const b = await s.pauses.pause({ resourceRef: IG, agentId: orchId, directiveId: null, reason: 'second', until: new Date(now.getTime() + DAY) });
  assert.ok('error' in b && b.error === 'already_paused');
  assert.equal(await s.pauses.isPaused(IG), true);
  assert.deepEqual([...(await s.pauses.pausedRefs())], [IG]);
  assert.deepEqual([...(await s.pauses.pausedMirrorPlatforms(CH))], ['instagram'], 'the group member is a paused mirror');
  assert.equal((await s.api.list({ active: 'true' })).pauses.some((p) => p.resourceRef === IG && p.agentHandle === HANDLE && p.active), true);

  await assert.rejects(s.api.lift(TG), ConflictException);
  const lifted = await s.api.lift(IG);
  assert.deepEqual([lifted.pause.liftedBy, lifted.pause.active], ['owner', false]);
  assert.equal(await s.pauses.isPaused(IG), false);
  await assert.rejects(s.api.lift(IG), ConflictException);
  assert.equal((await s.api.list({ active: 'false' })).pauses.some((p) => p.id === lifted.pause.id), true);

  // A pause that ran out: inactive at once, stamped `schedule` by liftDue (once), and a new pause can follow.
  const c = await s.pauses.pause({ resourceRef: IG, agentId: orchId, directiveId: null, reason: 'pgt025t4 short', until: new Date(now.getTime() + 1000), startsAt: new Date(now.getTime() - DAY) });
  assert.ok('created' in c);
  const later = new Date(now.getTime() + 2000);
  assert.equal(await s.pauses.isPaused(IG, later), false);
  const due = await s.pauses.liftDue(later);
  assert.deepEqual(due.map((p) => [p.resourceRef, p.liftedBy, p.liftedAt?.getTime()]), [[IG, 'schedule', c.pause.until.getTime()]]);
  assert.deepEqual(await s.pauses.liftDue(later), []);
  assert.deepEqual((await inboxKinds()).map((x) => [x.kind, x.ref_type]), [
    ['resource_paused', 'resource'], ['resource_resumed', 'resource'], ['resource_paused', 'resource'], ['resource_resumed', 'resource'],
  ]);
  await pool.query(`DELETE FROM resource_pauses WHERE resource_ref = $1`, [IG]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id = $1`, [orchId]);
});

test('networkContext (PG): a paused Instagram is left out; a paused Telegram anchor is not added back', { skip }, async () => {
  const s = setup();
  const orch = (await new AgentsRepository(pool).get(orchId))!;
  const card = (await s.channels.get(CH))!;
  const refs = async () => (await networkContext({ repo: s.network, paused: (r) => s.pauses.isPaused(r) }, orch, card))!.resources.map((r) => r.ref).sort();
  assert.deepEqual(await refs(), [IG, TG].sort());
  await s.pauses.pause({ resourceRef: IG, agentId: orchId, directiveId: null, reason: 'pgt025t4 ig', until: new Date(Date.now() + DAY) });
  await s.pauses.pause({ resourceRef: TG, agentId: orchId, directiveId: null, reason: 'pgt025t4 tg', until: new Date(Date.now() + DAY) });
  assert.deepEqual(await refs(), []);
  await s.pauses.lift(TG);
  assert.deepEqual(await refs(), [TG]);
  await pool.query(`DELETE FROM resource_pauses WHERE agent_id = $1`, [orchId]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id = $1`, [orchId]);
});

test('pause_resource end to end: accepted → paused; slots skipped, promos refused, the paid ad still publishes; owner lift; verified', { skip }, async () => {
  const s = setup();
  const orch = (await new AgentsRepository(pool).get(orchId))!;
  await setGroupMode('legacy_duplicate');

  // Filing-time dry-run is executable; the accepted directive is executed by DirectiveExecution.
  const dir = await s.repo.insert({
    fromAgentId: null, toAgentId: orchId, kind: 'pause_resource', binding: 'directive', structural: true,
    body: 'Пауза Telegram на 2 дні: ребрендинг', params: { resource_ref: TG, days: 2, reason: 'Ребрендинг каналу, нове оформлення' },
    rationale: 'pgt025t4', evidence: null, expected: null, reviewAt: null, status: 'new', shadow: false,
  });
  const dry: any = await s.exec.dryRun(dir, orch);
  assert.equal(dry.op, 'pause_resource');
  await s.repo.update(dir.id, { status: 'accepted' });
  const [applied] = await s.exec.executeAccepted(orch);
  assert.equal(applied.status, 'applied');
  assert.deepEqual([applied.change.op, applied.change.resource_ref, applied.change.days, applied.change.noop], ['pause_resource', TG, 2, false]);
  const row = (await s.pauses.byDirective(dir.id))!;
  assert.equal(row.resourceRef, TG);
  assert.equal(Math.round((row.until.getTime() - row.startsAt.getTime()) / DAY), 2);
  assert.deepEqual((await inboxKinds()).map((x) => [x.kind, x.ref_type, x.ref_id]), [['resource_paused', 'directive', dir.id]]);

  // Re-applying the stored change is a no-op; a second pause directive on the same resource is not executable.
  const exec2 = await pauseResourceExecutor({ pauses: s.pauses }).apply(applied.change, applied);
  assert.deepEqual(exec2, { noop: true });
  const again: any = await s.exec.dryRun({ kind: 'pause_resource', params: { resource_ref: TG, days: 3, reason: 'Ще одна пауза' }, toAgentId: orchId }, orch);
  assert.equal(again.error, 'not_executable');
  assert.match(again.details, /уже на паузі/);

  // The scheduler: the channel (legacy group, Telegram paused) is held; its content slot is skipped.
  const now = new Date();
  const contentId = await slot({ at: new Date(now.getTime() - 60_000) });
  const calls: string[] = [];
  await scheduler(s, calls).tick(now);
  assert.ok(!calls.some((c) => c.startsWith('plan:') || c.startsWith('orchestrate:')), calls.join(','));
  assert.deepEqual(await slotStatus(contentId), { status: 'skipped', error: 'resource_paused' });

  // The reserved lane: the paid ad publishes, the promo is skipped.
  const adId = await slot({ at: new Date(now.getTime() - 30_000), kind: 'reserved' });
  const promoId = await slot({ at: new Date(now.getTime() - 20_000), kind: 'reserved', promo: { kind: 'cross_promo', source_ref: TG, target_ref: 'telegram:@pgt025t4_astro' } });
  const published: string[] = [];
  const reserved = new ReservedDispatcher({
    plans: scopedPlans(s.plans), orders: { findBySlot: async (id) => (id === adId ? { id: 'order' } as any : null) },
    sponsored: { publishClaimed: async (x) => { published.push(`ad:${x.id}`); await s.plans.updateSlot(x.id, { status: 'published' }); return true; } },
    manual: { publishScheduled: async () => false },
    promo: { publishPromo: async (x) => { published.push(`promo:${x.id}`); return true; } },
    paused: (ref) => s.pauses.isPaused(ref),
  });
  assert.equal(await reserved.publishDue(new Date()), 1);
  assert.deepEqual(published, [`ad:${adId}`]);
  assert.equal((await slotStatus(adId)).status, 'published');
  assert.deepEqual(await slotStatus(promoId), { status: 'skipped', error: 'resource_paused' });

  // PromoPlanner refuses a cross-promo from the paused channel and rejects that directive.
  const promoDir = await s.repo.insert({
    fromAgentId: null, toAgentId: orchId, kind: 'cross_promo', binding: 'directive', structural: true, body: 'Промо', rationale: 'pgt025t4',
    params: { source_ref: TG, target_ref: 'telegram:@pgt025t4_astro' }, evidence: null, expected: null, reviewAt: null, status: 'new', shadow: false,
  });
  await s.repo.update(promoDir.id, { status: 'accepted' });
  const planner = new PromoPlanner({
    pool, plans: s.plans, catalog: { list: async () => [
      { ref: TG, platform: 'telegram', groupId, title: 'Космос', username: 'pgt025t4_space' },
      { ref: 'telegram:@pgt025t4_astro', platform: 'telegram', groupId: null, title: 'Астро', username: 'pgt025t4_astro' },
    ] as any }, profiles: { get: async () => null }, links: {} as any, directives: s.repo,
    card: (k) => s.channels.get(k), usable: async () => true, paused: (ref) => s.pauses.isPaused(ref),
  });
  const refused: any = await planner.schedule((await s.repo.get(promoDir.id))!, orch, CH);
  assert.equal(refused.error, 'resource_paused');
  const rejected = (await s.repo.get(promoDir.id))!;
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.resolution ?? '', /^resource_paused:/);

  // verify(): pending while active (nothing published on Telegram in the window).
  assert.equal(await s.exec.verifyApplied(), 0);

  // The owner lifts it early through the API → the channel plans again; the directive verifies as followed.
  const lifted = await s.api.lift(TG);
  assert.equal(lifted.pause.liftedBy, 'owner');
  const calls2: string[] = [];
  await scheduler(s, calls2).tick(new Date());
  assert.ok(calls2.includes(`orchestrate:${CH}`) && calls2.includes(`plan:${CH}`), calls2.join(','));
  assert.equal(await s.exec.verifyApplied(), 1);
  const verified = (await s.repo.get(dir.id))!;
  assert.equal(verified.verification.adherence, 'followed');
  assert.equal(verified.verification.detail.published_or_shadowed, 0);
  assert.ok(verified.verifiedAt);
  assert.deepEqual((await inboxKinds()).map((x) => x.kind), ['resource_paused', 'resource_resumed']);

  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id = $1`, [orchId]);
  await pool.query(`DELETE FROM resource_pauses WHERE agent_id = $1`, [orchId]);
  await setGroupMode('independent');
});

test('auto-lift: the pause ends at `until` (the tick stamps it once) and the channel is planned again the next day', { skip }, async () => {
  const start = new Date();
  const until = new Date(start.getTime() + 2 * DAY);
  const s = setup();
  await setGroupMode('legacy_duplicate');
  await s.pauses.pause({ resourceRef: TG, agentId: orchId, directiveId: null, reason: 'pgt025t4 auto-lift', until });

  const during: string[] = [];
  await scheduler(s, during).tick(new Date(start.getTime() + DAY));
  assert.ok(!during.some((c) => c.startsWith('plan:')), 'held the day after the pause started');

  // A slot planned for the day after the pause: it runs (not skipped) once the pause is over.
  const nextDay = new Date(until.getTime() + 60_000);
  const after = setup(() => nextDay);
  const contentId = await slot({ at: new Date(until.getTime() + 30_000) });
  const calls: string[] = [];
  await scheduler(after, calls).tick(nextDay);
  assert.ok(calls.includes(`plan:${CH}`), calls.join(','));
  assert.ok(calls.includes(`exec:${contentId}`), calls.join(','));
  assert.equal((await slotStatus(contentId)).status, 'published');
  const row = (await pool.query(`SELECT lifted_by, lifted_at FROM resource_pauses WHERE resource_ref = $1`, [TG])).rows[0];
  assert.equal(row.lifted_by, 'schedule');
  assert.equal(new Date(row.lifted_at).getTime(), until.getTime());
  assert.deepEqual((await inboxKinds()).map((x) => x.kind), ['resource_paused', 'resource_resumed']);
  await scheduler(after, []).tick(nextDay);
  assert.deepEqual((await inboxKinds()).map((x) => x.kind), ['resource_paused', 'resource_resumed'], 'stamped once');

  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id = $1`, [orchId]);
  await pool.query(`DELETE FROM resource_pauses WHERE agent_id = $1`, [orchId]);
  await setGroupMode('independent');
});
