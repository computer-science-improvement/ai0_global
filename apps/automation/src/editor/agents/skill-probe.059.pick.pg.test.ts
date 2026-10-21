/**
 * Spec 059 T2 against a throwaway Postgres (its own database): which slots a probe re-writes, and the owner's
 * "Adopt anyway" through AgentsService. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { AgentsRepository } from './agents.repository';
import { AgentsService } from './agents.service';
import { SkillStore } from './skill-store';
import { pickProbeSlots } from './skill-probe-samples';
import { emptyProbe } from './skill-probe.types';
import { SkillLibrary } from '../skills/skill-library';
import { createProbeDb, type ProbeDb } from './testing/probe-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;

let db: ProbeDb;
let pool: Pool;
let store: SkillStore;
let agent: Awaited<ReturnType<AgentsRepository['insert']>>;
let plan: string;
const NOW = new Date('2030-05-06T09:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'pick');
  pool = db.pool;
  store = new SkillStore(pool);
  await store.syncBuiltins(new SkillLibrary());
  const agents = new AgentsRepository(pool);
  agent = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@pick_a', name: 'Pick', handle: 'pick_a', createdBy: 'sync' });
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ('@pick_a', 'live'), ('@pick_b', 'live')`);
  plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ('@pick_a', '2030-05-01') RETURNING id`)).rows[0].id;
});
after(async () => { if (db) await db.drop(); });

async function slot(o: {
  key?: string; status?: string; hours: number; format?: string; topic: string; topicMode?: string; treatment?: string | null; promo?: object | null; ref?: string | null; kind?: string;
}): Promise<string> {
  const approved = o.status === 'approved';
  return (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, status, topic_mode, treatment, promo, resource_ref, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [plan, o.key ?? '@pick_a', hoursAgo(o.hours), o.kind ?? 'content', o.format ?? 'text', o.topic, o.status ?? 'published', o.topicMode ?? 'fixed',
      o.treatment ?? null, o.promo ? JSON.stringify(o.promo) : null, o.ref ?? null, approved ? NOW : null])).rows[0].id;
}

test('picks the newest published or approved content slots of the agent\'s own channel, nothing a re-write would misrepresent', { skip }, async () => {
  const keep1 = await slot({ hours: 5, topic: 'найновіший' });
  const keep2 = await slot({ hours: 30, topic: 'схвалений', status: 'approved' });
  const keep3 = await slot({ hours: 60, topic: 'третій', treatment: 'unique' });
  await slot({ hours: 2, topic: 'ще планується', status: 'planned' });
  await slot({ hours: 3, topic: 'живий', topicMode: 'live' });
  await slot({ hours: 4, topic: 'копія', treatment: 'duplicate' });
  await slot({ hours: 6, topic: 'адаптація', treatment: 'adapt' });
  await slot({ hours: 7, topic: 'промо', promo: { kind: 'cross_promo' } });
  await slot({ hours: 8, topic: 'зарезервований', kind: 'reserved' });
  await slot({ hours: 9, topic: 'сусід', key: '@pick_b' });
  await slot({ hours: -3, topic: 'з майбутнього' });
  await slot({ hours: 400, topic: 'найстаріший' });

  const got = await pickProbeSlots(pool, agent, 'seasonal-hooks', 3, NOW);
  assert.deepEqual(got.map((s) => s.slotId), [keep1, keep2, keep3]);
  assert.deepEqual(got[0], { slotId: keep1, channelKey: '@pick_a', topic: 'найновіший', format: 'text' });
  assert.equal((await pickProbeSlots(pool, agent, 'seasonal-hooks', 1, NOW)).length, 1);
});

test('a format skill puts the slots of that format first', { skip }, async () => {
  const poll = await slot({ hours: 500, topic: 'давнє опитування', format: 'poll' });
  const got = await pickProbeSlots(pool, agent, 'format-poll', 2, NOW);
  assert.equal(got[0].slotId, poll);
  assert.equal(got.length, 2);
});

test('an agent with no channel to look at gets no slots', { skip }, async () => {
  const lone = await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'instagram:ig_none', name: 'Lone', handle: 'lone_ig', createdBy: 'sync' });
  assert.deepEqual(await pickProbeSlots(pool, lone, 'seasonal-hooks', 3, NOW), []);
  const ig = await slot({ hours: 12, topic: 'пост в інсті', key: '@pick_a', ref: 'instagram:ig_none' });
  assert.deepEqual((await pickProbeSlots(pool, lone, 'seasonal-hooks', 3, NOW)).map((s) => s.slotId), [ig]);
});

test('Adopt anyway: only the newest rejected version goes live, as owner_override under the 7-day review', { skip }, async () => {
  const svc = new AgentsService({ skills: store, now: () => NOW } as any);
  await store.writeAgentSkill({
    agentId: agent.id, name: 'adopt-anyway', description: 'Описовий текст скіла для перевірки', appliesTo: ['executor'], body: 'Перша версія тексту скіла.',
    author: 'agent', authorAgentId: agent.id, reason: 'початок',
  });
  const w = await store.writeAgentSkill({
    agentId: agent.id, name: 'adopt-anyway', description: 'Описовий текст скіла для перевірки', appliesTo: ['executor'], body: 'Друга версія тексту скіла, ще не жива.',
    author: 'agent', authorAgentId: agent.id, reason: 'спроба', reviewAt: new Date(NOW.getTime() + 7 * 86_400_000), probing: true, probe: emptyProbe('probing', undefined, NOW),
  });
  assert.ok('ok' in w, JSON.stringify(w));
  const skillId = (w as any).skill.id as string;
  const v = (w as any).version as number;

  await assert.rejects(() => svc.adoptRejected(skillId, v), (e: any) => e.getStatus() === 409 && e.getResponse().error === 'not_rejected');
  await assert.rejects(() => svc.adoptRejected(skillId, 99), (e: any) => e.getStatus() === 404);
  await assert.rejects(() => svc.adoptRejected('00000000-0000-0000-0000-000000000000', 1), (e: any) => e.getStatus() === 404);

  assert.ok(await store.rejectVersion(skillId, v, { verdict: 'rejected', reason: 'судя програв', samples: [], costUsd: 0.1, at: NOW.toISOString() }));
  const r = await svc.adoptRejected(skillId, v);
  assert.equal(r.ok, true);
  const live = await store.get(skillId);
  assert.equal(live!.currentVersion, v);
  assert.match(live!.body, /Друга версія/);
  const row = await store.version(skillId, v);
  assert.equal(row!.outcome, 'pending');
  assert.equal(row!.probe!.verdict, 'owner_override');
  assert.match(row!.probe!.reason!, /rejected by the probe \(судя програв\); adopted anyway by the owner/);
  assert.equal(row!.reviewAt!.toISOString(), '2030-05-13T09:00:00.000Z');

  // Done once: the same click again finds a version that is no longer rejected.
  await assert.rejects(() => svc.adoptRejected(skillId, v), (e: any) => e.getResponse().error === 'not_rejected');
});

test('Adopt anyway on an older rejection is refused: a newer version exists', { skip }, async () => {
  const svc = new AgentsService({ skills: store, now: () => NOW } as any);
  const base = { agentId: agent.id, name: 'adopt-old', description: 'Описовий текст скіла для перевірки', appliesTo: ['executor' as const], author: 'agent' as const, authorAgentId: agent.id, reason: 'тест' };
  await store.writeAgentSkill({ ...base, body: 'Перша версія тексту скіла для тесту.' });
  const a = await store.writeAgentSkill({ ...base, author: 'agent', body: 'Друга версія тексту скіла для тесту.', probing: true, probe: emptyProbe('probing', undefined, NOW) });
  assert.ok('ok' in a, JSON.stringify(a));
  const skillId = (a as any).skill.id as string;
  await store.rejectVersion(skillId, (a as any).version, { verdict: 'rejected', reason: 'x', samples: [], costUsd: 0, at: NOW.toISOString() });
  await store.writeAgentSkill({ ...base, author: 'owner', authorAgentId: null, body: 'Третя версія тексту скіла для тесту, власник.' });
  await assert.rejects(() => svc.adoptRejected(skillId, (a as any).version), (e: any) => e.getStatus() === 409 && e.getResponse().error === 'cannot_adopt');
});
