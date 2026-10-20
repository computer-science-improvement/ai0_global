/**
 * Spec 056 FR-001 against a throwaway Postgres: the batched queries of the map snapshot run on the real schema and the
 * snapshot says what the rows say (state, level, roads, alerts, events) without any post text. Skipped unless
 * EDITOR_PG_TEST_URL is set. Everything runs in a rolled-back transaction.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { ResourceCatalog } from '../agents/resource-catalog';
import { MapService } from './map.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const TG = '@pgtest_map_056';
const SECRET = 'SECRET BODY of the post that must never reach the map';
let pool: Pool;

before(async () => { if (url) pool = new Pool({ connectionString: url }); });
after(async () => { await pool?.end(); });

async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

const emptyBudgets = async () => ({ rows: [], agentCaps: [], blocking: [] });

test('the snapshot is built from the real schema: units, resources, roads, alerts, events, level — and no post text', { skip }, async () => {
  await inTx(async (c) => {
    const g = (await c.query(`INSERT INTO meta_account_groups (name) VALUES ('Pgtest map net') RETURNING id`)).rows[0].id as string;
    await c.query(`INSERT INTO tracked_channels (channel_key, title, username, is_mine, subs_count, group_id) VALUES ($1, 'Map TG', 'pgtest_map_056', true, 1200, $2)`, [TG, g]);
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [TG]);
    const ig = (await c.query(
      `INSERT INTO meta_accounts (platform, account_id, target_id, username, followers, group_id) VALUES ('instagram', 'pgmap', 'pgmap', 'pgmap_ig', 77, $1) RETURNING id`, [g])).rows[0].id as string;
    const IG = `instagram:${ig}`;

    const mk = async (kind: string, scope: string, scopeId: string | null, handle: string, parent: string | null = null, mode = 'live') => (await c.query(
      `INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle, mode) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [kind, scope, scopeId, parent, handle, handle, mode])).rows[0].id as string;
    const tg = await mk('orchestrator', 'resource', `telegram:${TG}`, 'pgmap_tg');
    const planner = await mk('planner', 'resource', `telegram:${TG}`, 'pgmap_tg_pl', tg);
    const executor = await mk('executor', 'resource', `telegram:${TG}`, 'pgmap_tg_ex', tg);
    const igAgent = await mk('orchestrator', 'resource', IG, 'pgmap_ig_o');
    await mk('manager', 'system', 'pgmap', 'pgmap_mgr');

    const plan = (await c.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [TG])).rows[0].id as string;
    const slot = async (ch: string, ref: string | null, status: string, topic: string, extra: Record<string, unknown> = {}) => {
      const cols = ['plan_id', 'channel_key', 'resource_ref', 'scheduled_at', 'format', 'topic', 'status', 'rendered_preview', ...Object.keys(extra)];
      const vals = [plan, ch, ref, new Date(), 'text', topic, status, SECRET, ...Object.values(extra)];
      return (await c.query(`INSERT INTO editor_slots (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals)).rows[0].id as string;
    };
    await slot(TG, null, 'awaiting_approval', 'Waiting A');
    await slot(TG, null, 'awaiting_approval', 'Waiting B');
    await slot(TG, null, 'published', 'Published pass', { critic: JSON.stringify({ verdict: 'pass' }), approved_at: new Date(), owner_edited: false });
    await slot(TG, null, 'published', 'Published revised', { critic: JSON.stringify({ verdict: 'revise' }), approved_at: new Date(), owner_edited: true });
    await slot(TG, null, 'skipped', 'Rejected one', { error: 'rejected by owner' });
    const running = await slot(TG, null, 'running', 'Running topic');
    await slot(TG, IG, 'failed', 'Failed on ig', { error: 'publish_failed: 400 ' + SECRET });
    await slot(TG, null, 'published', 'Promo post', { promo: JSON.stringify({ kind: 'cross_promo', source_ref: `telegram:${TG}`, target_ref: IG }) });

    await c.query(`INSERT INTO editor_runs (role, channel_key, slot_id, model, status, agent_id) VALUES ('executor', $1, $2, 'm', 'running', $3)`, [TG, running, executor]);
    await c.query(`INSERT INTO editor_runs (role, channel_key, model, status, agent_id, finished_at) VALUES ('planner', $1, 'm', 'budget_exceeded', $2, now() - interval '10 minutes')`, [TG, planner]);
    await c.query(`INSERT INTO promo_pairs (source_ref, target_ref, last_promo_at, count_30d) VALUES ($1, $2, now(), 3)`, [`telegram:${TG}`, IG]);
    await c.query(`INSERT INTO agent_directives (to_agent_id, kind, body, rationale, status) VALUES ($1, 'strategy', 'b', 'r', 'awaiting_owner')`, [tg]);
    await c.query(`INSERT INTO channel_launches (channel_key, target_ref, brief, status, agent_id) VALUES ('@pgtest_map_056_new', 'telegram:@pgtest_map_056_new', 'brief', 'ready', $1)`, [tg]);
    await c.query(`INSERT INTO resource_profiles (resource_ref, resource_health, updated_by) VALUES ($1, $2, 'system')`, [IG, { state: 'token_invalid', detail: 'token expired', checkedAt: new Date().toISOString() }]);
    await c.query(`UPDATE my_bots SET is_default = false`);
    const botA = (await c.query(`INSERT INTO my_bots (bot_id, username, token_env, is_default, last_verified_at) VALUES ('pgmap1', 'pgmap_bot', 'PGMAP_TOKEN', true, now()) RETURNING id`)).rows[0].id as string;
    const botB = (await c.query(`INSERT INTO my_bots (bot_id, username, token_env, verify_error) VALUES ('pgmap2', 'pgmap_bot2', 'PGMAP_TOKEN2', '401 Unauthorized') RETURNING id`)).rows[0].id as string;
    const ses = (await c.query(`INSERT INTO mtproto_sessions (label, session_enc, username, phone, role) VALUES ('Pgmap tracker', 'enc:v1:SECRETSESSION', 'pgmap_user', '+380SECRETPHONE', 'tracker') RETURNING id`)).rows[0].id as string;

    const svc = new MapService({
      pool: c, agents: new AgentsRepository(c), catalog: new ResourceCatalog({ pool: c }), budgets: emptyBudgets, pausedRefs: async () => new Set(), cacheMs: 0,
    });
    const snap = await svc.build();
    const mine = (h: string) => snap.units.find((u) => u.handle === h)!;

    // resources and networks
    assert.deepEqual(snap.networks.find((n) => n.id === g), { id: g, name: 'Pgtest map net', anchorRef: `telegram:${TG}` });
    const rTg = snap.resources.find((r) => r.ref === `telegram:${TG}`)!;
    assert.equal(rTg.followers, 1200);
    assert.equal(rTg.waiting, 2);
    assert.equal(rTg.postsToday, 3, 'two published and the promo post');
    assert.equal(rTg.groupId, g);
    const rIg = snap.resources.find((r) => r.ref === IG)!;
    assert.equal(rIg.health, 'broken');
    assert.equal(rIg.healthDetail, 'token expired');

    // infra: bots, sessions, Telegraph — the default bot serves the channel without its own bot; never a phone or a session
    const bA = snap.infra.find((i) => i.id === `bot:${botA}`)!;
    assert.equal(bA.title, '@pgmap_bot');
    assert.equal(bA.health, 'ok');
    assert.ok(bA.isDefault);
    assert.ok(bA.serves.includes(`telegram:${TG}`));
    assert.equal(bA.path, '/app/connections?section=telegram&tab=bots');
    const bB = snap.infra.find((i) => i.id === `bot:${botB}`)!;
    assert.equal(bB.health, 'broken');
    assert.deepEqual(bB.serves, []);
    assert.ok(snap.alerts.some((a) => a.kind === 'connection' && a.ref === `bot:${botB}`));
    const s1 = snap.infra.find((i) => i.id === `mtproto:${ses}`)!;
    assert.deepEqual([s1.kind, s1.title, s1.role, s1.health], ['mtproto', 'Pgmap tracker', 'tracker', 'unknown']);
    assert.ok(!JSON.stringify(snap).includes('SECRETPHONE') && !JSON.stringify(snap).includes('SECRETSESSION'), 'no phone, no session');

    // units: state rules from the rows
    assert.equal(mine('pgmap_tg').state, 'publishing', 'a slot of its resource is running (it comes before waiting)');
    assert.equal(mine('pgmap_tg').detail, 'Running topic');
    assert.equal(mine('pgmap_tg').homeRef, `telegram:${TG}`);
    assert.equal(mine('pgmap_tg_ex').state, 'writing');
    assert.equal(mine('pgmap_tg_ex').detail, 'Running topic');
    assert.equal(mine('pgmap_tg_pl').state, 'error', 'budget_exceeded run in the last 2 h');
    assert.equal(mine('pgmap_ig_o').state, 'error', 'a failed slot on its resource');
    assert.equal(mine('pgmap_ig_o').detail, 'publish_failed');
    assert.equal(mine('pgmap_mgr').level, null, 'system agents have no level');
    assert.equal(mine('pgmap_mgr').homeRef, null);
    assert.equal(mine('pgmap_tg_ex').effectiveMode, 'live');

    // level: 1 clean approval (the edited one is not clean), 1 critic pass, 1 rejection, 1 failed run (the budget_exceeded planner run)
    assert.deepEqual(mine('pgmap_tg').levelStats, { clean: 1, pass: 1, rejected: 1, failedRuns: 1, score: 1 + 1 - 2 * 1 - 1 });
    assert.equal(mine('pgmap_tg').level, 1);
    assert.equal(mine('pgmap_tg_ex').level, mine('pgmap_tg').level, 'role children show their orchestrator level');

    // roads
    assert.deepEqual(snap.roads.map((r) => [r.from, r.to, r.kind, r.count30d]), [[`telegram:${TG}`, IG, 'promo', 3]]);

    // alerts
    const kinds = snap.alerts.map((a) => a.kind);
    assert.ok(kinds.includes('approval') && kinds.includes('connection') && kinds.includes('directive') && kinds.includes('launch'), kinds.join());
    assert.equal(snap.alerts.find((a) => a.kind === 'approval')!.count, 2);
    assert.equal(snap.alerts.find((a) => a.kind === 'directive')!.agent, 'pgmap_tg');

    // events: stable ids, newest first, topics only
    const ids = snap.events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.some((i) => i.startsWith('run:')) && ids.some((i) => i.endsWith(':published')) && ids.some((i) => i.endsWith(':promo')));
    assert.ok(snap.events.some((e) => e.kind === 'post_failed' && e.text.includes('publish_failed')));
    assert.ok(snap.events.some((e) => e.kind === 'promo' && e.toRef === IG && e.ref === `telegram:${TG}`));
    assert.ok(snap.events.every((e, i, a) => i === 0 || new Date(a[i - 1].at) >= new Date(e.at)));
    assert.ok(snap.events.length <= 30);
    assert.ok(!JSON.stringify(snap).includes('SECRET BODY'), 'no post text in the snapshot');
    assert.ok(snap.totals.postsToday >= 3);
    assert.equal(snap.budget.capUsd, null);

    // a second snapshot sees the same stable event ids
    assert.deepEqual((await svc.build()).events.map((e) => e.id), ids);
  });
});

test('a paused resource pauses its units; an off channel card turns the orchestrator off', { skip }, async () => {
  await inTx(async (c) => {
    await c.query(`INSERT INTO tracked_channels (channel_key, title, is_mine) VALUES ('@pgtest_map_056_b', 'B', true)`);
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pgtest_map_056_b', 'off')`);
    await c.query(`INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', 'telegram:@pgtest_map_056_b', 'B', 'pgmap_b', 'live')`);
    const mk = () => new MapService({
      pool: c, agents: new AgentsRepository(c), catalog: new ResourceCatalog({ pool: c }), budgets: emptyBudgets,
      pausedRefs: async () => new Set(['telegram:@pgtest_map_056_b']), cacheMs: 0,
    });
    assert.equal((await mk().build()).units.find((u) => u.handle === 'pgmap_b')!.state, 'paused');
    const noPause = new MapService({ pool: c, agents: new AgentsRepository(c), catalog: new ResourceCatalog({ pool: c }), budgets: emptyBudgets, pausedRefs: async () => new Set(), cacheMs: 0 });
    const u = (await noPause.build()).units.find((x) => x.handle === 'pgmap_b')!;
    assert.equal(u.state, 'off');
    assert.equal(u.mode, 'live');
    assert.equal(u.effectiveMode, 'off');
  });
});

test('the snapshot builds in a few queries and quickly with 100 agents and 50 resources', { skip }, async () => {
  await inTx(async (c) => {
    for (let i = 0; i < 50; i++) {
      await c.query(`INSERT INTO tracked_channels (channel_key, title, is_mine) VALUES ($1, $2, true)`, [`@pgtest_map_perf_${i}`, `P${i}`]);
      await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [`@pgtest_map_perf_${i}`]);
      const o = (await c.query(
        `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'P', $2, 'live') RETURNING id`,
        [`telegram:@pgtest_map_perf_${i}`, `pgperf_${i}`])).rows[0].id;
      await c.query(`INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle, mode) VALUES ('executor', 'resource', $1, $2, 'x', $3, 'live')`,
        [`telegram:@pgtest_map_perf_${i}`, o, `pgperf_${i}_ex`]);
    }
    let queries = 0;
    const counting = { query: (...a: any[]) => { queries++; return (c.query as any)(...a); } };
    const svc = new MapService({ pool: counting as any, agents: new AgentsRepository(counting as any), catalog: new ResourceCatalog({ pool: counting as any }), budgets: emptyBudgets, pausedRefs: async () => new Set(), cacheMs: 0 });
    const t0 = Date.now();
    const snap = await svc.build();
    const ms = Date.now() - t0;
    assert.equal(snap.units.filter((u) => u.handle.startsWith('pgperf_')).length, 100);
    assert.equal(snap.resources.filter((r) => r.ref.includes('pgtest_map_perf_')).length, 50);
    assert.ok(queries < 40, `${queries} queries, none per agent`);
    assert.ok(ms < 300, `${ms} ms`);
  });
});
