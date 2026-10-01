/** Spec 022 on a throwaway Postgres: promo scheduling with its limits, tracked joins and the transitions KPI. Skipped unless EDITOR_PG_TEST_URL is set. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { ResourceProfilesRepository, ResourceProfileSchema } from '../agents/resource-profile';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { makeDefaultCard } from '../chat/default-card';
import { DirectivesRepository } from '../manager/directives.repository';
import { KpiDigestService } from '../manager/kpi-digest.service';
import { TrackedLinks } from './tracked-links';
import { PromoPlanner } from './promo-planner';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const A = '@promo_pg_space';
const B = '@promo_pg_astro';
const C = '@promo_pg_food';
let pool: Pool;

async function cleanup() {
  const refs = [A, B, C].map((k) => `telegram:${k}`);
  await pool.query(`DELETE FROM link_joins WHERE link_id IN (SELECT id FROM tracked_links WHERE target_ref = ANY($1::text[]))`, [refs]);
  await pool.query(`DELETE FROM tracked_links WHERE target_ref = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM promo_pairs WHERE source_ref = ANY($1::text[]) OR target_ref = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id IN (SELECT id FROM agents WHERE scope_id = ANY($1::text[]))`, [refs]);
  await pool.query(`DELETE FROM agents WHERE scope_id = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = ANY($1::text[])`, [[A, B, C]]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = ANY($1::text[])`, [[A, B, C]]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const channels = new EditorChannelsRepository(pool);
  for (const k of [A, B, C]) await channels.insertIfMissing({ ...makeDefaultCard(k, k), mode: 'live', quietStartHour: 23, quietEndHour: 8 });
  const profiles = new ResourceProfilesRepository(pool);
  await profiles.setProfile(`telegram:${A}`, ResourceProfileSchema.parse({ topic: 'Космос, астрономія, телескопи і планети', audience: { who: 'дорослі, що цікавляться космосом' }, goals: ['growth'] }), 'owner');
  await profiles.setProfile(`telegram:${B}`, ResourceProfileSchema.parse({ topic: 'Астрономія для початківців: телескопи, планети', audience: { who: 'дорослі новачки в астрономії' }, goals: ['growth'] }), 'owner');
  await profiles.setProfile(`telegram:${C}`, ResourceProfileSchema.parse({ topic: 'Рецепти домашньої кухні', audience: { who: 'господині та студенти' }, goals: ['growth'] }), 'owner');
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('cross-promo: scheduled with a tracked invite link; pair cooldown, relevance and joins → transitions KPI', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${A}`, name: 'Space', handle: 'promo_pg_space', mode: 'live', createdBy: 'owner' });
  const directives = new DirectivesRepository(pool);
  const catalog = { list: async () => [A, B, C].map((k) => ({ ref: `telegram:${k}`, platform: 'telegram' as const, title: k, username: k.slice(1), followers: null, groupId: null, groupName: null, agent: null })) };
  const created: string[] = [];
  const links = new TrackedLinks({ pool, salt: 'test', redirectBase: null, createInvite: async (key, name) => { created.push(`${key}:${name}`); return `https://t.me/+${name.replace(/[^a-z0-9]/gi, '')}`; } });
  const planner = new PromoPlanner({
    pool, plans: new EditorPlansRepository(pool), catalog, profiles: new ResourceProfilesRepository(pool), links, directives,
    card: (k) => new EditorChannelsRepository(pool).get(k), usable: async () => true, bestHours: async () => [12],
  });
  const file = async (target: string) => directives.insert({
    fromAgentId: null, toAgentId: orch.id, kind: 'cross_promo', structural: true, body: `Промо ${target}`, params: { source_ref: `telegram:${A}`, target_ref: `telegram:${target}`, window_days: 3 },
    rationale: 'аудиторії перетинаються', evidence: { x: 1 }, expected: { metric: 'transitions', direction: 'up', min_change_pct: 10, resource_ref: `telegram:${target}` }, reviewAt: null, status: 'new', shadow: false,
  });

  const d1 = await file(B);
  await directives.update(d1.id, { status: 'accepted' });
  const r1: any = await planner.schedule((await directives.get(d1.id))!, orch, A);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.tracked, true);
  assert.equal(created.length, 1);
  assert.equal((await directives.get(d1.id))!.status, 'applied');
  const { rows: slot } = await pool.query(`SELECT kind, promo, scheduled_at FROM editor_slots WHERE id = $1`, [r1.slotId]);
  assert.equal(slot[0].kind, 'reserved');
  assert.equal(slot[0].promo.kind, 'cross_promo');
  assert.ok(slot[0].promo.link_url.startsWith('https://t.me/+'));
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(slot[0].scheduled_at), '12');

  // Same pair again → cooldown (in either direction); unrelated pair → low relevance.
  const d2 = await file(B);
  await directives.update(d2.id, { status: 'accepted' });
  assert.equal(((await planner.schedule((await directives.get(d2.id))!, orch, A)) as any).error, 'pair_cooldown');
  assert.equal((await directives.get(d2.id))!.status, 'rejected');
  const d3 = await file(C);
  await directives.update(d3.id, { status: 'accepted' });
  assert.equal(((await planner.schedule((await directives.get(d3.id))!, orch, A)) as any).error, 'low_relevance');

  // Joins through the invite link (hashed, once per user) feed the transitions KPI of the target.
  const name = (await pool.query(`SELECT tg_invite_name FROM tracked_links WHERE target_ref = $1`, [`telegram:${B}`])).rows[0].tg_invite_name;
  assert.equal(await links.recordJoin({ inviteLinkName: name, userId: 1, status: 'member' }), true);
  assert.equal(await links.recordJoin({ inviteLinkName: name, userId: 1, status: 'member' }), false, 'the same user counts once');
  assert.equal(await links.recordJoin({ inviteLinkName: name, userId: 2, status: 'left' }), false);
  await pool.query(`UPDATE link_joins SET joined_at = now() - interval '2 days' WHERE link_id IN (SELECT id FROM tracked_links WHERE target_ref = $1)`, [`telegram:${B}`]);
  const dg = await new KpiDigestService({ pool, catalog, globalCapUsd: 3 }).build();
  assert.equal(dg.resources.find((r) => r.ref === `telegram:${B}`)!.kpis.transitions.v, 1);
  const stats = await links.stats([`telegram:${B}`]);
  assert.equal(stats[0].joins, 1);
  const { rows: hashes } = await pool.query(`SELECT tg_user_hash FROM link_joins`);
  assert.ok(hashes.every((h) => !/^\d+$/.test(h.tg_user_hash ?? '')), 'no raw user ids');
});
