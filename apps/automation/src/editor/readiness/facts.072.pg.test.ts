/**
 * Spec 072 T3 against a throwaway database of its own (every migration applied; see testing/pg-db.ts): `loadChannelFacts` on a
 * fully seeded channel, that it writes nothing, that a cycle dataset with no unused rows is not rolled, the A21 window of an
 * `after_days` dataset, `@X` for a stored `@x`, a fixed number of queries and a stable config hash. Skipped unless
 * EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildCatalog } from '../../data/data-catalog';
import { ContentLedger } from '../../data/content-ledger';
import { DataStore } from '../../data/data-store';
import { AgentsRepository } from '../agents/agents.repository';
import { SkillStore } from '../agents/skill-store';
import { LaunchRepository } from '../launch/launch.repository';
import { NetworkRepository } from '../network/network.repository';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { SeriesPausesRepository } from '../series-pause/series-pauses.repository';
import { SteeringRepository } from '../steering/steering.repository';
import { PgSourceProbes } from '../sources/source-probes.repository';
import { makeCard } from '../post/testing/fixtures';
import { ChannelNotFound, configHash, loadChannelFacts } from './facts';
import { mkPlaybook, mkSeries } from './testing/facts-fixture';
import { scratchDb, type ScratchDb } from './testing/pg-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@fx072pg';
const REF = `telegram:${CH}`;
/** The group's Instagram account (one Telegram channel per group at most): set in `before`. */
let SIBREF = '';
const RSS = 'https://feeds.fx072.example/rss.xml';
const DAY = 86_400_000;

let db: ScratchDb;
let pool: Pool;
let orchId: string;
let execId: string;
let planId: string;
let steeringSetId: string;
let ruleId: number;
let approvalRuleId: number;
const ids: Record<string, Record<string, string>> = {};

