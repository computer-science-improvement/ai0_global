/**
 * Spec 023 T7 phase B safety net against a throwaway Postgres (all migrations): an enabled, not retired
 * binding is reported (log + ONE owner Inbox note per Kyiv day through the real OwnerInbox.postOnce); paused and
 * retired bindings are not; runs left at 'running' are closed. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { OwnerInbox } from '../editor/agents/owner-inbox';
import { checkLegacyBindings, LEGACY_BINDINGS_KIND } from './legacy-bindings.check';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt_legacy_b';
let pool: Pool;
let channelId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE kind = $1`, [LEGACY_BINDINGS_KIND]);
  await pool.query(`DELETE FROM strategy_runs WHERE ext_id LIKE 'pgtlb-%'`);
  await pool.query(`DELETE FROM strategy_bindings WHERE ext_id LIKE 'pgtlb-%'`);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  channelId = (await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'pgt_legacy_b', 'Legacy', true) RETURNING id`, [CH])).rows[0].id;
  const ins = (ext: string, type: string, enabled: boolean) => pool.query(
    `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled) VALUES ($1, $2, $3, '0 9 * * *', '{}', $4) RETURNING id`,
    [ext, type, channelId, enabled]);
  const on = (await ins('pgtlb-recipes', 'recipes', true)).rows[0].id;
  await ins('pgtlb-quotes', 'quotes', false);
  await ins('pgtlb-facts', 'facts', false);
  await pool.query(
    `UPDATE strategy_bindings SET retired_at = now(), retired_reason = 'migrated' WHERE ext_id = 'pgtlb-facts'`);
  await pool.query(`INSERT INTO strategy_runs (strategy_id, ext_id, status) VALUES ($1, 'pgtlb-recipes', 'running')`, [on]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('boot check: enabled bindings → one Inbox note per Kyiv day; paused / retired ignored; orphaned runs closed', { skip }, async () => {
  const alerts: string[] = [];
  const warns: string[] = [];
  const inbox = new OwnerInbox(pool, async (t) => { alerts.push(t); });
  const log = { warn: (m: string) => { warns.push(m); }, log: () => {} };
  const now = () => new Date('2030-05-01T09:00:00Z');

  const first = await checkLegacyBindings({ pool, inbox, log, now });
  const mine = first.bindings.filter((b) => b.extId.startsWith('pgtlb-'));
  assert.deepEqual(mine, [{ extId: 'pgtlb-recipes', type: 'recipes', platform: 'telegram', target: CH }]);
  assert.ok(first.noted, 'a note was written');
  assert.ok(first.orphanedRuns >= 1);
  const run = (await pool.query(`SELECT status, error FROM strategy_runs WHERE ext_id = 'pgtlb-recipes'`)).rows[0];
  assert.deepEqual([run.status, run.error], ['error', 'interrupted: service restarted mid-run']);

  const items = (await pool.query(`SELECT severity, title, body, ref_type, ref_id FROM agent_inbox WHERE kind = $1`, [LEGACY_BINDINGS_KIND])).rows;
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'action');
  assert.deepEqual([items[0].ref_type, items[0].ref_id], ['legacy_bindings_day', '2030-05-01']);
  assert.match(items[0].body, /Legacy strategy bindings are enabled but no longer run: .*@pgt_legacy_b \(recipes\)/);
  assert.doesNotMatch(items[0].body, /quotes|facts/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /no longer run/);

  // Same day, second boot: no new note, no new alert (still a log warning).
  const again = await checkLegacyBindings({ pool, inbox, log, now });
  assert.equal(again.noted, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_inbox WHERE kind = $1`, [LEGACY_BINDINGS_KIND])).rows[0].n, 1);
  assert.equal(alerts.length, 1);
  assert.equal(warns.filter((w) => /no longer run/.test(w)).length, 2);

  // Pausing the binding clears it.
  await pool.query(`UPDATE strategy_bindings SET enabled = false WHERE ext_id = 'pgtlb-recipes'`);
  const cleared = await checkLegacyBindings({ pool, inbox, log, now: () => new Date('2030-05-02T09:00:00Z') });
  assert.deepEqual(cleared.bindings.filter((b) => b.extId.startsWith('pgtlb-')), []);
});
