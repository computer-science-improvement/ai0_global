/**
 * Spec 024 T5 (FR-010) on a throwaway Postgres: one `network_independent_offer`
 * per legacy group whose anchor has an orchestrator, none for strategy-only
 * groups, a re-offer once a first playbook is approved, "Keep" never re-offers,
 * and switching writes the `network_mode` record while the gate rules decide
 * when fan-out stops. Skipped unless EDITOR_PG_TEST_URL is set. Never point
 * this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { NetworkRepository } from './network.repository';
import { NetworkService } from './network.service';
import { NetworkOffers, OFFER_KIND } from './network-offers';
import { PlaybookSchema } from './playbook';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const A = '@no024_a';      // legacy, orchestrator, no playbook yet, a strategy on a member
const B = '@no024_b';      // legacy, strategy-only (no orchestrator)
const C = '@no024_c';      // independent already
const D = '@no024_d';      // legacy, orchestrator with a playbook
let pool: Pool;

async function cleanup() {
  const keys = [A, B, C, D];
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = ANY($1::text[])`, [keys.map((k) => `telegram:${k}`)]);
  for (const r of rows) {
    await pool.query(`DELETE FROM playbooks WHERE agent_id = $1`, [r.id]);
    await pool.query(`DELETE FROM agent_inbox WHERE agent_id = $1`, [r.id]);
  }
  await pool.query(`DELETE FROM agents WHERE scope_id = ANY($1::text[])`, [keys.map((k) => `telegram:${k}`)]);
  await pool.query(`DELETE FROM strategy_bindings WHERE ext_id LIKE 'no024-%'`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id LIKE 'no024-%'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name LIKE 'no024%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

async function group(name: string, key: string, mode: string): Promise<{ id: string; channelId: string }> {
  const id = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', $2) RETURNING id`, [name, mode])).rows[0].id;
  const channelId = (await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, $2, $3, true, $4) RETURNING id`,
    [key, key.slice(1), name, id])).rows[0].id;
  await new EditorChannelsRepository(pool).insertIfMissing({ ...makeDefaultCard(key, name), mode: 'live' });
  return { id, channelId };
}

const playbook = (key: string) => PlaybookSchema.parse({ platforms: [{ resource_ref: `telegram:${key}`, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] });

test('offers: one per legacy group with an orchestrator, none for strategy-only groups; re-offer on the first playbook; Keep is final; Switch → network_mode', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const repo = new NetworkRepository(pool);
  const inbox = new OwnerInbox(pool);
  const offers = new NetworkOffers({ pool, inbox });
  const svc = new NetworkService({
    pool, agents, repo, inbox, card: (k) => new EditorChannelsRepository(pool).get(k), rebuild: async () => null, offers,
  });

  const ga = await group('no024 A', A, 'legacy_duplicate');
  const gb = await group('no024 B', B, 'legacy_duplicate');
  const gc = await group('no024 C', C, 'independent');
  const gd = await group('no024 D', D, 'legacy_duplicate');
  const orchA = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${A}`, name: 'A', handle: 'no024_a', mode: 'shadow', createdBy: 'owner' });
  await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${C}`, name: 'C', handle: 'no024_c', mode: 'live', createdBy: 'owner' });
  const orchD = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${D}`, name: 'D', handle: 'no024_d', mode: 'live', createdBy: 'owner' });
  await repo.insertPlaybook({ agentId: orchD.id, status: 'active', brief: null, rationale: 't', createdBy: 'owner', body: playbook(D) });
  // A strategy publishing to a member of A, and B's only driver: a strategy.
  const igA = (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id) VALUES ('instagram', 'no024-ig', 'X', 't', 'a_ig', $1) RETURNING id`,
    [ga.id])).rows[0].id;
  await pool.query(`INSERT INTO strategy_bindings (ext_id, type, platform, meta_account_id, schedule) VALUES ('no024-rc', 'recipe-carousel', 'instagram', $1, '0 9 * * *')`, [igA]);
  await pool.query(`INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule) VALUES ('no024-pr', 'ai0-prompts', $1, '0 10 * * *')`, [gb.channelId]);

  const mine = <T extends { groupId: string }>(rows: T[]) => rows.filter((r) => [ga.id, gb.id, gc.id, gd.id].includes(r.groupId));
  const first = mine(await offers.run());
  assert.deepEqual(first.map((r) => r.groupId).sort(), [ga.id, gd.id].sort(), 'legacy groups with an orchestrator only');
  assert.ok(first.every((r) => r.step === 'offer'));
  assert.deepEqual(mine(await offers.run()), [], 'idempotent by (kind, group_id)');

  const items = async (agentId: string) => (await pool.query(`SELECT * FROM agent_inbox WHERE agent_id = $1 AND kind = $2 ORDER BY id`, [agentId, OFFER_KIND])).rows;
  const [itemA] = await items(orchA.id);
  assert.equal(itemA.severity, 'action');
  assert.equal(itemA.ref_type, 'network_group');
  assert.equal(itemA.ref_id, ga.id);
  assert.match(itemA.body, /Playbook: none yet/);
  assert.match(itemA.body, /Orchestrator mode: shadow/);
  assert.match(itemA.body, /recipe-carousel \(no024-rc, instagram\)/);
  assert.match(itemA.body, /Auto-duplicate source: Telegram/);
  assert.match(itemA.body, /In shadow the agent records decisions as previews/);
  assert.doesNotMatch(`${itemA.title}\n${itemA.body}`, /[Ѐ-ӿ]/, 'dashboard text is English');
  assert.match((await items(orchD.id))[0].body, /Playbook: active/);

  // A's first playbook is approved → offered once more; a second approval does not repeat it.
  const draft = await repo.insertPlaybook({ agentId: orchA.id, status: 'pending_owner', brief: null, rationale: 't', createdBy: 'orchestrator', body: playbook(A) });
  await svc.decide(draft.id, true);
  const afterApprove = await items(orchA.id);
  assert.equal(afterApprove.length, 2);
  assert.match(afterApprove[1].title, /has its first playbook/);
  const draft2 = await repo.insertPlaybook({ agentId: orchA.id, status: 'pending_owner', brief: null, rationale: 't2', createdBy: 'orchestrator', body: playbook(A) });
  await svc.decide(draft2.id, true);
  assert.equal((await items(orchA.id)).length, 2);
  assert.deepEqual(mine(await offers.run()), []);

  // D: Keep auto-duplicate — final, the mode stays legacy.
  assert.deepEqual(await svc.keepOffer(gd.id), { status: 'kept' });
  assert.deepEqual(await svc.keepOffer(gd.id), { status: 'kept' });
  assert.equal((await repo.groupOfChannel(D))!.mode, 'legacy_duplicate');
  assert.deepEqual(mine(await offers.run()), []);
  assert.equal((await items(orchD.id)).length, 1);

  // A: Switch to independent → network_mode record, offer switched; the shadow orchestrator keeps auto-duplication on.
  const r = await svc.setMode('no024_a', { mode: 'independent' });
  assert.equal(r.mode, 'independent');
  const nm = await pool.query(`SELECT * FROM agent_inbox WHERE agent_id = $1 AND kind = 'network_mode'`, [orchA.id]);
  assert.equal(nm.rowCount, 1);
  const list = await svc.offers();
  const byGroup = new Map(list.offers.map((o) => [o.groupId, o.status]));
  assert.equal(byGroup.get(ga.id), 'switched');
  assert.equal(byGroup.get(gd.id), 'kept');
  assert.equal(byGroup.has(gb.id), false);
  assert.equal(byGroup.has(gc.id), false);
  assert.equal(await repo.autoDuplicateActive(ga.id, new Date('2026-04-02T08:00:00Z')), true, 'shadow: auto-duplication continues');
  await agents.update(orchA.id, { mode: 'live' });
  assert.equal(await repo.autoDuplicateActive(ga.id, new Date('2026-04-03T08:00:00Z')), false, 'live + playbook: it stops from the next plan day');
  // Back to legacy later: the decided offer is not reopened.
  await svc.setMode('no024_a', { mode: 'legacy_duplicate' });
  assert.deepEqual(mine(await offers.run()), []);

  // A legacy offer still open while the owner switches from the Playbook tab elsewhere is closed by housekeeping.
  await pool.query(`UPDATE network_offers SET status = 'open', decided_at = NULL WHERE group_id = $1`, [gd.id]);
  await repo.setGroupMode(gd.id, 'independent');
  assert.deepEqual(mine(await offers.run()), [{ groupId: gd.id, step: 'close_switched' }]);
});
