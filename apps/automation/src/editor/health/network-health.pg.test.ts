/**
 * Spec 049 FR-005 against a throwaway Postgres: the stuck-work, connection and budget SQL of the network health view.
 * Skipped unless EDITOR_PG_TEST_URL is set. Everything runs in a rolled-back transaction; rows are dated far in the past
 * so they come first among the shared suites' rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { SpendRepository } from '../../spend/spend.repository';
import { budgetSnapshot } from '../../spend/spend.service';
import { NetworkHealthService } from './network-health.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgtest_health_049';
const HANDLE = 'pgtest_health_049';
let pool: Pool;

before(async () => { if (url) pool = new Pool({ connectionString: url }); });
after(async () => { await pool?.end(); });

async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

test('stuck work, bad connections and the budget snapshot come out of the real schema', { skip }, async () => {
  await inTx(async (c) => {
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'shadow')`, [CH]);
    const plan = (await c.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [CH])).rows[0].id;
    const old = `now() - interval '400 days'`;
    const slot = async (status: string, at: string, extra = '') => (await c.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, updated_at${extra ? ', error' : ''})
       VALUES ($1, $2, ${at}, 'text', $3, $4, ${at}${extra ? ', $5' : ''}) RETURNING id`,
      extra ? [plan, CH, `t-${status}`, status, extra] : [plan, CH, `t-${status}`, status])).rows[0].id as string;
    const running = await slot('running', old);
    const overdue = await slot('planned', old);
    const awaiting = await slot('awaiting_approval', old);
    const failed = await slot('failed', `now() - interval '23 hours 59 minutes'`, 'publish_failed: 400');
    await slot('failed', `now() - interval '3 days'`, 'old failure');
    await c.query(`INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, error)
                   VALUES ($1, $2, now() + interval '1 hour', 'text', 'b', 'planned', 'waiting for budget: agents cap')`, [plan, CH]);

    const agent = (await c.query(
      `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Editor', $2, 'shadow') RETURNING id`,
      [`telegram:${CH}`, HANDLE])).rows[0].id;
    const action = (await c.query(
      `INSERT INTO pending_actions (agent_id, kind, payload, summary, created_at) VALUES ($1, 'change_source', $2, 'Replace source', ${old}) RETURNING id`,
      [agent, { channelKey: CH }])).rows[0].id;
    const pb = (await c.query(
      `INSERT INTO playbooks (agent_id, version, status, body, created_by, created_at) VALUES ($1, 1, 'pending_owner', '{}', 'orchestrator', ${old}) RETURNING id`,
      [agent])).rows[0].id;
    const idea = (await c.query(
      `INSERT INTO content_ideas (agent_id, title, origin, expires_at, created_at) VALUES ($1, 'An idea', 'orchestrator', now() + interval '1 day', ${old}) RETURNING id`,
      [agent])).rows[0].id;
    await c.query(`INSERT INTO resource_profiles (resource_ref, resource_health, updated_by) VALUES ($1, $2, 'system')
                   ON CONFLICT (resource_ref) DO UPDATE SET resource_health = EXCLUDED.resource_health`,
      [`telegram:${CH}`, { state: 'no_access', detail: 'bot removed', checkedAt: new Date().toISOString() }]);

    const svc = new NetworkHealthService({
      pool: c, channels: { listActive: async () => [] }, sources: async () => { throw new Error('unused'); },
      budgets: () => budgetSnapshot(new SpendRepository(c)),
    });
    const h = await svc.health();
    const ids = (kind: string) => h.stuck.find((g) => g.kind === kind)?.items.map((i) => i.id) ?? [];
    assert.ok(ids('slot_running').includes(running));
    assert.ok(ids('slot_overdue').includes(overdue));
    assert.ok(ids('approval_waiting').includes(awaiting));
    assert.ok(ids('slot_failed').includes(failed));
    assert.ok(!h.stuck.find((g) => g.kind === 'slot_failed')!.items.some((i) => i.detail === 'old failure'), 'a failure older than 24 h is not stuck');
    assert.ok(ids('action_waiting').includes(action));
    assert.equal(h.stuck.find((g) => g.kind === 'action_waiting')!.items.find((i) => i.id === action)!.agent, HANDLE);
    assert.ok(ids('playbook_waiting').includes(pb));
    assert.ok(ids('ideas_waiting').includes(idea));
    const mine = h.connections.find((x) => x.ref === `telegram:${CH}`);
    assert.deepEqual([mine?.state, mine?.detail, mine?.agent], ['no_access', 'bot removed', HANDLE]);
    assert.ok(h.budget.slotsHit >= 1);
    assert.ok(Array.isArray(h.budget.lines) && Array.isArray(h.budget.blocking));
  });
});