before(async () => {
  if (!url) return;
  db = await scratchDb(url, 'facts');
  pool = db.pool;

  // The card, its profile and a group of two channels.
  await new EditorChannelsRepository(pool).upsert(makeCard({
    channelKey: CH, mode: 'shadow', title: 'FX 072', formats: { text: 1 }, hashtags: [], hashtagMin: 1, hashtagMax: 3, toolsAllow: ['fetch_feed'],
    sources: [{ id: 'feed1', kind: 'rss', ref: RSS }, { id: 'lib1', kind: 'library', ref: 'FX072_Tips' }, { id: 'lib2', kind: 'library', ref: 'fx072_aft' }],
  }));
  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name) VALUES ('fx072 network') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'fx072pg', 'FX', true, $2)`, [CH, groupId]);
  const igId = (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id) VALUES ('instagram', 'fx072-ig', 'X', 't', 'fx072_ig', $1) RETURNING id`, [groupId])).rows[0].id;
  SIBREF = `instagram:${igId}`;
  await pool.query(`INSERT INTO resource_profiles (resource_ref, profile) VALUES ($1, $2), ($3, $4)`, [
    REF, JSON.stringify({ topic: 'Kitchen', audience: { who: 'home cooks' }, language: 'uk', goals: ['growth'], format_prefs: { slang: true } }),
    SIBREF, JSON.stringify({ topic: 'Sibling', audience: { who: 'home cooks' }, language: 'uk', goals: ['growth'], format_prefs: { slang: true } }),
  ]);

  // The agent chain, its playbooks and the owner's pins.
  const agents = new AgentsRepository(pool);
  orchId = (await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'FX', handle: 'fx072pg_orch', mode: 'shadow', createdBy: 'owner' } as any)).id;
  execId = (await agents.insert({ kind: 'executor', scope: 'resource', scopeId: REF, parentId: orchId, name: 'FX writer', handle: 'fx072pg_exec', mode: 'shadow', createdBy: 'owner' } as any)).id;
  const net = new NetworkRepository(pool);
  const body = mkPlaybook([
    mkSeries({ resource_ref: REF, name: 'Tip of the day', cadence: 'daily@10:00,18:00', source: { kind: 'library', table: 'fx072_tips' }, source_mode: 'required' }),
    mkSeries({ resource_ref: REF, name: 'Cycle round', cadence: 'weekly:mon,thu@09:00', source: { kind: 'library', table: 'fx072_cyc' } }),
    mkSeries({ resource_ref: REF, name: 'Feed digest', cadence: 'daily@12:00', source: { kind: 'feed', ref: 'feed1' } }),
    mkSeries({ resource_ref: REF, name: 'Retired', active: false, source: { kind: 'library', table: 'fx072_aft' } }),
    mkSeries({ name: 'Elsewhere', resource_ref: 'telegram:@fx072pg_other' }),
  ], { platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] });
  await net.insertPlaybook({ agentId: orchId, status: 'active', brief: null, body, rationale: 'seed', createdBy: 'owner' });
  await net.insertPlaybook({ agentId: orchId, status: 'pending_owner', brief: null, body: mkPlaybook([mkSeries({ resource_ref: REF, name: 'Pending series' })]), rationale: 'draft', createdBy: 'orchestrator' } as any);
  await pool.query(`INSERT INTO schedule_rules (agent_id, resource_ref, kind, at_local, format, brief, active) VALUES
    ($1, $2, 'pin', '12:00', 'text', 'Noon note', true), ($1, $2, 'pin', '20:00', 'text', 'Evening note', false)`, [orchId, REF]);

  // Skills (one switched off), owner rules (one is a learnt approval preference), steering, the loadout.
  const skills = new SkillStore(pool);
  const write = async (agentId: string, name: string) => {
    const w: any = await skills.writeAgentSkill({ agentId, name, description: 'Як писати пости каналу коротко', appliesTo: ['executor'], body: 'Пиши коротко.', author: 'owner' });
    assert.ok(w.ok, JSON.stringify(w));
    return w.skill.id as string;
  };
  await write(execId, 'fx-style');
  await write(orchId, 'fx-planner');
  const offId = await write(execId, 'fx-off');
  await pool.query(`UPDATE agent_skills SET enabled = false WHERE agent_id = $1 AND skill_id = $2`, [execId, offId]);
  const memory = new EditorMemoryRepository(pool);
  ruleId = await memory.add(CH, 'rule', 'Never post on Sundays', null, 'owner');
  approvalRuleId = await memory.add(CH, 'rule', 'Prefers short posts', { source: 'approval' }, 'owner');
  await memory.add(CH, 'insight', 'Photos get more views', null, 'reviewer');
  const steering = new SteeringRepository(pool);
  const set = (await steering.enqueue({ targetRef: REF, channelKey: CH, sourceRef: 'telegram:@fx072pg_ref', createdBy: 'owner' })).set;
  const rule = (id: string, enabled: boolean, conflict: { with: string; note: string } | null) => ({ id, kind: 'length', text: `Steering rule ${id}`, evidence: { post_ids: [], note: '' }, conflict, enabled });
  await steering.update(set.id, { status: 'ready', rules: [rule('s1', true, null), rule('s2', false, null), rule('s3', true, { with: 'rule 1', note: 'x' })] as any });
  assert.ok('set' in (await steering.activate(set.id, 5)));
  steeringSetId = set.id;
  await pool.query(`UPDATE agents SET loadout_mode = 'custom' WHERE id = $1`, [execId]);
  await pool.query(`INSERT INTO agent_tools (agent_id, tool_name, enabled, created_by) VALUES ($1, 'fetch_feed', true, 'owner'), ($1, 'query_data', true, 'owner')`, [execId]);

  // Datasets: tips (3 of 10 rows cannot be posted), a cycle dataset used up, an after_days dataset.
  const store = new DataStore(pool);
  const mk = (key: string, reuse_policy: object) => store.createSchema({
    key, title: key, description: `Dataset ${key}`, entity: 'item',
    fields: [{ name: 'code', type: 'text', description: 'Code', required: true }, { name: 'text', type: 'text', description: 'Text' }],
    roles: { title: 'code' }, dedup_key: ['code'], language: 'uk', default_license: 'own', reuse_policy: reuse_policy as any,
    suitable_for: 'tests', contains_personal_data: false, status: 'active',
  } as any, 'pgtest');
  await mk('fx072_tips', { kind: 'never' });
  await mk('fx072_cyc', { kind: 'cycle', order: 'sequential' });
  await mk('fx072_aft', { kind: 'after_days', days: 30 });
  const rowsOf = (n: number, p: string, noText = 0) => Array.from({ length: n }, (_, i) => ({ code: `${p}${i}`, ...(i < noText ? {} : { text: `Text ${p}${i}` }) }));
  await store.upsert('fx072_tips', rowsOf(10, 't', 3));
  await store.upsert('fx072_cyc', rowsOf(3, 'c'));
  await store.upsert('fx072_aft', rowsOf(3, 'a'));
  await pool.query(`UPDATE data_schemas SET post_requires = '[["text"]]'::jsonb WHERE key LIKE 'fx072\\_%'`);
  for (const key of ['fx072_tips', 'fx072_cyc', 'fx072_aft']) {
    const { rows } = await pool.query(`SELECT d.id, d.data->>'code' AS code FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [key]);
    ids[key] = Object.fromEntries(rows.map((r: any) => [r.code, r.id]));
  }
  await pool.query(
    `INSERT INTO data_schema_stats (schema_id, fill_rate) SELECT id, '{"text":0.7}'::jsonb FROM data_schemas WHERE key = 'fx072_tips'
     ON CONFLICT (schema_id) DO UPDATE SET fill_rate = EXCLUDED.fill_rate`);
  const ledger = new ContentLedger(pool);
  const use = (key: string, code: string, days: number, resourceRef = REF) =>
    ledger.record(`data://${key}/${ids[key][code]}`, { resourceRef, origin: 'editor', status: 'published', usedAt: new Date(Date.now() - days * DAY) });
  await use('fx072_tips', 't3', 2);
  await use('fx072_tips', 't4', 5);
  await use('fx072_tips', 't5', 1, SIBREF);
  await use('fx072_aft', 'a0', 40);
  await use('fx072_aft', 'a1', 10);
  // A trigger rolls the round of a cycle dataset when its last row is used; this seed wants the state before that.
  await pool.query(`ALTER TABLE content_ledger DISABLE TRIGGER USER`);
  for (const c of ['c0', 'c1', 'c2']) await use('fx072_cyc', c, 1);
  await pool.query(`ALTER TABLE content_ledger ENABLE TRIGGER USER`);

  // Pauses, host blocks, the launch, slots.
  const pauses = new SeriesPausesRepository(pool);
  await pauses.insertOpen({ channelKey: CH, key: 'series:Tip of the day', label: 'Tip of the day', cause: 'owner', reason: 'paused by the owner', streak: 0 });
  const closed = await pauses.insertOpen({ channelKey: CH, key: 'series:Cycle round', label: 'Cycle round', cause: 'no_material', reason: 'old', streak: 3 });
  await pauses.resume(closed!.id, 'owner');
  await pauses.insertOpen({ channelKey: '@fx072pg_other', key: 'series:X', label: 'X', cause: 'owner', reason: 'other channel', streak: 0 });
  await pool.query(
    `INSERT INTO source_host_failures (host, reason, status_code, first_at, last_at, blocked_until, strikes) VALUES
       ('feeds.fx072.example/rss.xml', 'feed_missing', 404, now(), now(), now() + interval '1 day', 0),
       ('feeds.fx072.example', 'refused', 403, now(), now(), now() + interval '1 day', 1),
       ('old.fx072.example', 'refused', 403, now() - interval '3 days', now() - interval '3 days', now() - interval '2 days', 1)`);
  const launches = new LaunchRepository(pool);
  const launch = await launches.insert({ channelKey: CH, title: 'FX 072', brief: 'A channel about kitchens', refs: [], createdBy: 'owner' });
  await launches.update(launch!.id, { status: 'running', botState: { state: 'no_access', detail: 'bot is not an admin', bot: 'fx_bot' } });

  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [CH])).rows[0].id;
  const slot = (o: { at: number; status: string; error?: string; critic?: object | null; series?: string | null; hints?: string[]; ref?: string | null; kind?: string }) => pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, status, error, critic, series_name, source_hints, resource_ref)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval, $4, 'text', 'Topic', $5, $6, $7, $8, $9, $10)`,
    [planId, CH, String(o.at), o.kind ?? 'content', o.status, o.error ?? null, o.critic ? JSON.stringify(o.critic) : null, o.series ?? null, JSON.stringify(o.hints ?? []), o.ref === undefined ? REF : o.ref]);
  await slot({ at: 120, status: 'planned', series: 'Tip of the day', hints: ['library:fx072_tips'] });
  await slot({ at: 24 * 60, status: 'planned', ref: null });
  await slot({ at: 72 * 60, status: 'planned' });
  await slot({ at: 120, status: 'planned', ref: 'telegram:@fx072pg_other' });
  await slot({ at: 120, status: 'planned', kind: 'reserved' });
  await slot({ at: -180, status: 'skipped', error: 'no_fresh_item: fx072_tips', critic: { verdict: 'revise' }, series: 'Tip of the day' });
  await slot({ at: -600, status: 'failed', error: 'boom' });
  await slot({ at: -60, status: 'shadowed', critic: { verdict: 'pass' } });
  await slot({ at: -30 * 60, status: 'published' });
  await slot({ at: -120, status: 'skipped', error: 'other channel', ref: 'telegram:@fx072pg_other' });
});

after(async () => {
  if (db) await db.drop();
});

const TABLES = [
  'editor_channels', 'resource_profiles', 'agents', 'agent_skills', 'skills', 'skill_versions', 'agent_tools', 'editor_channel_memory', 'steering_sets',
  'playbooks', 'schedule_rules', 'data_schemas', 'data_schema_stats', 'data_items', 'data_reuse_rounds', 'content_ledger', 'series_pauses',
  'source_host_failures', 'channel_launches', 'editor_slots', 'editor_plans', 'tracked_channels', 'meta_account_groups', 'app_settings',
];
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`);
    out[t] = `${rows[0].n}:${rows[0].h}`;
  }
  return out;
}

