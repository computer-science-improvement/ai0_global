/**
 * Spec 024 T8 on a throwaway Postgres: format_prefs versions, owner locks
 * (`locked_by_owner`), the 3-changes-a-day cap (the 4th is refused), owner
 * edits outside the cap, profile saves that keep format_prefs, a member
 * resource without a full profile, and the owner endpoints of the agent page.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentRegistrySync } from '../agents/agent-registry-sync';
import { AgentsService } from '../agents/agents.service';
import { OwnerInbox } from '../agents/owner-inbox';
import { SkillStore } from '../agents/skill-store';
import { renderFormatPrefs, ResourceProfileSchema, ResourceProfilesRepository } from '../agents/resource-profile';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { buildFormatTools } from './format-tools';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@fmt024_pg';
const GROUP = 'fmt024 e2e';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  const { rows } = await pool.query(`SELECT id, platform FROM meta_accounts WHERE account_id LIKE 'fmt024-%'`);
  for (const m of rows) {
    await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [`${m.platform}:${m.id}`]);
    await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [`${m.platform}:${m.id}`]);
  }
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id LIKE 'fmt024-%'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name = $1`, [GROUP]);
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

test('format_prefs: owner locks, 3 agent changes a day, versions with diffs, profile saves keep them, owner endpoints', { skip }, async () => {
  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'independent') RETURNING id`, [GROUP])).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'fmt024_pg', 'Космос', true, $2)`, [CH, groupId]);
  const acc = async (platform: string) => (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at) VALUES ($1, $2, 'X', 't', $2, $3, now()) RETURNING id`,
    [platform, `fmt024-${platform}`, groupId])).rows[0].id;
  const IG = `instagram:${await acc('instagram')}`;
  const TH = `threads:${await acc('threads')}`;
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'Космос'), mode: 'shadow' });
  const agents = new AgentsRepository(pool);
  await new AgentRegistrySync({ agents, channels }).run();
  const orch = (await agents.findTop('orchestrator', 'resource', `telegram:${CH}`))!;
  const profiles = new ResourceProfilesRepository(pool);
  await profiles.setProfile(IG, ResourceProfileSchema.parse({ topic: 'Космос для Instagram', audience: { who: 'дорослі' }, goals: ['growth'] }), 'owner');

  // The owner sets the formatting and locks the emoji.
  const own = await profiles.patchFormat(IG, { emoji: 'none', hashtags: { count: 3, fixed: ['космос'] } }, { by: 'owner', locks: ['emoji'], replace: true, reason: 'owner edit' });
  assert.equal('ok' in own && own.ok, true, JSON.stringify(own));

  const [get, update] = buildFormatTools({ profiles });
  const ctx = { runId: 'r', role: 'orchestrator', channelKey: CH, extras: { network: { resources: [{ ref: `telegram:${CH}` }, { ref: IG }, { ref: TH }] }, agent: { id: orch.id } } } as any;
  const call = (resource_ref: string, patch: Record<string, unknown>) =>
    update.execute({ resource_ref, patch, reason: 'Збереження ростуть із коротшими підписами' }, ctx) as Promise<any>;

  // A locked field is refused; three other changes pass; the fourth on the same resource-day is refused.
  assert.deepEqual(await call(IG, { emoji: 'rich' }), { error: 'locked_by_owner', details: ['emoji'] });
  assert.equal((await call(IG, { tone: 'сухий' })).ok, true);
  assert.equal((await call(IG, { length: { target: 200, max: 400 } })).ok, true);
  assert.equal((await call(IG, { tone: null })).ok, true);
  assert.equal((await call(IG, { cta: 'Збережи' })).error, 'daily_limit');
  assert.equal((await call(IG, { length: { target: 900, max: 400 } })).error, 'daily_limit', 'the cap is checked first');
  // Another resource has its own count; a member without a full profile still stores format_prefs.
  const th = await call(TH, { links: 'inline' });
  assert.equal(th.ok, true, JSON.stringify(th));
  assert.equal((await profiles.get(TH))?.profile ?? null, null, 'no full profile for Threads');
  assert.deepEqual((await profiles.formatOf(TH)).prefs, { links: 'inline' });
  assert.equal((await call(TH, { links: 'inline' })).error, 'no_change');
  assert.equal((await call(TH, { emoji: 'lots' })).error, 'invalid_patch');

  // The owner is outside the cap; a profile save without format_prefs keeps them.
  assert.equal('ok' in (await profiles.patchFormat(IG, { cta: 'Збережи' }, { by: 'owner' })), true);
  await profiles.setProfile(IG, ResourceProfileSchema.parse({ topic: 'Космос для Instagram і не тільки', audience: { who: 'дорослі' }, goals: ['growth'] }), 'owner');
  const f = await profiles.formatOf(IG);
  assert.deepEqual(f.locks, ['emoji']);
  assert.deepEqual(f.prefs, { emoji: 'none', hashtags: { count: 3, fixed: ['космос'] }, length: { target: 200, max: 400 }, cta: 'Збережи' });
  assert.match(renderFormatPrefs(f.prefs, f.locks)!, /Емодзі: без емодзі \(закріплено власником\)/);

  // Versions: who, when, why, diff.
  const h = await profiles.history([IG], 20);
  assert.deepEqual(h.map((x) => [x.version, x.kind, x.changedBy]), [
    [7, 'profile', 'owner'], [6, 'format', 'owner'], [5, 'format', 'agent'], [4, 'format', 'agent'], [3, 'format', 'agent'], [2, 'format', 'owner'], [1, 'profile', 'owner'],
  ]);
  assert.deepEqual(h[2].diff, { tone: { from: 'сухий', to: null } });
  assert.equal(h[2].reason, 'Збереження ростуть із коротшими підписами');
  assert.equal(h[2].agentId, orch.id);
  assert.deepEqual(h[5].diff.format_locks, { from: [], to: ['emoji'] });
  const g: any = await get.execute({ resource_ref: IG }, ctx);
  assert.equal(g.changes_today, 3);

  // The agent page: every network resource with its formatting; the owner's PUT replaces prefs and locks.
  const svc = new AgentsService({
    pool, agents, skills: new SkillStore(pool), inbox: new OwnerInbox(pool), profiles,
    setChannelMode: async () => {}, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
  });
  const page: any = await svc.getFormatting(orch.handle);
  assert.deepEqual(page.resources.map((r: any) => r.ref).sort(), [`telegram:${CH}`, IG, TH].sort());
  assert.equal(page.resources.find((r: any) => r.ref === IG).changesToday, 3);
  assert.ok(page.history.some((x: any) => x.agentHandle === orch.handle));
  const after: any = await svc.putFormatting(orch.handle, TH, { format_prefs: { emoji: 'light' }, format_locks: ['emoji', 'links'] });
  const thRow = after.resources.find((r: any) => r.ref === TH);
  assert.deepEqual([thRow.formatPrefs, thRow.locks], [{ emoji: 'light' }, ['emoji', 'links']]);
  await assert.rejects(svc.putFormatting(orch.handle, 'instagram:not-mine', { format_prefs: {} }), /resource_not_found|Not Found/);
  await assert.rejects(svc.putFormatting(orch.handle, TH, { format_prefs: { emoji: 'lots' } }), /Bad Request|invalid_body/);
});
