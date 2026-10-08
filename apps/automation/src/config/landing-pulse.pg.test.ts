/**
 * Spec 026 T1/T2 against a throwaway Postgres. Builds its own database next to
 * EDITOR_PG_TEST_URL (init.sql + every migration, so 066 is included), then:
 *   • migration 066 applies a second time cleanly and records its version once;
 *     landing_leads is not readable by editor_ro;
 *   • an empty database gives zero counts and no claims;
 *   • the FR-004 counting rules on seeded rows: shadowed posts, ads, chat drafts and
 *     legacy strategies are not agent posts; Telegram platform_posts are not counted
 *     twice; approval-mode editor posts are agent posts; the 7-day window holds;
 *   • the DM username resolves from the agent MTProto session (FR-002).
 * Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { LandingPulseService } from './landing-pulse.service';
import { LandingConfigService } from './landing-config.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const DB_DIR = join(__dirname, '..', '..', '..', '..', 'database');
const MIGRATIONS = join(DB_DIR, 'migrations');
const M066 = '066_landing_ai_network.sql';

let admin: Client;
let pool: Pool;
let dbName: string;

function withDb(u: string, db: string): string {
  const x = new URL(u);
  x.pathname = '/' + db;
  return x.toString();
}

async function applyFile(c: Pick<Client, 'query'>, sql: string) {
  await c.query('BEGIN');
  try { await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
}

before(async () => {
  if (!url) return;
  admin = new Client({ connectionString: url });
  await admin.connect();
  dbName = `${new URL(url).pathname.slice(1) || 'postgres'}_l026_${process.pid}`.toLowerCase();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const c = new Client({ connectionString: withDb(url, dbName), options: '-c client_min_messages=warning' });
  await c.connect();
  try {
    await c.query(readFileSync(join(DB_DIR, 'init.sql'), 'utf8'));
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      await applyFile(c, readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  } finally {
    await c.end();
  }
  pool = new Pool({ connectionString: withDb(url, dbName) });
});

after(async () => {
  if (!url) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await admin.end();
});

test('migration 066 re-applies cleanly, records its version once, and keeps leads away from editor_ro', { skip }, async () => {
  await applyFile(pool, readFileSync(join(MIGRATIONS, M066), 'utf8'));
  const v = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '066_landing_ai_network'`);
  assert.equal(v.rows[0].n, 1);

  const cols = await pool.query<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'youtube_accounts' AND column_name IN ('handle','subscribers','landing_visible','landing_order'))
     OR (table_name = 'meta_account_groups' AND column_name IN ('landing_blurb_uk','landing_blurb_en','landing_order'))
     OR (table_name = 'landing_cta_daily' AND column_name IN ('day','cta','placement','lang','clicks')))`);
  assert.equal(cols.rows.length, 12);

  const ro = await pool.query(`SELECT has_table_privilege('editor_ro', 'landing_leads', 'SELECT') AS can`);
  assert.equal(ro.rows[0].can, false);

  // The CHECKs and defaults hold.
  const lead = await pool.query(`INSERT INTO landing_leads (kind, contact, consent_at) VALUES ('ad', '@someone', now()) RETURNING status, lang, resources`);
  assert.deepEqual(lead.rows[0], { status: 'new', lang: 'en', resources: [] });
  await assert.rejects(pool.query(`INSERT INTO landing_leads (kind, contact, consent_at) VALUES ('reseller', 'x', now())`));
  await assert.rejects(pool.query(`INSERT INTO landing_leads (kind, contact) VALUES ('ad', 'x')`), 'consent_at is required');
  await pool.query(`DELETE FROM landing_leads`);
  await pool.query(`INSERT INTO landing_cta_daily (day, cta, placement) VALUES (CURRENT_DATE, 'dm', 'hero')`);
  await assert.rejects(pool.query(`INSERT INTO landing_cta_daily (day, cta, placement) VALUES (CURRENT_DATE, 'dm', 'hero')`), 'one row per day, cta, placement, lang');
  await pool.query(`DELETE FROM landing_cta_daily`);
});

test('an empty database: zero counts, manager off, no claims', { skip }, async () => {
  const p = await new LandingPulseService(pool).get();
  assert.deepEqual(p.agents, { orchestratorsLive: 0, orchestratorsShadow: 0, rolesActive: [], manager: 'off' });
  assert.deepEqual(p.last7d, {
    agentPosts: 0, allPosts: 0, autonomyShare: 0, platforms: [], agentRuns: 0, skippedByAgents: 0,
    directivesFiled: 0, managerReviews: 0, ideasReviewed: 0, ownerDecisions: 0,
  });
  assert.equal(p.lastAgentPostAt, null);
  assert.deepEqual(p.claims, { managerLive: false });
  assert.equal(p.stale, false);
});

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function agent(o: { kind: string; handle: string; mode: string; status?: string; parent?: string; scopeId?: string }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle, mode, status)
     VALUES ($1, 'resource', $2, $3, $4, $4, $5, $6) RETURNING id`,
    [o.kind, o.scopeId ?? `telegram:@${o.handle}`, o.parent ?? null, o.handle, o.mode, o.status ?? 'active']);
  return rows[0].id;
}

test('counting rules on seeded data', { skip }, async () => {
  // ── agents: approve and live count as live, paused counts as off ────────────
  const a = await agent({ kind: 'orchestrator', handle: 'orch_a', mode: 'approve' });
  const b = await agent({ kind: 'orchestrator', handle: 'orch_b', mode: 'live' });
  const c = await agent({ kind: 'orchestrator', handle: 'orch_c', mode: 'shadow' });
  await agent({ kind: 'orchestrator', handle: 'orch_d', mode: 'off' });
  await agent({ kind: 'orchestrator', handle: 'orch_e', mode: 'live', status: 'paused' });
  const planner = await agent({ kind: 'planner', handle: 'orch_a_planner', mode: 'approve', parent: a, scopeId: 'telegram:@orch_a' });
  const executor = await agent({ kind: 'executor', handle: 'orch_a_executor', mode: 'approve', parent: a, scopeId: 'telegram:@orch_a' });
  const reviewer = await agent({ kind: 'reviewer', handle: 'orch_b_reviewer', mode: 'live', parent: b, scopeId: 'telegram:@orch_b' });
  const ideas = await agent({ kind: 'idea_reviewer', handle: 'orch_c_ideas', mode: 'shadow', parent: c, scopeId: 'telegram:@orch_c' });
  const manager = (await pool.query(`SELECT id FROM agents WHERE kind = 'manager'`)).rows[0].id as string;

  // ── runs: ok + agent + in the window ─────────────────────────────────────────
  const run = (agentId: string | null, status: string, at: Date) => pool.query(
    `INSERT INTO editor_runs (role, model, status, agent_id, started_at) VALUES ('x', 'fake', $1, $2, $3)`, [status, agentId, at]);
  await run(planner, 'ok', ago(DAY));
  await run(executor, 'ok', ago(2 * DAY));
  await run(manager, 'ok', ago(3 * DAY));
  await run(reviewer, 'ok', ago(10 * DAY));   // outside the window
  await run(ideas, 'error', ago(DAY));        // not ok
  await run(null, 'ok', ago(DAY));            // no agent

  // ── posts ───────────────────────────────────────────────────────────────────
  let msg = 1;
  const tg = (strategy: string, at: Date) => pool.query(
    `INSERT INTO published_posts (channel_id, message_id, strategy_type, posted_at) VALUES ('@orch_a', $1, $2, $3)`, [msg++, strategy, at]);
  const pp = (platform: string, status: string, agentId: string | null, at: Date) => pool.query(
    `INSERT INTO platform_posts (resource_ref, platform, format, spec, status, agent_id, posted_at) VALUES ($1, $2, 'image', '{}', $3, $4, $5)`,
    [`${platform}:x`, platform, status, agentId, at]);
  const igAt = new Date(Date.now() - 3_600_000 + 37_123);
  await tg('editor', ago(2 * 3_600_000));
  await tg('editor', ago(DAY));
  await tg('editor', ago(2 * DAY));           // an approval-mode post: published by the editor after the owner's OK
  await tg('ad', ago(60_000));                // sponsored: allPosts only (and newest, but not an agent post)
  await tg('recipes', ago(DAY));              // legacy strategy
  await tg('chat', ago(DAY));                 // owner chat draft
  await tg('editor', ago(8 * DAY));           // outside the window
  await pp('instagram', 'published', executor, igAt);
  await pp('instagram', 'published', executor, ago(3 * DAY));
  await pp('instagram', 'shadowed', executor, ago(10 * 60_000));   // shadowed: never counts
  await pp('telegram', 'published', executor, ago(5 * 60_000));    // mirrors published_posts: not counted again
  await pp('facebook', 'published', null, ago(DAY));               // legacy mirror: allPosts only
  await pp('tiktok', 'failed', executor, ago(DAY));
  await pp('threads', 'awaiting_approval', executor, ago(DAY));

  // ── slots skipped by an agent ───────────────────────────────────────────────
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, title) VALUES ('@orch_a', 'approve', 'A')`);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ('@orch_a', CURRENT_DATE) RETURNING id`)).rows[0].id;
  const slot = (status: string, error: string | null, at: Date) => pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, error, updated_at)
     VALUES ($1, '@orch_a', now(), 'text', 't', $2, $3, $4)`, [plan, status, error, at]);
  await slot('skipped', 'skipped by agent: weak topic', ago(DAY));
  await slot('skipped', 'skipped by agent: duplicate', ago(2 * DAY));
  await slot('skipped', 'rejected by owner', ago(DAY));
  await slot('skipped', 'skipped by agent: old', ago(9 * DAY));
  await slot('published', null, ago(DAY));

  // ── directives, reviews, ideas, owner decisions ────────────────────────────
  const directive = (o: { shadow?: boolean; decision?: string | null; created: Date; updated: Date }) => pool.query(
    `INSERT INTO agent_directives (from_agent_id, to_agent_id, kind, body, rationale, status, owner_decision, shadow, created_at, updated_at)
     VALUES ($1, $2, 'advice', 'b', 'r', 'accepted', $3, $4, $5, $6)`,
    [manager, a, o.decision ?? null, o.shadow ?? false, o.created, o.updated]);
  await directive({ decision: 'approved', created: ago(DAY), updated: ago(DAY) });
  await directive({ decision: 'declined', created: ago(2 * DAY), updated: ago(DAY) });
  await directive({ shadow: true, created: ago(DAY), updated: ago(DAY) });
  await directive({ decision: 'timeout_applied', created: ago(10 * DAY), updated: ago(DAY) }); // not an owner decision
  await directive({ decision: 'approved', created: ago(12 * DAY), updated: ago(10 * DAY) });   // outside

  const review = (verdict: string, at: Date) => pool.query(
    `INSERT INTO manager_reviews (verdict, summary, created_at) VALUES ($1, 's', $2)`, [verdict, at]);
  await review('continue', ago(DAY));
  await review('directives', ago(2 * DAY));
  await review('skipped', ago(DAY));
  await review('continue', ago(10 * DAY));

  const idea = (reviewedBy: string | null, at: Date) => pool.query(
    `INSERT INTO content_ideas (agent_id, title, origin, expires_at, reviewed_by, updated_at) VALUES ($1, 'i', 'orchestrator', now() + interval '3 days', $2, $3)`,
    [a, reviewedBy, at]);
  await idea(ideas, ago(DAY));
  await idea(ideas, ago(2 * DAY));
  await idea(null, ago(DAY));
  await idea(ideas, ago(10 * DAY));

  await pool.query(
    `INSERT INTO playbooks (agent_id, version, status, body, created_by, decided_at) VALUES
       ($1, 1, 'superseded', '{}', 'orchestrator', $2),
       ($1, 2, 'active', '{}', 'orchestrator', $3),
       ($1, 3, 'pending_owner', '{}', 'orchestrator', NULL)`, [a, ago(10 * DAY), ago(DAY)]);

  const action = (status: string, at: Date) => pool.query(`INSERT INTO agent_actions (type, status, updated_at) VALUES ('reply', $1, $2)`, [status, at]);
  await action('done', ago(DAY));
  await action('rejected', ago(DAY));
  await action('pending', ago(DAY));
  await action('done', ago(10 * DAY));

  // ── the pulse ───────────────────────────────────────────────────────────────
  const p = await new LandingPulseService(pool).get();
  assert.deepEqual(p.agents, { orchestratorsLive: 2, orchestratorsShadow: 1, rolesActive: ['planner', 'executor'], manager: 'off' });
  assert.deepEqual(p.last7d, {
    agentPosts: 5,          // 3 editor Telegram posts + 2 Instagram agent posts
    allPosts: 9,            // + ad, legacy recipes, chat draft and the Facebook mirror
    autonomyShare: 56,
    platforms: [
      { platform: 'telegram', posts: 6, agentPosts: 3 },
      { platform: 'instagram', posts: 2, agentPosts: 2 },
      { platform: 'facebook', posts: 1, agentPosts: 0 },
    ],
    agentRuns: 3,
    skippedByAgents: 2,
    directivesFiled: 2,
    managerReviews: 2,
    ideasReviewed: 2,
    ownerDecisions: 5,      // 2 directives + 1 playbook + 2 agent actions
  });
  assert.equal(p.lastAgentPostAt, new Date(Math.floor(igAt.getTime() / 60_000) * 60_000).toISOString());
  assert.deepEqual(p.claims, { managerLive: false }, 'the manager is off');

  // No ids, handles or names reach the payload.
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  assert.doesNotMatch(text, /orch_|@|fake/);

  // The manager goes live and has reviewed: the claim switches on.
  await pool.query(`UPDATE agents SET mode = 'live' WHERE id = $1`, [manager]);
  const live = await new LandingPulseService(pool).get();
  assert.equal(live.agents.manager, 'live');
  assert.deepEqual(live.claims, { managerLive: true });
});

test('the DM username comes from the active agent session, never a tracker one', { skip }, async () => {
  await pool.query(
    `INSERT INTO mtproto_sessions (label, session_enc, active, username, role, created_at) VALUES
       ('tracker', 'enc:v1:x', true, 'tracker_acc', 'tracker', now() - interval '2 days'),
       ('old agent', 'enc:v1:x', false, 'old_agent_acc', 'agent', now() - interval '3 days'),
       ('agent', 'enc:v1:x', true, 'ai0_agent_acc', 'agent', now() - interval '1 day')`);
  const svc = new LandingConfigService(pool);
  const cfg = await svc.publicConfig();
  assert.equal(cfg.adDm.username, 'ai0_agent_acc');
  assert.equal(new URL(cfg.adDm.urls.topbar!).pathname, '/ai0_agent_acc');

  await svc.update({ adTgUsername: '@ads_desk', adMessage: 'Реклама в {target}, будь ласка. {ref}', whiteLabelEnabled: false });
  const stored = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'landing.%' ORDER BY key`);
  assert.deepEqual(stored.rows, [
    { key: 'landing.ad_message_en', value: 'Реклама в {target}, будь ласка. {ref}' },
    { key: 'landing.ad_tg_username', value: 'ads_desk' },
    { key: 'landing.white_label_enabled', value: 'false' },
  ]);
  const after = await svc.publicConfig();
  assert.equal(after.adDm.username, 'ads_desk');
  assert.equal(new URL(after.adDm.urls.hero!).searchParams.get('text'), 'Реклама в the ai0 network, будь ласка. [ai0web:hero]');

  await svc.update({ adTgUsername: null, adMessage: null, whiteLabelEnabled: true });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app_settings WHERE key LIKE 'landing.%'`)).rows[0].n, 0);
  await pool.query(`UPDATE mtproto_sessions SET active = false WHERE role = 'agent'`);
  const none = await new LandingConfigService(pool).publicConfig();
  assert.deepEqual(none.adDm, { available: false, username: null, urls: {} });
});