function counting(p: Pool): { pool: Pool; count: () => number } {
  let n = 0;
  const wrapped = { query: (...a: unknown[]) => { n++; return (p.query as (...x: unknown[]) => unknown)(...a); } } as unknown as Pool;
  return { pool: wrapped, count: () => n };
}

test('a seeded channel gives the expected facts', { skip }, async () => {
  const f = await loadChannelFacts(pool, CH);
  assert.equal(f.channelKey, CH);
  assert.equal(f.resourceRef, REF);
  assert.equal(f.card.mode, 'shadow');
  assert.ok(f.card.createdAt instanceof Date);
  assert.deepEqual(f.agent, { id: orchId, handle: 'fx072pg_orch', mode: 'shadow' });
  assert.deepEqual(f.chain, { orchestratorId: orchId, executorId: execId });
  assert.equal(f.profile?.topic, 'Kitchen');
  assert.equal(f.profile?.language, 'uk');
  assert.equal(f.profile?.formatPrefs.slang, true);
  assert.equal(f.group?.name, 'fx072 network');
  assert.deepEqual(f.resources.map((r) => r.ref).sort(), [REF, SIBREF].sort());

  assert.equal(f.playbook?.version, 1);
  assert.equal(f.pendingPlaybook?.id !== undefined, true);
  assert.deepEqual(f.series.map((s) => s.name), ['Tip of the day', 'Cycle round', 'Feed digest', 'Retired'], 'only this resource; the inactive series stays');
  assert.deepEqual(f.pins.map((p) => [p.format, p.active]), [['text', true], ['text', false]]);
  assert.deepEqual(f.skills.map((s) => s.name).sort(), ['fx-planner', 'fx-style'], 'enabled only, executor chain and orchestrator');
  assert.ok(f.skills.every((s) => s.body.length > 0 && s.version >= 1));
  assert.deepEqual(f.rules, [{ id: ruleId, text: 'Never post on Sundays' }], 'owner rules without the approval preference');
  assert.deepEqual([...f.conflictInput.rules.map((r) => r.id)].sort(), [ruleId, approvalRuleId].sort(), 'forAgent selects every owner row');
  assert.deepEqual(f.steering, [{ id: `${steeringSetId}/0`, text: 'Steering rule s1' }], 'enabled and without a conflict');
  assert.deepEqual(f.loadoutTools, ['fetch_feed', 'query_data']);
  assert.deepEqual(f.effectiveTools, ['fetch_feed']);

  assert.deepEqual(f.datasets.map((d) => d.key), ['fx072_aft', 'fx072_cyc', 'fx072_tips']);
  const ds = Object.fromEntries(f.datasets.map((d) => [d.key, d]));
  const tips = ds.fx072_tips;
  assert.deepEqual([tips.rows, tips.notPostable, tips.unusedPostable, tips.used28], [10, 3, 5, 2]);
  assert.deepEqual(tips.postRequires, [['text']]);
  assert.deepEqual(tips.fillRate, { text: 0.7 });
  assert.deepEqual(tips.boundBy, ['card', 'series:Tip of the day'], 'the card names it as FX072_Tips');
  assert.equal(tips.seriesPerDay, 2);
  assert.deepEqual(ds.fx072_cyc.boundBy, ['series:Cycle round']);
  assert.equal(ds.fx072_cyc.seriesPerDay, 2 / 7, 'one time on two weekdays');
  assert.equal(ds.fx072_cyc.fillRate, null);
  assert.deepEqual(ds.fx072_cyc.reusePolicy, { kind: 'cycle', order: 'sequential' });
  assert.deepEqual(ds.fx072_aft.boundBy, ['card'], 'the retired series reads nothing');

  assert.deepEqual(f.pauses.map((p) => p.key), ['series:Tip of the day'], 'open pauses of this channel only');
  const src = (origin: string) => f.sources.filter((s) => s.origin === origin);
  assert.deepEqual(src('card').map((s) => [s.kind, s.url]), [['rss', RSS], ['library', 'library:FX072_Tips'], ['library', 'library:fx072_aft']]);
  assert.equal(src('card')[0].required, false, 'the card has three sources');
  assert.equal(src('card')[0].host, 'feeds.fx072.example');
  assert.equal(src('card')[0].hostBlock?.reason, 'feed_missing', 'the feed answers to its own key, not to the page refusal of the host');
  assert.deepEqual(src('series:Tip of the day').map((s) => [s.url, s.required]), [['library:fx072_tips', true]]);
  assert.deepEqual(src('series:Cycle round').map((s) => [s.url, s.required]), [['library:fx072_cyc', false]]);
  assert.deepEqual(src('series:Feed digest').map((s) => [s.kind, s.url, s.hostBlock?.reason]), [['rss', RSS, 'feed_missing']]);
  assert.equal(src('series:Retired').length, 0);

  assert.deepEqual(f.launch && [f.launch.status, f.launch.botState?.state], ['running', 'no_access']);
  assert.equal(f.planned.length, 2, 'planned content slots of today and tomorrow, this resource only');
  assert.deepEqual(f.planned[0].sourceHints, ['library:fx072_tips']);
  assert.equal(f.planned[0].seriesName, 'Tip of the day');
  assert.deepEqual(f.slots24h.map((s) => [s.status, s.verdict]).sort(), [['failed', null], ['shadowed', 'pass'], ['skipped', 'revise']]);
  assert.equal(f.slots24h.find((s) => s.status === 'skipped')?.error, 'no_fresh_item: fx072_tips');

  // The conflict input is built as ConfigConflictsService.forAgent does: this channel and its group.
  assert.deepEqual(f.conflictInput.resources.map((r) => r.ref).sort(), [REF, SIBREF].sort());
  const own = f.conflictInput.resources.find((r) => r.ref === REF)!;
  assert.equal(own.hashtagMin, 1);
  assert.equal(own.slang, true);
  assert.equal(f.conflictInput.resources.find((r) => r.ref === SIBREF)?.slang, true);
  assert.equal(f.conflictInput.playbook, f.playbook?.body);
});

