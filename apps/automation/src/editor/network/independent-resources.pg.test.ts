/**
 * Spec 024 on a throwaway Postgres: migration 061 (idempotent, pre-024 modes
 * mapped), resource_tz() fallback order, and the auto-duplicate gate with its
 * plan-day pin (a legacy group with a live orchestrator still duplicates;
 * independent + shadow keeps duplicating; going live stops it the next day).
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { NetworkRepository } from './network.repository';
import { PlaybookSchema } from './playbook';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const M061 = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '061_independent_resources.sql'), 'utf8');
const CH = '@ir024_pg';
const GROUP = 'ir024 e2e';
let pool: Pool;

async function cleanup() {
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  for (const r of rows) await pool.query(`DELETE FROM playbooks WHERE agent_id = $1`, [r.id]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref LIKE '%ir024%'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name LIKE 'ir024%'`);
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

test('migration 061: applied twice, maps mirror → legacy_duplicate and orchestrated → independent', { skip }, async () => {
  // Recreate pre-024 rows: the old CHECK allowed only the old names.
  await pool.query(`ALTER TABLE meta_account_groups DROP CONSTRAINT IF EXISTS meta_account_groups_mode_chk`);
  await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ('ir024 m', 'telegram', 'mirror'), ('ir024 o', 'telegram', 'orchestrated')`);
  await pool.query(M061);
  await pool.query(M061);
  const { rows } = await pool.query(`SELECT name, mode FROM meta_account_groups WHERE name IN ('ir024 m', 'ir024 o') ORDER BY name`);
  assert.deepEqual(rows, [{ name: 'ir024 m', mode: 'legacy_duplicate' }, { name: 'ir024 o', mode: 'independent' }]);
  await assert.rejects(pool.query(`UPDATE meta_account_groups SET mode = 'mirror' WHERE name = 'ir024 m'`), /meta_account_groups_mode_chk/);
  const def = await pool.query(`INSERT INTO meta_account_groups (name, source_platform) VALUES ('ir024 d', 'telegram') RETURNING mode`);
  assert.equal(def.rows[0].mode, 'independent');
  const cols = await pool.query(
    `SELECT column_name, column_default FROM information_schema.columns
      WHERE (table_name = 'editor_slots' AND column_name IN ('treatment','treatment_reason','derived_from_slot_id','source_post'))
         OR (table_name = 'editor_channels' AND column_name = 'crosspost') ORDER BY column_name`);
  assert.deepEqual(cols.rows.map((r) => r.column_name), ['crosspost', 'derived_from_slot_id', 'source_post', 'treatment', 'treatment_reason']);
  assert.equal(cols.rows[0].column_default, 'false');
  await assert.rejects(pool.query(`INSERT INTO content_decisions (agent_id, resource_ref, decision, reason, decided_by) VALUES (gen_random_uuid(), 'x', 'mirror', 'r', 'planner')`));
  const v = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '061_independent_resources'`);
  assert.equal(v.rowCount, 1);
});

test('content_decisions: one decision per (idea, resource) and per (source, resource)', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const a = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'IR', handle: 'ir024_pg', createdBy: 'owner' });
  const idea = (await pool.query(
    `INSERT INTO content_ideas (agent_id, title, origin, expires_at) VALUES ($1, 'ir024 idea', 'orchestrator', now() + interval '1 day') RETURNING id`, [a.id])).rows[0].id;
  const ins = (idea_id: string | null, source_key: string | null, ref: string, decision = 'unique') => pool.query(
    `INSERT INTO content_decisions (agent_id, idea_id, source_key, resource_ref, decision, reason, decided_by) VALUES ($1, $2, $3, $4, $5, 'because the profile says so', 'planner')`,
    [a.id, idea_id, source_key, ref, decision]);
  await ins(idea, null, 'instagram:ir024');
  await ins(idea, null, 'threads:ir024', 'skip');
  await assert.rejects(ins(idea, null, 'instagram:ir024', 'duplicate'), /uq_content_decisions_idea/);
  await ins(null, 'slot:1', 'instagram:ir024', 'duplicate');
  await assert.rejects(ins(null, 'slot:1', 'instagram:ir024', 'adapt'), /uq_content_decisions_source/);
  await pool.query(`DELETE FROM content_decisions WHERE agent_id = $1`, [a.id]);
  await pool.query(`DELETE FROM content_ideas WHERE id = $1`, [idea]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [a.id]);
});

test('resource_tz(): Telegram card zone, then the profile zone, then Kyiv; invalid zones fall back to Kyiv', { skip }, async () => {
  const tz = async (ref: string) => (await pool.query(`SELECT resource_tz($1) AS tz`, [ref])).rows[0].tz;
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'IR'), timezone: 'America/New_York' });
  await pool.query(`INSERT INTO resource_profiles (resource_ref, profile) VALUES ($1, '{"timezone":"Asia/Tokyo"}'), ('instagram:ir024', '{"timezone":"Europe/London"}'),
                      ('threads:ir024', '{"timezone":"Mars/Olympus"}'), ('telegram:@ir024_nocard', '{"timezone":"Asia/Tokyo"}'), ('tiktok:ir024', '{}')`, [`telegram:${CH}`]);
  assert.equal(await tz(`telegram:${CH}`), 'America/New_York', 'the card is authoritative for Telegram');
  assert.equal(await tz('telegram:@ir024_nocard'), 'Asia/Tokyo', 'no card → profile');
  assert.equal(await tz('instagram:ir024'), 'Europe/London');
  assert.equal(await tz('threads:ir024'), 'Europe/Kyiv', 'invalid stored zone');
  assert.equal(await tz('tiktok:ir024'), 'Europe/Kyiv', 'profile without a zone');
  assert.equal(await tz('facebook:ir024_none'), 'Europe/Kyiv', 'no profile');
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
});

test('auto-duplicate gate: legacy + live duplicates, independent + shadow duplicates, going live stops it the next plan day', { skip }, async () => {
  const repo = new NetworkRepository(pool);
  const agents = new AgentsRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'legacy_duplicate') RETURNING id`, [GROUP])).rows[0].id;
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, group_id) VALUES ($1, 'ir024_pg', 'IR', true, $2)`, [CH, groupId]);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'IR'), mode: 'live' });
  const orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'IR', handle: 'ir024_pg', mode: 'live', createdBy: 'owner' });
  await repo.insertPlaybook({
    agentId: orch.id, status: 'active', brief: null, rationale: 'test', createdBy: 'owner',
    body: PlaybookSchema.parse({ platforms: [{ resource_ref: `telegram:${CH}`, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] }),
  });
  const at = (iso: string) => new Date(iso);

  // Regression: a legacy group with a live orchestrator behaves exactly as today (duplicates).
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-01T08:00:00Z')), true);
  assert.equal(await repo.autoDuplicateActiveForChannel(CH, at('2026-03-01T09:00:00Z')), true);
  assert.equal(await repo.autoDuplicateActiveForChannel('@ir024_ungrouped', at('2026-03-01T09:00:00Z')), true);

  // independent + shadow: still duplicates.
  await agents.update(orch.id, { mode: 'shadow' });
  await repo.setGroupMode(groupId, 'independent', at('2026-03-01T10:00:00Z'));
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-02T08:00:00Z')), true);

  // Goes live mid-day: today stays duplicating, tomorrow (Kyiv) it stops.
  await agents.update(orch.id, { mode: 'live' });
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-02T15:00:00Z')), true);
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-02T21:59:00Z')), true, '23:59 Kyiv (UTC+2 in March)');
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-02T22:01:00Z')), false, '00:01 Kyiv next day');
  const pin = await pool.query(`SELECT auto_duplicate_day::text AS d, auto_duplicate FROM meta_account_groups WHERE id = $1`, [groupId]);
  assert.deepEqual(pin.rows[0], { d: '2026-03-03', auto_duplicate: false });

  // Back to legacy mid-day: native posts already planned today keep their caps; duplication resumes next day.
  await repo.setGroupMode(groupId, 'legacy_duplicate', at('2026-03-03T10:00:00Z'));
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-03T11:00:00Z')), false);
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-03T22:30:00Z')), true);

  // The card in approve (spec 031) is not live → duplicates.
  await repo.setGroupMode(groupId, 'independent', at('2026-03-04T10:00:00Z'));
  await pool.query(`UPDATE editor_channels SET mode = 'approve' WHERE channel_key = $1`, [CH]);
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-05T08:00:00Z')), true);
  await pool.query(`UPDATE editor_channels SET mode = 'live' WHERE channel_key = $1`, [CH]);
  assert.equal(await repo.autoDuplicateActive(groupId, at('2026-03-06T08:00:00Z')), false);
});
