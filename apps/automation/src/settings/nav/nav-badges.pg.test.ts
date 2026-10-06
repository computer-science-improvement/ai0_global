/**
 * Spec 027 T6 against a throwaway Postgres: the badge statement runs as one
 * query, "today" starts at Europe/Kyiv midnight, a missing source table gives
 * null for its key, and the statement is fast. Runs in its own schema with the
 * columns the counters read. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { NavBadgesService } from './nav-badges.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const SCHEMA = 'pgt027badges';
let pool: Pool;

// 00:30 on 7 Oct in Kyiv (EEST, UTC+3): Kyiv midnight is 2026-10-06T21:00:00Z.
const NOW = new Date('2026-10-06T21:30:00Z');

before(async () => {
  if (!url) return;
  const admin = new Pool({ connectionString: url });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
  await pool.query(`
    CREATE TABLE agent_inbox (id bigserial PRIMARY KEY, severity text NOT NULL DEFAULT 'info', read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX ON agent_inbox (created_at DESC) WHERE read_at IS NULL;
    CREATE TABLE agent_directives (id bigserial PRIMARY KEY, status text NOT NULL);
    CREATE TABLE pending_actions (id bigserial PRIMARY KEY, status text NOT NULL);
    CREATE TABLE agent_dm_threads (id bigserial PRIMARY KEY, status text NOT NULL);
    -- agent_actions is deliberately missing (an older DB).
    CREATE TABLE editor_slots (id bigserial PRIMARY KEY, status text NOT NULL, scheduled_at timestamptz NOT NULL);
    CREATE INDEX ON editor_slots (status, scheduled_at);
    CREATE TABLE scheduled_publications (id bigserial PRIMARY KEY, status text NOT NULL, scheduled_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
  `);
  await pool.query(`
    INSERT INTO agent_inbox (severity, read_at) VALUES ('info', NULL), ('critical', NULL), ('action', now()), ('critical', now());
    INSERT INTO agent_directives (status) VALUES ('awaiting_owner'), ('awaiting_owner'), ('accepted');
    INSERT INTO pending_actions (status) VALUES ('pending'), ('applied');
    INSERT INTO agent_dm_threads (status) VALUES ('new'), ('new'), ('new'), ('replied');
    INSERT INTO editor_slots (status, scheduled_at) VALUES
      ('failed', '2026-10-06T20:59:59Z'),  -- 23:59:59 yesterday in Kyiv: not today
      ('failed', '2026-10-06T21:00:00Z'),  -- Kyiv midnight: today
      ('failed', '2026-10-06T21:20:00Z'),
      ('published', '2026-10-06T21:10:00Z');
    INSERT INTO scheduled_publications (status, scheduled_at, updated_at) VALUES
      ('failed',  '2026-10-06T20:00:00Z', '2026-10-06T21:05:00Z'),  -- due yesterday, failed after midnight: today
      ('unknown', '2026-10-06T21:10:00Z', '2026-10-06T21:11:00Z'),
      ('failed',  '2026-10-06T18:00:00Z', '2026-10-06T18:01:00Z'),  -- failed yesterday
      ('sent',    '2026-10-06T21:15:00Z', '2026-10-06T21:15:00Z');
  `);
});
after(async () => {
  if (!url) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

test('counts, the Kyiv-midnight boundary and a missing table', { skip }, async () => {
  const { counts, generatedAt } = await new NavBadgesService(pool, () => NOW).get();
  assert.equal(generatedAt, NOW.toISOString());
  assert.deepEqual(counts, {
    agentInboxUnread: 2,
    agentInboxCritical: 1,
    directivesAwaitingOwner: 2,
    chatPendingActions: 1,
    dmThreadsNew: 3,
    dmActionsPending: null,
    slotsFailedToday: 2,
    scheduledFailedToday: 2,
  });
  // Just before Kyiv midnight, "today" is still 6 Oct (since 2026-10-05T21:00Z): the
  // 23:59:59 slot and the 21:01 (Kyiv) publication failure count again.
  const before = await new NavBadgesService(pool, () => new Date('2026-10-06T20:59:59.999Z')).get();
  assert.equal(before.counts.slotsFailedToday, 3);
  assert.equal(before.counts.scheduledFailedToday, 3);
});

test('the statement is fast (p95 under 50 ms here)', { skip }, async () => {
  const times: number[] = [];
  for (let i = 0; i < 25; i++) {
    const svc = new NavBadgesService(pool, () => NOW); // fresh: no cache
    const t0 = performance.now();
    await svc.get();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  assert.ok(p95 < 50, `p95 ${p95.toFixed(1)} ms`);
});