test('073 × 072 seams (S4): the resources carry what the skeleton check needs; the slot context is read once per series, read-only', { skip }, async () => {
  const calls: Array<{ series: string | null; ref: string | null }> = [];
  const ctx = { series: [], catalog: null, tools: null };
  const f = await loadChannelFacts(pool, CH, {
    env: () => undefined,
    slotConfigContext: async (_card, slot) => { calls.push({ series: slot.seriesName ?? null, ref: slot.resourceRef ?? null }); return ctx; },
  });
  const own = f.resources.find((r) => r.ref === REF)!;
  assert.ok(own.formats?.includes('text'), 'producible formats from skeletonResourcesOf');
  assert.equal(own.tz, 'Europe/Kyiv');
  assert.deepEqual(calls, [{ series: 'Tip of the day', ref: REF }], 'one read for the one series planned; a slot with no series is not read');
  assert.equal(f.planned.find((p) => p.seriesName === 'Tip of the day')?.configCtx, ctx);
  assert.equal(f.planned.find((p) => !p.seriesName)?.configCtx, undefined);
  const failing = await loadChannelFacts(pool, CH, { slotConfigContext: async () => { throw new Error('boom'); } });
  assert.equal(failing.planned.find((p) => p.seriesName === 'Tip of the day')?.configCtx, null, 'a failed read is no context: the seam skips the slot');
  const plain = await loadChannelFacts(pool, CH);
  assert.ok(plain.planned.every((p) => p.configCtx === undefined));
});

