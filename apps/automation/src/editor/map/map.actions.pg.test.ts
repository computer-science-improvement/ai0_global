/**
 * Spec 056 follow-up against a throwaway Postgres: the owner moves a resource between networks and blocks a promo pair
 * from the map. Skipped unless EDITOR_PG_TEST_URL is set. Everything runs in a rolled-back transaction.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { ResourceCatalog } from '../agents/resource-catalog';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { BLOCKED_SLOT_ERROR, MapActions } from './map.actions';
import { MapService } from './map.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const TG = '@pgtest_map_act';
let pool: Pool;
let db: FreshDb | undefined;

// A throwaway database with every migration (091 adds promo_pairs.linked_at); dropped at the end.
before(async () => { if (url) { db = await createMigratedDb(url, 'map058a'); pool = db.pool; } });
after(async () => { await db?.drop(); });

async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

const status = async (c: PoolClient, fn: () => Promise<unknown>): Promise<number | 'ok'> => {
  try { await fn(); return 'ok'; } catch (err: any) { if (typeof err?.getStatus === 'function') return err.getStatus(); throw err; }
};

test('a resource moves between networks, one per platform per network, and out of any', { skip }, async () => {
  await inTx(async (c) => {
    const g1 = (await c.query(`INSERT INTO meta_account_groups (name) VALUES ('Pgact one') RETURNING id`)).rows[0].id as string;
    const g2 = (await c.query(`INSERT INTO meta_account_groups (name) VALUES ('Pgact two') RETURNING id`)).rows[0].id as string;
    await c.query(`INSERT INTO tracked_channels (channel_key, title, is_mine, group_id) VALUES ($1, 'Act TG', true, $2)`, [TG, g1]);
    const ig1 = (await c.query(`INSERT INTO meta_accounts (platform, account_id, target_id, username, group_id) VALUES ('instagram', 'pgact1', 'pgact1', 'pgact1', $1) RETURNING id`, [g1])).rows[0].id as string;
    const ig2 = (await c.query(`INSERT INTO meta_accounts (platform, account_id, target_id, username, group_id) VALUES ('instagram', 'pgact2', 'pgact2', 'pgact2', $1) RETURNING id`, [g2])).rows[0].id as string;
    let invalidated = 0;
    const actions = new MapActions({ pool: c, catalog: new ResourceCatalog({ pool: c }), invalidate: () => { invalidated++; } });

    assert.equal(await status(c, () => actions.setGroup({ ref: `instagram:${ig1}`, groupId: g2 })), 409, 'the other network already has an Instagram account');
    assert.deepEqual(await actions.setGroup({ ref: `instagram:${ig1}`, groupId: null }), { ref: `instagram:${ig1}`, groupId: null, groupName: null, canceled: 0 });
    assert.equal((await c.query(`SELECT group_id FROM meta_accounts WHERE id = $1`, [ig1])).rows[0].group_id, null);
    assert.equal(await status(c, () => actions.setGroup({ ref: `instagram:${ig2}`, groupId: g1 })), 'ok');
    assert.equal((await c.query(`SELECT group_id FROM meta_accounts WHERE id = $1`, [ig2])).rows[0].group_id, g1);
    assert.equal((await actions.setGroup({ ref: `telegram:${TG}`, groupId: g2 })).groupName, 'Pgact two');
    assert.equal((await c.query(`SELECT group_id FROM tracked_channels WHERE channel_key = $1`, [TG])).rows[0].group_id, g2);
    assert.equal(invalidated, 3);

    assert.equal(await status(c, () => actions.setGroup({ ref: 'telegram:@nope_pgact', groupId: null })), 404);
    assert.equal(await status(c, () => actions.setGroup({ ref: `telegram:${TG}`, groupId: '00000000-0000-0000-0000-000000000000' })), 404);
    assert.equal(await status(c, () => actions.setGroup({ ref: `telegram:${TG}` })), 400);
  });
});

test('a blocked pair cancels its pending promo slots, shows on the road and can be allowed again', { skip }, async () => {
  await inTx(async (c) => {
    await c.query(`INSERT INTO tracked_channels (channel_key, title, is_mine) VALUES ($1, 'Act TG', true)`, [TG]);
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [TG]);
    const ig = (await c.query(`INSERT INTO meta_accounts (platform, account_id, target_id, username) VALUES ('instagram', 'pgact3', 'pgact3', 'pgact3') RETURNING id`)).rows[0].id as string;
    const A = `telegram:${TG}`, B = `instagram:${ig}`;
    const plan = (await c.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [TG])).rows[0].id as string;
    const slot = async (st: string, promo: object, extra = '') => (await c.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, promo${extra ? ', approved_at' : ''})
       VALUES ($1, $2, now(), 'text', 't', $3, $4${extra ? ', now()' : ''}) RETURNING id`, [plan, TG, st, JSON.stringify(promo)])).rows[0].id as string;
    const pending = await slot('planned', { kind: 'cross_promo', source_ref: A, target_ref: B });
    const approved = await slot('approved', { kind: 'cross_promo', source_ref: B, target_ref: A }, 'approved');
    const done = await slot('published', { kind: 'cross_promo', source_ref: A, target_ref: B });
    await c.query(`INSERT INTO promo_pairs (source_ref, target_ref, last_promo_at, count_30d) VALUES ($1, $2, now(), 2)`, [A, B]);

    const actions = new MapActions({ pool: c, catalog: new ResourceCatalog({ pool: c }), invalidate: () => {} });
    assert.deepEqual(await actions.setPairBlocked({ a: A, b: B, blocked: true }), { a: A, b: B, blocked: true, canceled: 2 });
    const st = async (id: string) => (await c.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(await st(pending), { status: 'skipped', error: BLOCKED_SLOT_ERROR });
    assert.deepEqual(await st(approved), { status: 'skipped', error: BLOCKED_SLOT_ERROR });
    assert.equal((await st(done)).status, 'published', 'a published promo stays');
    const rows = (await c.query(`SELECT source_ref, count_30d, blocked_at IS NOT NULL AS b FROM promo_pairs WHERE $1 IN (source_ref, target_ref) ORDER BY source_ref`, [A])).rows;
    assert.deepEqual(rows.map((r) => [r.source_ref, r.count_30d, r.b]), [[B, 0, true], [A, 2, true]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))), 'both ways; the history count stays');

    const svc = new MapService({ pool: c, agents: new AgentsRepository(c), catalog: new ResourceCatalog({ pool: c }), budgets: async () => ({ rows: [], agentCaps: [], blocking: [] }), pausedRefs: async () => new Set(), cacheMs: 0 });
    assert.equal((await svc.build()).roads.find((r) => r.from === A && r.to === B)?.blocked, true);

    assert.equal((await actions.setPairBlocked({ a: B, b: A, blocked: false })).canceled, 0);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM promo_pairs WHERE blocked_at IS NOT NULL AND $1 IN (source_ref, target_ref)`, [A])).rows[0].n, 0);
    assert.equal((await svc.build()).roads.find((r) => r.from === A && r.to === B)?.blocked, false);
    assert.equal(await status(c, () => actions.setPairBlocked({ a: A, b: A, blocked: true })), 400);
  });
});
