/**
 * Spec 069 FR-002 on a real database: «бери з X, не бери Y» as one card. `import_list` with `series`, `stop_using` and
 * `disable_skills` proposes one card; Apply imports the list, binds the series to the new dataset as its required
 * source (an owner version of the playbook), stores the rule and switches the old skill off. The page comes from an
 * injected getter — no network. Creates its own database next to EDITOR_PG_TEST_URL (init.sql + every migration) and
 * drops it. Skipped unless EDITOR_PG_TEST_URL is set (needs CREATEDB).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { applyOwnerRule } from '../agents/agent-chat-tools';
import { PendingActionsRepository, PendingActionsService } from '../agents/pending-actions';
import { SkillStore } from '../agents/skill-store';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { NetworkRepository } from '../network/network.repository';
import { normalizePlaybook, seriesSourceCatalog } from '../network/series-edit';
import { PlaybookSchema } from '../network/playbook';
import { ScheduleRepository } from '../schedule/schedule.repository';
import { ScheduleService } from '../schedule/schedule.service';
import { registerScheduleActions } from '../schedule/schedule-tools';
import { SeriesPauseActions } from '../series-pause/pause-actions';
import { registerPauseResumeAction } from '../series-pause/pause-resume-action';
import { SeriesPausesRepository } from '../series-pause/series-pauses.repository';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { ImportListInput } from './import-list';
import { buildImportListTools, importActionHandlers } from './import-list-tools';
import { NANOBANANA_README, NANOBANANA_URL } from './testing/nanobanana-fixture';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt069_global';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt069_global';
const NOW = new Date('2030-01-15T06:00:00Z');
const MAPPING = { title: 'heading', prompt_text: 'first_code_block', media_url: 'last_image', author: 'link_text_after:Source', source_url: 'last_link_after:Source' };
const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{ name: 'Prompt of the day', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'A prompt with its picture each evening' }],
});

let db: FreshDb;
let pool: FreshDb['pool'];
let orchId: string;
const OWNER = 'Бери промпти з awesome-nanobanana-pro. Промпти з PromptHero більше не бери.';

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'b069');
  pool = db.pool;
  orchId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Global', $2, 'approve') RETURNING id`, [TG, HANDLE])).rows[0].id;
  await pool.query(`INSERT INTO agents (kind, scope, scope_id, name, handle, mode, parent_id) VALUES ('executor', 'resource', $1, 'Exec', $2, 'approve', $3)`, [TG, `${HANDLE}_exec`, orchId]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'approve', '{"photo":1,"text":1}')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId: orchId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'orchestrator' });
  const r = await new SkillStore(pool).writeAgentSkill({
    agentId: orchId, name: 'prompthero-filter', description: 'Take prompts from PromptHero only', appliesTo: ['executor', 'composer'],
    body: '# Фільтр\nПромпти для постів — лише від одного постачальника; решту ігноруй.', author: 'owner',
  });
  assert.ok(!('error' in r), JSON.stringify(r));
});
after(async () => { if (db) await db.drop(); });

function setup() {
  const agents = new AgentsRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const skills = new SkillStore(pool);
  const memory = new EditorMemoryRepository(pool);
  const schedule = new ScheduleService({
    pool, rules: new ScheduleRepository(pool), network: new NetworkRepository(pool), agents, card: (k) => channels.get(k),
    plans: new EditorPlansRepository(pool), inbox: new OwnerInbox(pool, async () => {}),
    time: { tzOf: async () => 'Europe/Kyiv', quietOf: async () => ({ start: 23, end: 8 }) },
    sourceCatalog: (card) => seriesSourceCatalog(pool, card), now: () => NOW,
  });
  const actions = new PendingActionsService(new PendingActionsRepository(pool));
  const docs = new DocStore();
  const http = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], get: async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, data: NANOBANANA_README }) };
  for (const [kind, handler] of Object.entries(importActionHandlers({ pool, docs, http: http as any }))) actions.register(kind, handler);
  registerScheduleActions(actions, schedule);
  const pauses = new SeriesPausesRepository(pool);
  registerPauseResumeAction(actions, { pauses: new SeriesPauseActions({ pool, repo: pauses }), schedule });
  actions.register('owner_rule', (p) => applyOwnerRule(memory, p));
  // The detach card's handler of the module: AgentsService.patchSkill (the agent's own skill first, else the shared one).
  actions.register('detach_skill', async (p) => {
    const a = (await agents.getByHandle(String(p.handle)))!;
    const s = (await skills.findForAgent(a.id, String(p.skill))) ?? (await skills.findShared(String(p.skill)));
    if (!s) throw new Error('skill_not_found');
    await skills.setToggle(a.id, s.id, { enabled: false });
    return { ok: true };
  });
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs, actions, http: http as any, schedule, agents, skills, handles: async () => (await agents.list()).map((a) => a.handle), pauses,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const ctx = async (): Promise<any> => ({
    runId: 'r', role: 'composer', channelKey: null,
    extras: { chat: { chatId: null, channelKey: CH }, agentIntent: true, ownerText: OWNER, ownerRecent: [OWNER], agent: await agents.get(orchId) },
  });
  return { actions, tools, ctx, docs, http, skills, agents };
}

async function propose(s: ReturnType<typeof setup>, extra: Record<string, unknown>) {
  const doc: any = (await fetchDocument(NANOBANANA_URL, { docs: s.docs, http: s.http as any })) as any;
  return s.tools.import_list.execute(ImportListInput.parse({
    doc_id: doc.doc.id, dataset: 'nanobanana_pg069', mapping: MAPPING, filter: { has_code_block: true }, title: 'Nano prompts', ...extra,
  }), await s.ctx());
}

test('the bundle card: Apply imports, binds the series as a required source, stores the rule, switches the old skill off', { skip }, async () => {
  const s = setup();
  const out = await propose(s, { series: 'Prompt of the day', stop_using: 'Не бери промпти з PromptHero', disable_skills: ['prompthero-filter'] });
  assert.equal(out.ok, true, JSON.stringify(out));
  // Nothing is written by the proposal.
  assert.equal((await pool.query(`SELECT 1 FROM data_schemas WHERE key = 'nanobanana_pg069'`)).rowCount, 0);

  const card = await s.actions.apply(out.pending_action);
  assert.equal(card.status, 'applied', card.error ?? '');
  const res = card.result as any;
  assert.ok(res.inserted > 0);
  assert.deepEqual(res.then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['series', true, null], ['rule', true, null], ['detach:prompthero-filter', true, null]]);

  const n = (await pool.query(`SELECT count(*)::int AS n FROM data_items i JOIN data_schemas s ON s.id = i.schema_id WHERE s.key = 'nanobanana_pg069'`)).rows[0].n;
  assert.equal(n, res.inserted + res.updated);

  const pb = normalizePlaybook((await new NetworkRepository(pool).activePlaybook(orchId))!.body);
  const series = pb.series.find((x) => x.name === 'Prompt of the day')!;
  assert.deepEqual(series.source, { kind: 'library', table: 'nanobanana_pg069' });
  assert.equal(series.source_mode, 'required');
  assert.equal(series.locked, true, 'the owner\'s change locks the series');

  const rule = (await pool.query(`SELECT kind, text, created_by FROM editor_channel_memory WHERE channel_key = $1 AND active`, [CH])).rows;
  assert.deepEqual(rule.map((r) => [r.kind, r.text, r.created_by]), [['avoid', 'Не бери промпти з PromptHero', 'owner']]);

  const entries = await s.skills.listForAgent([orchId]);
  assert.equal(entries.find((e) => e.skill.name === 'prompthero-filter')?.enabled, false);
});

// ── Wave fix 068 × 069: the breaker paused the series (and the channel); the card that rebinds the series resumes it ──────

const SERIES = 'Resume me';
async function pauseRows() {
  return (await pool.query(`SELECT series_key, resumed_at IS NOT NULL AS resumed, resumed_by FROM series_pauses WHERE channel_key = $1 ORDER BY series_key, paused_at`, [CH])).rows;
}
async function seed() {
  // A second series on the playbook (the first test bound 'Prompt of the day' already), and the two pauses a dead source leaves behind.
  const repo = new NetworkRepository(pool);
  const active = (await repo.activePlaybook(orchId))!;
  const body = normalizePlaybook(active.body);
  if (!body.series.some((x) => x.name === SERIES)) {
    await repo.insertPlaybook({
      agentId: orchId, status: 'active', brief: null, createdBy: 'owner', rationale: 'seed 2',
      body: PlaybookSchema.parse({ ...body, series: [...body.series, { name: SERIES, cadence: 'daily@12:00', resource_ref: TG, format: 'photo', brief: 'Another prompt a day' }] }),
    });
  }
  await pool.query(`DELETE FROM series_pauses WHERE channel_key = $1`, [CH]);
  await pool.query(
    `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak) VALUES
       ($1, $2, $3, 'no_material', 'preflight_no_material: рядок data://prompts/12 без prompt_text', 3),
       ($1, $4, $5, 'no_material', 'three dead days', 3)`,
    [CH, `series:${SERIES}`, SERIES, `resource:${TG}`, TG]);
}

test('a paused series: the card offers Resume (ticked) and the channel (unticked); Apply imports, binds the series and resumes it, the channel stays paused', { skip }, async () => {
  await seed();
  const s = setup();
  const out = await propose(s, { dataset: 'resume_a_pg069', series: SERIES });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.follow_ups.map((f: any) => [f.key, f.ticked]), [['series', true], ['resume', true], ['resume_channel', false]]);
  assert.match(out.follow_ups[1].summary, /^Resume series "Resume me" on @pgt069_global \(paused: no material to post from: preflight_no_material/);
  // Nothing is lifted by the proposal.
  assert.deepEqual((await pauseRows()).map((r) => [r.series_key, r.resumed]), [[`resource:${TG}`, false], [`series:${SERIES}`, false]]);

  const card = await s.actions.apply(out.pending_action);
  assert.equal(card.status, 'applied', card.error ?? '');
  assert.deepEqual((card.result as any).then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['series', true, null], ['resume', true, null], ['resume_channel', false, 'not_ticked']]);
  assert.deepEqual((await pauseRows()).map((r) => [r.series_key, r.resumed, r.resumed_by]), [[`resource:${TG}`, false, null], [`series:${SERIES}`, true, 'owner']]);
  const pb = normalizePlaybook((await new NetworkRepository(pool).activePlaybook(orchId))!.body);
  assert.deepEqual(pb.series.find((x) => x.name === SERIES)!.source, { kind: 'library', table: 'resume_a_pg069' });
  assert.deepEqual([...await new SeriesPausesRepository(pool).plainPausedChannels()], [CH], 'the channel pause is a suggestion: not lifted unless ticked');
});

test('the owner ticks the channel item: both pauses are lifted and the scheduler plans the channel again', { skip }, async () => {
  await seed();
  const s = setup();
  const out = await propose(s, { dataset: 'resume_b_pg069', series: SERIES });
  const card = await s.actions.apply(out.pending_action, { skip_then: [] });   // the dashboard sends the unticked keys: none
  assert.equal(card.status, 'applied', card.error ?? '');
  assert.deepEqual((card.result as any).then.map((t: any) => [t.key, t.ok]), [['series', true], ['resume', true], ['resume_channel', true]]);
  assert.deepEqual((await pauseRows()).map((r) => r.resumed), [true, true]);
  assert.deepEqual([...await new SeriesPausesRepository(pool).plainPausedChannels()], []);
});

test('an import that adds nothing resumes nothing: the series change and the resume both wait for rows', { skip }, async () => {
  await seed();
  const s = setup();
  const out = await propose(s, { dataset: 'resume_c_pg069', series: SERIES });
  // The page changed between the proposal and Apply: the stored filter now keeps no entry.
  await pool.query(`UPDATE pending_actions SET payload = jsonb_set(payload, '{filter}', '{"heading_matches": "^no such heading$"}') WHERE id = $1`, [out.pending_action]);
  const card = await s.actions.apply(out.pending_action, { skip_then: [] });
  assert.equal(card.status, 'applied', card.error ?? '');
  const res = card.result as any;
  assert.equal(res.inserted + res.updated + res.skipped, 0);
  assert.deepEqual(res.then.map((t: any) => [t.key, t.error ?? null]), [['series', 'import_empty'], ['resume', 'import_empty'], ['resume_channel', 'import_empty']]);
  assert.deepEqual((await pauseRows()).map((r) => r.resumed), [false, false]);
});

test('no pause: the card has no resume item', { skip }, async () => {
  await seed();
  await pool.query(`DELETE FROM series_pauses WHERE channel_key = $1`, [CH]);
  const s = setup();
  const out = await propose(s, { dataset: 'resume_d_pg069', series: SERIES });
  assert.deepEqual(out.follow_ups.map((f: any) => f.key), ['series']);
});