test('076 × 072 seams (S10): the stored probe, the host\'s last success, the card source id, the proxy and an uploaded import', { skip }, async () => {
  const before = await loadChannelFacts(pool, CH);
  const feed = before.sources.find((s) => s.origin === 'card' && s.kind === 'rss')!;
  assert.equal(feed.probe, null, 'never probed');
  assert.equal(feed.id, 'feed1');
  assert.equal(before.sources.find((s) => s.kind === 'library')!.probe, undefined, 'a library source is never read from the server');
  assert.equal(before.proxyConfigured, false);

  await new PgSourceProbes(pool).put({
    url: RSS, ok: false, failure_class: 'timeout', status: null, kind: 'rss', feed_url: null, items: 0, newest_at: null, sample_titles: [],
    detail: 'timed out after 15 s', ms: 15000, via_proxy: false, checked_at: new Date(Date.now() - 3_600_000).toISOString(),
  } as any);
  await pool.query(`UPDATE source_host_failures SET last_success_at = now() - interval '2 hours' WHERE host = 'feeds.fx072.example'`);
  const { rows: [tips] } = await pool.query(`SELECT id, version FROM data_schemas WHERE key = 'fx072_tips'`);
  const { rows: [imp] } = await pool.query(
    `INSERT INTO data_imports (schema_id, schema_version, source, options, status) VALUES ($1, $2, 'pipeline', $3::jsonb, 'committed') RETURNING id`,
    [tips.id, tips.version, JSON.stringify({ list_import: { url: 'https://x.example/page', uploaded: true, auto_resync: false } })]);
  try {
    const f = await loadChannelFacts(pool, CH, { env: (k) => (k === 'EGRESS_PROXY_URL' ? 'http://proxy.example:3128' : undefined) });
    const card = f.sources.find((s) => s.origin === 'card' && s.kind === 'rss')!;
    assert.equal(card.probe?.ok, false);
    assert.equal(card.probe?.failure_class, 'timeout');
    assert.equal(card.probe?.detail, 'timed out after 15 s');
    assert.ok(card.lastSuccessAt && Date.now() - Date.parse(card.lastSuccessAt) < 3 * 3_600_000);
    assert.equal(f.sources.find((s) => s.origin === 'series:Feed digest')!.probe?.failure_class, 'timeout', 'the series feed is the same address');
    assert.equal(f.proxyConfigured, true);
    assert.equal(f.datasets.find((d) => d.key === 'fx072_tips')?.uploaded, true);
    assert.equal(f.datasets.find((d) => d.key === 'fx072_aft')?.uploaded, undefined);
  } finally {
    await pool.query(`DELETE FROM data_imports WHERE id = $1`, [imp.id]);
    await pool.query(`DELETE FROM source_probes`);
    await pool.query(`UPDATE source_host_failures SET last_success_at = NULL`);
  }
});

