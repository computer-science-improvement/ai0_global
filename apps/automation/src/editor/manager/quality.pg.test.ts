/**
 * Spec 034 FR-006 (T4) on a throwaway Postgres with every migration applied: the digest's quality block from real
 * slots (critic verdicts, polls over the cap, reader questions, owner rejections and edits with the memory note,
 * samples), the hash changing on a new owner rejection, migration 071 (re-apply, the widened kind CHECK), a
 * voice_fix advice filed → accepted → applied as a playbook version by the directive (re-apply no-op) quoting a
 * real rejected post, format_mix caps through the resource profile (raising refused), submit_review storing the
 * quality_check, and get_network_posts returning the post text. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { ResourceProfilesRepository } from '../agents/resource-profile';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema } from '../network/playbook';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { buildPlatformTools } from '../platform/platform-tools';
import { DirectivesRepository } from './directives.repository';
import { KpiDigestService } from './kpi-digest.service';
import { buildDirectiveTools, fileDirective } from './directive-tools';
import { SqlQuality } from './quality-digest';
import { DirectiveExecution, executionContextOf, formatMixExecutor, SqlPlanObserver, voiceFixExecutor, type FormatMixChange, type VoiceFixChange } from './executors';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt034q_space';
const REF = `telegram:${CH}`;
const HANDLE = 'pgt034q_orch';
const MIGRATION = join(__dirname, '../../../../../database/migrations/071_manager_quality.sql');
let pool: Pool;
let orchId: string;
let planId: string;
const slot: Record<string, string> = {};

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1, photo: 0.6, poll: 0.5 }, per_day: { min: 2, max: 5 } }],
  rules: ['Без реклами казино'],
});
const REJECTED_TEXT = 'Друзі, давайте розберемося, чому ця новина змінить усе! А ви як думаєте?';

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM manager_reviews WHERE summary LIKE 'pgt034q%'`);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

async function addSlot(key: string, o: { hoursAgo: number; format?: string; status: string; text?: string; critic?: unknown; error?: string; approved?: boolean; edited?: boolean; reason?: string }) {
  const spec = o.text ? { format: o.format ?? 'text', body: [{ type: 'p', text: o.text }] } : null;
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec, rendered_preview, critic, error,
                               approved_at, approved_by, owner_edited, reject_reason, updated_at)
     VALUES ($1, $2, now() - ($3 || ' hours')::interval, $4, 'Тема', $5, $6, $7, $8, $9,
             CASE WHEN $10 THEN now() - ($3 || ' hours')::interval END, CASE WHEN $10 THEN 'owner' END, $11, $12, LEAST(now(), now() - ($3 || ' hours')::interval))
     RETURNING id`,
    [planId, CH, String(o.hoursAgo), o.format ?? 'text', o.status, spec ? JSON.stringify(spec) : null, o.text ?? null,
      o.critic ? JSON.stringify(o.critic) : null, o.error ?? null, !!o.approved, !!o.edited, o.reason ?? null]);
  slot[key] = rows[0].id;
  return rows[0].id as string;
}

const critic = (verdict: string, notes: string, extra: Record<string, unknown> = {}) =>
  ({ verdict, notes, reason: 'r', pass: 1, scores: { ai_likeness: verdict === 'pass' ? 4 : 2, sense: 4, voice: 3, grounding: 5, audience_asks: 4, format_fit: 4 }, at: new Date().toISOString(), ...extra });

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  orchId = (await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: REF, name: 'Q', handle: HANDLE, mode: 'live', createdBy: 'owner' })).id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'approve', '{"text":1,"photo":0.6,"poll":0.5}')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId: orchId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'owner' });
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, current_date) RETURNING id`, [CH])).rows[0].id;
  await addSlot('pass1', { hoursAgo: 30, status: 'published', text: 'NASA показала нові знімки туманності Карина.', critic: critic('pass', '') });
  await addSlot('pass2', { hoursAgo: 28, status: 'published', format: 'photo', text: 'Телескоп Вебба зафіксував нову зорю.', critic: critic('pass', '', { history: [{ verdict: 'revise', notes: 'Штампи у вступі', pass: 1 }] }) });
  await addSlot('reject', { hoursAgo: 26, status: 'skipped', error: 'critic_rejected: reject (sense 1): безглуздо', text: 'Космос — це як піца, лол.', critic: critic('reject', 'Безглуздий текст, жарт при вимкненому гуморі') });
  await addSlot('poll1', { hoursAgo: 24, status: 'published', format: 'poll', text: 'Опитування тижня', critic: critic('pass', '') });
  await addSlot('poll2', { hoursAgo: 20, status: 'published', format: 'poll', text: 'Ще одне опитування', critic: critic('pass', '') });
  await addSlot('owner_rej', { hoursAgo: 10, status: 'skipped', error: 'rejected by owner', reason: 'Штампи і зайве питання до читачів', text: REJECTED_TEXT, critic: critic('pass', '') });
  await addSlot('edited', { hoursAgo: 8, status: 'published', approved: true, edited: true, text: 'Відредагований власником пост про Марс.', critic: critic('pass', '') });
  await pool.query(`INSERT INTO editor_channel_memory (channel_key, kind, text, evidence, created_by) VALUES ($1, 'rule', $2, $3, 'owner')`,
    [CH, 'Власник відредагував пост «Марс» перед апрувом: прибрав: «Друзі, давайте розберемося»', JSON.stringify({ source: 'approval', action: 'edit', slotId: slot.edited, resourceRef: null, topic: 'Марс' })]);
  await addSlot('waiting', { hoursAgo: -3, status: 'awaiting_approval', text: 'Нова місія до Європи. А ви б полетіли? Як думаєте, вона знайде життя?', critic: critic('revise', 'Два питання до читачів при ліміті 1', { final: true }) });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const catalog = { list: async () => [{ ref: REF, platform: 'telegram' as const, title: 'Q', username: 'pgt034q_space', followers: null, groupId: null, groupName: null, agent: HANDLE }] };

test('digest quality block from real slots; a new owner rejection changes the hash', { skip }, async () => {
  const digest = new KpiDigestService({ pool, catalog, globalCapUsd: 3 });
  const dg = await digest.build();
  const q = dg.resources.find((r) => r.ref === REF)!.quality!;
  assert.ok(q, 'quality block present');
  assert.deepEqual([q.critic.pass, q.critic.revise, q.critic.reject, q.critic.revised_then_passed], [6, 1, 1, 1]);
  assert.equal(q.critic.pass_rate, 0.75);
  assert.match(q.critic.notes.join(' | '), /Два питання до читачів/);
  assert.match(q.critic.notes.join(' | '), /Безглуздий текст/);
  assert.deepEqual([q.polls.count, q.polls.cap, q.polls.over], [2, 1, true]);
  assert.equal(q.reader_questions.over_cap, 1, 'the waiting post with two reader questions');
  assert.deepEqual([q.owner.rejected, q.owner.edited], [1, 1]);
  assert.deepEqual(q.owner.reasons, ['Штампи і зайве питання до читачів']);
  assert.match(q.owner.edits[0], /прибрав: «Друзі/);
  assert.equal(q.samples.length, 3);
  assert.equal(q.samples[0].status, 'awaiting_approval', 'the newest written post first');
  for (const f of ['critic_reject', 'polls_over_cap', 'reader_questions_over_cap', 'owner_rejections', 'owner_edits']) assert.ok(q.flags.includes(f as any), f);
  assert.ok(digest.render(dg).includes('"quality"'));

  await addSlot('owner_rej2', { hoursAgo: 1, status: 'skipped', error: 'rejected by owner', reason: 'Нудно', text: 'Ще один пост, який власник відхилив.' });
  const dg2 = await digest.build();
  assert.notEqual(dg2.hash, dg.hash, 'a new owner rejection is never skipped');
  const dg3 = await digest.build();
  assert.equal(dg3.hash, dg2.hash, 'stable without changes');
});

test('migration 071: re-apply is a no-op; the kind CHECK allows voice_fix / format_mix and still refuses unknown kinds', { skip }, async () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  await pool.query(sql);
  await pool.query(sql);
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = 'agent_directives'::regclass AND c.contype = 'c' AND a.attname = 'kind'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].def, /voice_fix/);
  assert.match(rows[0].def, /strategy/);
  await assert.rejects(pool.query(
    `INSERT INTO agent_directives (to_agent_id, kind, body, rationale) VALUES ($1, 'nonsense', 'b', 'r')`, [orchId]), /check constraint/);
  const { rows: cols } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'manager_reviews' AND column_name = 'quality_check'`);
  assert.equal(cols.length, 1);
});

function setup() {
  const repo = new DirectivesRepository(pool);
  const agents = new AgentsRepository(pool);
  const inbox = new OwnerInbox(pool as any, async () => {});
  const network = new NetworkRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const profiles = new ResourceProfilesRepository(pool);
  const quality = new SqlQuality(pool);
  const qdeps = { network, channels, profiles, quality, observer: new SqlPlanObserver(pool) };
  const exec = new DirectiveExecution({
    repo, inbox, agents,
    context: executionContextOf({ repo: network, channels, evidence: (refs, since) => quality.evidencePosts(refs, since), audience: (refs) => quality.audience(refs) }),
    executors: [voiceFixExecutor(qdeps), formatMixExecutor(qdeps)],
  });
  const digest = new KpiDigestService({ pool, catalog, globalCapUsd: 3 });
  const deps = {
    repo, agents, digest, inbox, memory: { listActive: async () => [] }, actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => CH, exec,
  };
  return { repo, network, profiles, exec, digest, deps, agents };
}

test('voice_fix: advice quoting a real rejected post → accepted → a playbook version by the directive; re-apply no-op', { skip }, async () => {
  const s = setup();
  const dg = await s.digest.build();
  const filed: any = await fileDirective(s.deps as any, {
    to: `@${HANDLE}`, kind: 'voice_fix', binding: 'advice', body: 'Прибрати штампи й зайві питання до читачів у постах',
    params: { resource_ref: REF, rules: ['Без звертань «друзі» і без «давайте розберемося»'], bad_slot_ids: [slot.owner_rej] },
    rationale: 'Власник відхилив пост через штампи, критик відхилив 1 з 8 постів', evidence: { owner_rejected: 1, critic_reject: 1 },
    expected: { metric: 'owner_rejection_rate', direction: 'down', min_change_pct: 30, resource_ref: REF }, review_in_days: 7,
  }, { from: null, runId: null, shadow: false, digest: dg });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  assert.equal(filed.directive.status, 'new');
  assert.equal(filed.directive.structural, false);
  assert.match(filed.directive.outcomeDetail.dry_run.change, /voice rule/);
  assert.ok(filed.directive.outcomeDetail.at_filing.value > 0, 'owner rejection rate at filing');

  await s.repo.update(filed.directive.id, { status: 'accepted', resolution: 'Додам правило' }, ['new']);
  const orch = (await s.agents.get(orchId))!;
  const done = await s.exec.execute((await s.repo.get(filed.directive.id))!, orch);
  assert.equal(done?.status, 'applied', JSON.stringify(done?.execError));
  const pb = (await s.network.activePlaybook(orchId))!;
  assert.equal(pb.createdBy, 'directive');
  assert.equal(pb.directiveId, filed.directive.id);
  assert.ok(pb.body.rules.some((r) => r.includes('давайте розберемося')));
  assert.ok(pb.body.rules.includes('Без реклами казино'));
  const bad = pb.body.examples.find((e) => e.verdict === 'bad')!;
  assert.equal(bad.text, REJECTED_TEXT, 'the real post text');
  assert.match(bad.note!, /Власник відхилив: Штампи і зайве питання/);
  const change = done!.change as VoiceFixChange;
  const again = await voiceFixExecutor({ network: s.network } as any).apply(change, done!);
  assert.equal(again.noop, true);
  assert.equal((await s.network.activePlaybook(orchId))!.version, pb.version, 'no new version on re-apply');
});

test('format_mix: lowering the poll cap writes the profile as an agent change; raising is refused at plan and by the profile', { skip }, async () => {
  const s = setup();
  const orch = (await s.agents.get(orchId))!;
  const raise = await s.exec.dryRun({ kind: 'format_mix', params: { polls_per_week: 3 }, toAgentId: orchId }, orch);
  assert.match((raise as any).details, /лише власник/);
  const plan = await s.exec.dryRun({ kind: 'format_mix', params: { resource_ref: REF, polls_per_week: 0, weights: { poll: 0.2 } }, toAgentId: orchId }, orch) as FormatMixChange;
  assert.deepEqual([plan.target, plan.structural, plan.caps.polls_per_week], ['playbook', false, { before: 1, after: 0 }]);
  const row = await s.repo.insert({
    fromAgentId: null, toAgentId: orchId, kind: 'format_mix', binding: 'advice', structural: false, body: 'Менше опитувань', params: { resource_ref: REF, polls_per_week: 0, weights: { poll: 0.2 } },
    rationale: 'Опитувань 2 при ліміті 1', evidence: { polls: 2 }, expected: { metric: 'poll_share', direction: 'down', min_change_pct: 30 }, reviewAt: null, status: 'new', shadow: false,
  });
  await s.repo.update(row.id, { status: 'accepted' }, ['new']);
  const done = await s.exec.execute((await s.repo.get(row.id))!, orch);
  assert.equal(done?.status, 'applied', JSON.stringify(done?.execError));
  assert.equal((await s.profiles.capsOf(REF)).pollsPerWeek, 0);
  const versions = await s.profiles.history([REF]);
  assert.equal(versions[0].changedBy, 'agent');
  assert.equal((await s.network.activePlaybook(orchId))!.body.platforms[0].formats.poll, 0.2);
  // The repository refuses an agent raise even if a change got past the plan.
  const forced = await s.profiles.patchFormat(REF, { polls_per_week: 5 }, { by: 'agent', agentId: orchId });
  assert.equal((forced as any).error, 'owner_only');
});

test('submit_review stores the quality_check; get_network_posts returns the text the agent wrote', { skip }, async () => {
  const s = setup();
  const dg = await s.digest.build();
  const tools = buildDirectiveTools(s.deps as any);
  const submit = tools.find((t) => t.name === 'submit_review')!;
  const ctx = { runId: 'r', role: 'manager' as const, channelKey: null, extras: { digest: dg } } as any;
  const refused: any = await submit.execute(submit.input.parse({ verdict: 'continue', summary: 'pgt034q nothing', quality_check: [] }), ctx);
  assert.equal(refused.error, 'quality_check_missing');
  const ok: any = await submit.execute(submit.input.parse({
    verdict: 'continue', summary: 'pgt034q checked',
    quality_check: [{ resource_ref: REF, status: 'issue', evidence: 'pass rate 75%, 2 опитування при ліміті 1', issues: ['audience_asks'], note: 'порада format_mix уже прийнята й застосована' }],
  }), ctx);
  assert.equal(ok.ok, true);
  const { rows } = await pool.query(`SELECT quality_check, digest_hash FROM manager_reviews WHERE summary = 'pgt034q checked'`);
  assert.equal(rows[0].quality_check[0].status, 'issue');
  assert.equal(rows[0].digest_hash, dg.hash);

  await pool.query(`INSERT INTO published_posts (channel_id, message_id, title, format, editor_slot_id) VALUES ($1, 9001, 'Заголовок', 'text', $2)`, [CH, slot.pass1]);
  const posts = buildPlatformTools({ pool, publish: {} as any, plans: {} as any }).find((t) => t.name === 'get_network_posts')!;
  const out: any = await posts.execute(posts.input.parse({ resource: REF, days: 7 }), { runId: 'r', role: 'manager', channelKey: null } as any);
  const p = out.posts.find((x: any) => x.excerpt === 'Заголовок');
  assert.equal(p.text, 'NASA показала нові знімки туманності Карина.');
});
