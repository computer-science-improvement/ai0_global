/**
 * Spec 059 T1 against a throwaway Postgres (its own database): migration 092 (idempotent, the outcome check, the down),
 * a probing version that is stored without going live, adopt / reject, a newer write that abandons a probe, version
 * numbers that are never reused, the KPI rollback restoring the version that was really live, and propose_skill_edit's
 * new return. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { AgentsRepository } from './agents.repository';
import { SkillStore } from './skill-store';
import { OwnerInbox } from './owner-inbox';
import { buildAgentSkillTools } from './agent-skill-tools';
import { SkillVersionEvaluator } from './skill-version-evaluator';
import type { KpiPoint, ScopeKpi } from './scope-kpi';
import { emptyProbe } from './skill-probe.types';
import { SkillLibrary } from '../skills/skill-library';
import { createProbeDb, MIGRATIONS_DIR, type ProbeDb } from './testing/probe-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const UP = () => readFileSync(join(MIGRATIONS_DIR, '092_skill_probe.sql'), 'utf8');
const DOWN = () => readFileSync(join(MIGRATIONS_DIR, 'down', '092_skill_probe.down.sql'), 'utf8');

let db: ProbeDb;
let pool: Pool;
let store: SkillStore;
let agents: AgentsRepository;
let orchId: string;
let reviewer: Awaited<ReturnType<AgentsRepository['insert']>>;
const NOW = new Date('2030-05-06T09:00:00Z');
const DAY = 86_400_000;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'skillprobe');
  pool = db.pool;
  store = new SkillStore(pool);
  agents = new AgentsRepository(pool);
  await store.syncBuiltins(new SkillLibrary());
  const orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@sp_pg', name: 'SP', handle: 'sp_pg', createdBy: 'sync' });
  orchId = orch.id;
  reviewer = await agents.insert({ kind: 'reviewer', scope: 'resource', scopeId: 'telegram:@sp_pg', parentId: orch.id, name: 'SP reviewer', handle: 'sp_pg_reviewer', createdBy: 'sync' });
});
after(async () => { if (db) await db.drop(); });

const write = (o: { name: string; body: string; probing?: boolean; author?: 'agent' | 'owner'; probe?: boolean }) => store.writeAgentSkill({
  agentId: orchId, name: o.name, description: 'Описовий текст скіла для перевірки', appliesTo: ['executor'], body: o.body,
  author: o.author ?? 'agent', authorAgentId: (o.author ?? 'agent') === 'agent' ? reviewer.id : null, reason: 'тест перевірки скіла',
  reviewAt: new Date(NOW.getTime() + 7 * DAY), probing: o.probing, probe: o.probe ? emptyProbe('probing', undefined, NOW) : undefined,
});

const oldEdits = () => pool.query(`UPDATE skill_versions SET created_at = created_at - interval '3 days' WHERE author_agent_id = $1`, [reviewer.id]);

test('092 applies again; the outcome check knows probing and rejected and nothing else; the down restores the four states', { skip }, async () => {
  await pool.query(UP());
  const sk = (await pool.query(`INSERT INTO skills (name, scope, agent_id, description, applies_to, body, created_by) VALUES ('mig-check', 'agent', $1, 'd', '{executor}', 'b', 'agent') RETURNING id`, [orchId])).rows[0].id;
  const ins = (v: number, outcome: string) => pool.query(`INSERT INTO skill_versions (skill_id, version, body, description, author, outcome) VALUES ($1, $2, 'b', 'd', 'agent', $3)`, [sk, v, outcome]);
  await ins(1, 'probing');
  await ins(2, 'rejected');
  await ins(3, 'pending');
  await assert.rejects(ins(4, 'weird'));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '092_skill_probe'`)).rows[0].n, 1);

  await pool.query(DOWN());
  assert.deepEqual((await pool.query(`SELECT outcome FROM skill_versions WHERE skill_id = $1 ORDER BY version`, [sk])).rows.map((r) => r.outcome), ['superseded', 'superseded', 'pending'],
    'a version that never went live becomes superseded');
  await assert.rejects(ins(5, 'probing'));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'skill_versions' AND column_name = 'probe'`)).rows[0].n, 0);
  await pool.query(UP());
  await ins(6, 'probing');
  await pool.query(`DELETE FROM skills WHERE id = $1`, [sk]);
});

test('a probing edit is stored, the old text stays live; adopt switches it and starts the KPI review', { skip }, async () => {
  const v1 = await write({ name: 'probe-live', body: 'Старий текст скіла, що діє зараз.' });
  assert.ok('ok' in v1 && v1.version === 1 && !v1.probing, 'a new skill goes live at once');
  const skillId = (v1 as any).skill.id as string;

  const v2 = await write({ name: 'probe-live', body: 'Новий текст скіла, що ще перевіряється.', probing: true, probe: true });
  assert.ok('ok' in v2 && v2.probing === true && v2.version === 2);
  const live = (await store.get(skillId))!;
  assert.equal(live.body, 'Старий текст скіла, що діє зараз.');
  assert.equal(live.currentVersion, 1);
  const versions = await store.versions(skillId);
  assert.deepEqual(versions.map((v) => [v.version, v.outcome]), [[2, 'probing'], [1, 'pending']]);
  assert.equal(versions[0].probe?.verdict, 'probing');

  // What the agents read, and what the skills tab shows.
  assert.match((await store.resolveForAgent([orchId], 'executor')).get('probe-live')!.body, /^Старий/);
  const entry = (await store.listForAgent([orchId])).find((e) => e.skill.name === 'probe-live')!;
  assert.equal(entry.probing, true);
  assert.equal(entry.pending, true, 'the live version is still under its own review');
  assert.equal((await store.duePending(new Date(NOW.getTime() + 30 * DAY))).filter((d) => d.skillId === skillId).length, 1, 'only the live version has a KPI review');
  assert.deepEqual((await store.probing()).map((p) => [p.skillName, p.version, p.liveVersion]), [['probe-live', 2, 1]]);

  const reviewAt = new Date(NOW.getTime() + 7 * DAY);
  const probe = { ...emptyProbe('adopted', 'new text wins', NOW), costUsd: 0.12 };
  const adopted = await store.adoptVersion(skillId, 2, { from: ['probing'], probe, reviewAt });
  assert.equal(adopted?.body, 'Новий текст скіла, що ще перевіряється.');
  assert.equal(adopted?.currentVersion, 2);
  const after = await store.versions(skillId);
  assert.deepEqual(after.map((v) => [v.version, v.outcome]), [[2, 'pending'], [1, 'superseded']]);
  assert.equal(after[0].probe?.verdict, 'adopted');
  assert.equal(after[0].reviewAt?.toISOString(), reviewAt.toISOString());
  assert.equal(await store.adoptVersion(skillId, 2, { from: ['probing'], probe, reviewAt }), null, 'already decided');
  assert.equal(await store.probesSince(new Date(NOW.getTime() - DAY)), 1);
  assert.equal(await store.probesSince(new Date(NOW.getTime() + DAY)), 0);
  assert.equal((await store.listForAgent([orchId])).find((e) => e.skill.name === 'probe-live')!.probing, false);
});

test('reject keeps the live text; only the newest rejected version can be adopted anyway', { skip }, async () => {
  const v1 = await write({ name: 'probe-rej', body: 'Базовий текст скіла для відхилення.' });
  const skillId = (v1 as any).skill.id as string;
  await write({ name: 'probe-rej', body: 'Погана правка, яку перевірка відхилить.', probing: true, probe: true });
  assert.equal(await store.rejectVersion(skillId, 2, { ...emptyProbe('rejected', 'worse', NOW), costUsd: 0.1 }), true);
  assert.equal(await store.rejectVersion(skillId, 2, emptyProbe('rejected', 'again', NOW)), false, 'decided once');
  assert.equal((await store.get(skillId))!.body, 'Базовий текст скіла для відхилення.');
  assert.deepEqual((await store.versions(skillId)).map((v) => [v.version, v.outcome]), [[2, 'rejected'], [1, 'pending']]);
  assert.equal((await store.listForAgent([orchId])).find((e) => e.skill.name === 'probe-rej')!.probing, false);
  assert.equal((await store.probing()).some((p) => p.skillId === skillId), false);

  // Another proposal on top: the rejected v2 is no longer the newest, so "adopt anyway" is refused for it.
  await write({ name: 'probe-rej', body: 'Друга правка, ще одна спроба агента.', probing: true, probe: true });
  const reviewAt = new Date(NOW.getTime() + 7 * DAY);
  assert.equal(await store.adoptVersion(skillId, 2, { from: ['rejected'], probe: emptyProbe('owner_override', 'owner', NOW), reviewAt }), null);
  // The newest one, rejected as well, can be adopted by the owner.
  assert.equal(await store.rejectVersion(skillId, 3, emptyProbe('rejected', 'worse', NOW)), true);
  const sk = await store.adoptVersion(skillId, 3, { from: ['rejected'], probe: emptyProbe('owner_override', 'owner', NOW), reviewAt });
  assert.equal(sk?.body, 'Друга правка, ще одна спроба агента.');
  assert.deepEqual((await store.versions(skillId)).map((v) => [v.version, v.outcome]), [[3, 'pending'], [2, 'rejected'], [1, 'superseded']]);
});

test('a newer proposal or an owner edit abandons the probe; version numbers are never reused', { skip }, async () => {
  const v1 = await write({ name: 'probe-sup', body: 'Початковий текст скіла для заміни.' });
  const skillId = (v1 as any).skill.id as string;
  await write({ name: 'probe-sup', body: 'Перша пропозиція, яку замінять.', probing: true, probe: true });
  await write({ name: 'probe-sup', body: 'Друга пропозиція, що замінила першу.', probing: true, probe: true });
  assert.deepEqual((await store.versions(skillId)).map((v) => [v.version, v.outcome, v.probe?.verdict]), [[3, 'probing', 'probing'], [2, 'superseded', 'superseded'], [1, 'pending', undefined]]);
  assert.equal(await store.adoptVersion(skillId, 2, { from: ['probing'], probe: emptyProbe('adopted', undefined, NOW), reviewAt: NOW }), null, 'a superseded proposal cannot be adopted');

  // The owner edits: the text goes live as v4, the proposal is dropped.
  const owner = await write({ name: 'probe-sup', body: 'Текст власника, який діє негайно.', author: 'owner' });
  assert.ok('ok' in owner && owner.version === 4 && !owner.probing);
  assert.equal((await store.get(skillId))!.currentVersion, 4);
  assert.deepEqual((await store.versions(skillId)).map((v) => v.outcome), [null, 'superseded', 'superseded', 'superseded']);

  // A rollback after a rejected proposal takes the next free number, not current + 1.
  await write({ name: 'probe-sup', body: 'Ще одна пропозиція агента, не живa.', probing: true, probe: true, author: 'agent' }).catch(() => undefined);
  const rb = await store.rollback(skillId, 1, 'owner', 'back');
  assert.ok('ok' in rb && rb.version === 5, JSON.stringify(rb));
});

test('an override of a shared skill: the row starts as a copy of the shared text, the proposal waits at v2', { skip }, async () => {
  const shared = (await store.findShared('format-hashtags'))!;
  const r = await store.writeAgentSkill({
    agentId: orchId, name: 'format-hashtags', description: shared.description, appliesTo: shared.appliesTo, body: 'Своя версія правил про хештеги.',
    author: 'agent', authorAgentId: reviewer.id, reason: 'тест перевизначення', probing: true, probe: emptyProbe('probing', undefined, NOW),
  });
  assert.ok('ok' in r && r.version === 2 && r.probing);
  const own = (await store.findForAgent(orchId, 'format-hashtags'))!;
  assert.equal(own.body, shared.body, 'what is live is still the shared text');
  assert.match((await store.resolveForAgent([orchId], 'executor')).get('format-hashtags')!.body, new RegExp(shared.body.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual((await store.versions(own.id)).map((v) => [v.version, v.outcome, v.author]), [[2, 'probing', 'agent'], [1, null, 'repo']]);
  assert.equal(await store.rejectVersion(own.id, 2, emptyProbe('rejected', 'worse', NOW)), true);
  assert.equal((await store.findForAgent(orchId, 'format-hashtags'))!.body, shared.body);
  await store.deleteAgentSkill(orchId, 'format-hashtags');
});

test('a probe does not apply to a safety skill, an owner edit or a new skill', { skip }, async () => {
  const safety = await write({ name: 'anti-slop', body: 'Менше заборон, пиши як хочеш і не думай.', probing: true });
  assert.equal((safety as any).error, 'safety_skill');
  const owner = await write({ name: 'probe-owner', body: 'Текст власника для нового скіла.', author: 'owner', probing: true });
  assert.ok('ok' in owner && !owner.probing && owner.version === 1);
  const fresh = await write({ name: 'probe-fresh', body: 'Новий скіл агента, порівнювати нема з чим.', probing: true });
  assert.ok('ok' in fresh && !fresh.probing, 'nothing to compare with: live at once');
});

test('propose_skill_edit: an edit of a live skill returns probing; probes off applies at once with an unprobed record', { skip }, async () => {
  const inbox = new OwnerInbox(pool);
  const kpi: ScopeKpi = { primary: async () => null };
  let enabled = true;
  const [tool] = buildAgentSkillTools({ agents, skills: store, kpi, inbox, now: () => NOW, probe: { enabled: () => enabled, samples: () => 3 } });
  const ctx = { runId: 'r', role: 'reviewer' as const, channelKey: '@sp_pg', extras: { agent: reviewer } };
  await write({ name: 'probe-tool', body: 'Старий текст скіла через інструмент.' });
  await oldEdits(); // the daily limit counts today's edits

  const res: any = await tool.execute({
    skill: 'probe-tool', body: 'Новий текст скіла через інструмент, із правилом.', reason: 'пости з такою правкою мали більше переглядів за 28 днів',
  }, ctx);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.probing, true);
  assert.equal(res.version, 2);
  assert.match(res.message, /перевіряю на 3 недавніх постах/);
  const s = (await store.findForAgent(orchId, 'probe-tool'))!;
  assert.match(s.body, /^Старий/);
  const items = await inbox.list();
  const note = items.find((i) => i.kind === 'skill_self_edit' && /probe-tool/.test(i.title))!;
  assert.match(note.title, /proposed a change to skill "probe-tool" \(v2\), checking it on 3 recent posts/);

  // Probes off: the edit is live at once, the record says why.
  await oldEdits();
  enabled = false;
  const live: any = await tool.execute({
    skill: 'probe-tool', body: 'Третій текст скіла, коли перевірка вимкнена.', reason: 'перевірка вимкнена, правка діє одразу, як раніше',
  }, ctx);
  assert.equal(live.ok, true);
  assert.equal(live.probing, undefined);
  assert.equal(live.review_in_days, 7);
  assert.match((await store.findForAgent(orchId, 'probe-tool'))!.body, /^Третій/);
  const top = (await store.versions(s.id))[0];
  assert.equal(top.outcome, 'pending');
  assert.equal(top.probe?.verdict, 'unprobed');
});

test('the KPI rollback restores the version that was live, not an unadopted proposal', { skip }, async () => {
  const kpiNow: KpiPoint = { metric: 'views_per_post', value7d: 600, baseline28d: 1000, std28d: 80, posts7d: 12, postsBase: 50, at: '' };
  const kpi: ScopeKpi = { primary: async () => kpiNow };
  const v1 = await write({ name: 'probe-kpi', body: 'Перший текст скіла, що був живий.' });
  const skillId = (v1 as any).skill.id as string;
  await write({ name: 'probe-kpi', body: 'Друга версія, відхилена перевіркою.', probing: true, probe: true });
  await store.rejectVersion(skillId, 2, emptyProbe('rejected', 'worse', NOW));
  await write({ name: 'probe-kpi', body: 'Третя версія, прийнята перевіркою.', probing: true, probe: true });
  await store.adoptVersion(skillId, 3, { from: ['probing'], probe: emptyProbe('adopted', undefined, NOW), reviewAt: new Date(NOW.getTime() + 7 * DAY) });
  await store.setOutcome((await store.versions(skillId)).find((v) => v.version === 1)!.id, 'superseded', null);
  await pool.query(`UPDATE skill_versions SET kpi_baseline = $2 WHERE skill_id = $1 AND version = 3`, [skillId, JSON.stringify(kpiNow)]);

  assert.equal((await store.previousLive(skillId, 3))?.version, 1, 'v2 was rejected, it never was live');
  const evaluator = new SkillVersionEvaluator({ skills: store, agents, kpi, inbox: new OwnerInbox(pool) });
  const r = await evaluator.run(new Date(NOW.getTime() + 8 * DAY));
  assert.equal(r.rolledBack >= 1, true);
  assert.equal((await store.get(skillId))!.body, 'Перший текст скіла, що був живий.');
});