test('loading changes nothing: every table it reads is byte-for-byte the same', { skip }, async () => {
  const before = await snapshot();
  await loadChannelFacts(pool, CH);
  await loadChannelFacts(pool, CH.toUpperCase());
  assert.deepEqual(await snapshot(), before);
});

test('a cycle dataset with no unused rows is not rolled: data_reuse_rounds stays empty', { skip }, async () => {
  const f = await loadChannelFacts(pool, CH);
  const cyc = f.datasets.find((d) => d.key === 'fx072_cyc')!;
  assert.deepEqual([cyc.rows, cyc.notPostable, cyc.unusedPostable], [3, 0, 0]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_reuse_rounds`)).rows[0].n, 0);
});

test('an after_days 30 row used 40 days ago counts as unused again, one used 10 days ago does not (A21)', { skip }, async () => {
  const aft = (await loadChannelFacts(pool, CH)).datasets.find((d) => d.key === 'fx072_aft')!;
  assert.deepEqual([aft.rows, aft.unusedPostable], [3, 2], 'a0 (40 days) and a2 (never) are open; a1 (10 days) is not');
  assert.equal(aft.used28, 1, 'the 28-day ledger count is only the 10-day-old use');
});

test('@X resolves to the stored spelling; an unknown channel is channel_not_found', { skip }, async () => {
  const f = await loadChannelFacts(pool, '@FX072PG');
  assert.equal(f.channelKey, CH);
  assert.equal(f.resourceRef, REF);
  assert.ok(f.agent, 'the agent is found by the stored ref');
  await assert.rejects(() => loadChannelFacts(pool, '@fx072pg_nope'), (e: unknown) => e instanceof ChannelNotFound && (e as ChannelNotFound).code === 'channel_not_found');
});

test('the config hash is stable between loads, follows configuration and ignores pauses, counts and ledger use', { skip }, async () => {
  const h0 = configHash(await loadChannelFacts(pool, CH));
  assert.equal(configHash(await loadChannelFacts(pool, CH)), h0);
  assert.equal(configHash(await loadChannelFacts(pool, '@FX072PG')), h0);

  await pool.query(`INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak) VALUES ($1, 'series:Feed digest', 'Feed digest', 'owner', 'x', 0)`, [CH]);
  await new ContentLedger(pool).record(`data://fx072_tips/${ids.fx072_tips.t6}`, { resourceRef: REF, origin: 'editor', status: 'published', usedAt: new Date() });
  assert.equal(configHash(await loadChannelFacts(pool, CH)), h0, 'pauses and counts are not configuration');

  await pool.query(`UPDATE agent_skills SET enabled = false WHERE agent_id = $1 AND skill_id = (SELECT id FROM skills WHERE name = 'fx-style')`, [execId]);
  const h1 = configHash(await loadChannelFacts(pool, CH));
  assert.notEqual(h1, h0, 'a skill toggle changes it');
  await pool.query(`UPDATE data_schemas SET post_requires = '[["text"],["code"]]'::jsonb WHERE key = 'fx072_tips'`);
  assert.notEqual(configHash(await loadChannelFacts(pool, CH)), h1, 'post_requires changes it');
  await pool.query(`UPDATE data_schemas SET post_requires = '[["text"]]'::jsonb WHERE key = 'fx072_tips'`);
  await pool.query(`UPDATE agent_skills SET enabled = true WHERE agent_id = $1 AND skill_id = (SELECT id FROM skills WHERE name = 'fx-style')`, [execId]);
  await pool.query(`DELETE FROM series_pauses WHERE series_key = 'series:Feed digest' AND channel_key = $1`, [CH]);
});

