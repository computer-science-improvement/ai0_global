/**
 * Spec 057 against a throwaway Postgres (a fresh database with every migration applied): migration 090 (the `expired` status,
 * idempotent, its down file) and the repository sweep — only `ready` / `partially_applied` older than the TTL expire, pending
 * sections become skipped, applied ones stay, TTL 0 does nothing, a second sweep finds nothing. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelSetupRepository } from './setup.repository';
import { SETUP_SECTIONS } from './setup-analysis';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATIONS = join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations');
const MIGRATION = readFileSync(join(MIGRATIONS, '090_setup_proposal_expired.sql'), 'utf8');
const DOWN = readFileSync(join(MIGRATIONS, 'down', '090_setup_proposal_expired.down.sql'), 'utf8');
let db: FreshDb;
let repo: ChannelSetupRepository;

const NOW = new Date('2026-10-21T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function insert(channel: string, status: string, updatedAt: Date, sectionStatus: Record<string, string> = {}, sections: unknown = { summary: 's' }) {
  const { rows } = await db.pool.query(
    `INSERT INTO channel_setup_proposals (channel_key, resource_ref, status, sections, section_status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [channel, `telegram:${channel}`, status, sections == null ? null : JSON.stringify(sections), JSON.stringify(sectionStatus), updatedAt]);
  return rows[0].id as string;
}

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'p057');
  repo = new ChannelSetupRepository(db.pool);
});
after(async () => {
  if (db) await db.drop();
});

test('090 applies again, accepts `expired` and is recorded; the down file restores the old list', { skip }, async () => {
  await db.pool.query(MIGRATION);
  const ok = await db.pool.query(
    `INSERT INTO channel_setup_proposals (channel_key, resource_ref, status) VALUES ('@mig', 'telegram:@mig', 'expired') RETURNING id`);
  assert.equal(ok.rows.length, 1);
  const rec = await db.pool.query(`SELECT 1 FROM schema_migrations WHERE version = '090_setup_proposal_expired'`);
  assert.equal(rec.rows.length, 1);

  await db.pool.query(DOWN);
  assert.equal((await db.pool.query(`SELECT status FROM channel_setup_proposals WHERE id = $1`, [ok.rows[0].id])).rows[0].status, 'discarded');
  await assert.rejects(
    db.pool.query(`INSERT INTO channel_setup_proposals (channel_key, resource_ref, status) VALUES ('@mig2', 'telegram:@mig2', 'expired')`),
    /channel_setup_proposals_status_check/);
  await db.pool.query(MIGRATION);
  await db.pool.query(`DELETE FROM channel_setup_proposals WHERE channel_key LIKE '@mig%'`);
});

test('expireStale: only ready / partially_applied older than the TTL; pending sections skipped, applied kept', { skip }, async () => {
  const oldReady = await insert('@old_ready', 'ready', daysAgo(20));
  const oldPartial = await insert('@old_partial', 'partially_applied', daysAgo(15), { brief_profile: 'applied', schedule: 'skipped' });
  const freshReady = await insert('@fresh_ready', 'ready', daysAgo(13));
  const oldApplied = await insert('@old_applied', 'applied', daysAgo(40));
  const oldFailed = await insert('@old_failed', 'failed', daysAgo(40), {}, null);
  const oldQueued = await insert('@old_queued', 'queued', daysAgo(40), {}, null);
  const oldAnalyzing = await insert('@old_analyzing', 'analyzing', daysAgo(40), {}, null);
  const oldDiscarded = await insert('@old_discarded', 'discarded', daysAgo(40));

  assert.deepEqual(await repo.expireStale(NOW, 0, SETUP_SECTIONS), [], 'TTL 0 = never');
  assert.equal((await repo.get(oldReady))?.status, 'ready');

  const out = await repo.expireStale(NOW, 14, SETUP_SECTIONS);
  assert.deepEqual(out.map((p) => p.channelKey), ['@old_partial', '@old_ready']);
  assert.ok(out.every((p) => p.status === 'expired'));

  const ready = await repo.get(oldReady);
  assert.equal(ready?.status, 'expired');
  assert.deepEqual(ready?.sectionStatus, Object.fromEntries(SETUP_SECTIONS.map((s) => [s, 'skipped'])));
  assert.equal(ready?.updatedAt.toISOString(), NOW.toISOString());
  assert.equal(ready?.reason, 'expired: closed after 14 days without an apply', 'the dashboard reads the days from the reason');

  const partial = await repo.get(oldPartial);
  assert.equal(partial?.status, 'expired');
  assert.equal(partial?.sectionStatus.brief_profile, 'applied', 'applied sections stay');
  assert.equal(partial?.sectionStatus.schedule, 'skipped');
  assert.equal(partial?.sectionStatus.formatting, 'skipped');

  for (const [id, status] of [[freshReady, 'ready'], [oldApplied, 'applied'], [oldFailed, 'failed'], [oldQueued, 'queued'], [oldAnalyzing, 'analyzing'], [oldDiscarded, 'discarded']] as const) {
    assert.equal((await repo.get(id))?.status, status, `${id} is left alone`);
  }
  assert.deepEqual(await repo.expireStale(NOW, 14, SETUP_SECTIONS), [], 'a second sweep finds nothing');
  assert.deepEqual((await repo.expireStale(new Date(NOW.getTime() + 2 * 86_400_000), 14, SETUP_SECTIONS)).map((p) => p.channelKey), ['@fresh_ready']);
});

test('an expired proposal does not hold the channel\'s open slot', { skip }, async () => {
  const id = await insert('@slot', 'ready', daysAgo(30));
  await assert.rejects(db.pool.query(`INSERT INTO channel_setup_proposals (channel_key, resource_ref) VALUES ('@slot', 'telegram:@slot')`), /uq_channel_setup_proposals_open/);
  await repo.expireStale(NOW, 14, SETUP_SECTIONS);
  assert.equal((await repo.get(id))?.status, 'expired');
  const next = await repo.enqueue('@slot');
  assert.equal(next.status, 'queued');
  assert.equal((await repo.get(id))?.status, 'expired', 'enqueue leaves the expired one as it is');
});