test('one call is a fixed number of queries: more rows of every kind add none', { skip }, async () => {
  const first = counting(pool);
  await loadChannelFacts(first.pool, CH);
  const memory = new EditorMemoryRepository(pool);
  for (let i = 0; i < 5; i++) await memory.add(CH, 'rule', `Extra rule ${i}`, null, 'owner');
  for (let i = 0; i < 4; i++) await pool.query(`INSERT INTO schedule_rules (agent_id, resource_ref, kind, at_local, format) VALUES ($1, $2, 'pin', $3, 'text')`, [orchId, REF, `0${i}:30`]);
  for (let i = 0; i < 6; i++) {
    await pool.query(`INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, resource_ref) VALUES ($1, $2, now() + ($3 || ' minutes')::interval, 'text', 'More', 'planned', $4)`, [planId, CH, String(10 + i), REF]);
  }
  const more = new SkillStore(pool);
  for (let i = 0; i < 3; i++) await more.writeAgentSkill({ agentId: execId, name: `fx-more-${i}`, description: 'Ще один скіл для каналу', appliesTo: ['executor'], body: 'Пиши коротко.', author: 'owner' });
  await new SeriesPausesRepository(pool).insertOpen({ channelKey: CH, key: 'series:Feed digest', label: 'Feed digest', cause: 'no_material', reason: 'x', streak: 3 });
  const second = counting(pool);
  const f = await loadChannelFacts(second.pool, CH);
  assert.equal(second.count(), first.count(), `${first.count()} queries before, ${second.count()} after`);
  assert.ok(first.count() <= 40, `${first.count()} queries`);
  assert.equal(f.rules.length, 6);
  assert.equal(f.pins.length, 6);
  assert.equal(f.planned.length, 8);
  assert.equal(f.skills.length, 5);
});

test('control: buildCatalog, which loadChannelFacts must not call, does roll the used-up cycle dataset', { skip }, async () => {
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_reuse_rounds`)).rows[0].n, 0);
  await buildCatalog(pool, { resource: REF, today: { month: 10, day: 20 } } as any);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM data_reuse_rounds`)).rows[0].n, 1, 'the catalog starts the next round: a write');
});
