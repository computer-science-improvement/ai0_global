/**
 * Spec 058 against a throwaway Postgres (init.sql + every migration, one database for this file): migration 091 and its
 * seed, links made and broken from the map (several at a time, idempotent, limits), network members in bulk (partial
 * success) and the copies that stop when a resource leaves its network. Skipped unless EDITOR_PG_TEST_URL is set.
 * Everything runs in a rolled-back transaction.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { ResourceCatalog } from '../agents/resource-catalog';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { BLOCKED_SLOT_ERROR, LEFT_NETWORK_SLOT_ERROR, MapActions } from './map.actions';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '091_promo_links.sql'), 'utf8');
const TG = '@pgtest_links_058';
let pool: Pool;
let db: FreshDb | undefined;

before(async () => { if (url) { db = await createMigratedDb(url, 'map058b'); pool = db.pool; } });
after(async () => { await db?.drop(); });

async function inTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); }
}

const status = async (fn: () => Promise<unknown>): Promise<number | 'ok'> => {
  try { await fn(); return 'ok'; } catch (err: any) { if (typeof err?.getStatus === 'function') return err.getStatus(); throw err; }
};

const mkActions = (c: PoolClient) => {
  const calls = { invalidated: 0 };
  return { calls, actions: new MapActions({ pool: c, catalog: new ResourceCatalog({ pool: c }), invalidate: () => { calls.invalidated++; } }) };
};

const ig = async (c: PoolClient, name: string, group: string | null = null, platform = 'instagram') => `${platform}:${(await c.query(
  `INSERT INTO meta_accounts (platform, account_id, target_id, username, group_id) VALUES ($1, $2, $2, $2, $3) RETURNING id`, [platform, `pglk_${name}`, group])).rows[0].id as string}`;
const tg = async (c: PoolClient, key: string, group: string | null = null) => {
  await c.query(`INSERT INTO tracked_channels (channel_key, title, is_mine, group_id) VALUES ($1, $1, true, $2)`, [key, group]);
  return `telegram:${key}`;
};
const grp = async (c: PoolClient, name: string) => (await c.query(`INSERT INTO meta_account_groups (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
const pair = async (c: PoolClient, a: string, b: string) => (await c.query(
  `SELECT linked_at IS NOT NULL AS linked, blocked_at IS NOT NULL AS blocked FROM promo_pairs WHERE source_ref = $1 AND target_ref = $2`, [a, b])).rows[0] as { linked: boolean; blocked: boolean } | undefined;

test('091: the seed links the pairs that promoted in the last 60 days, both ways, skips blocked and stale ones, runs once', { skip }, async () => {
  await inTx(async (c) => {
    await c.query(`ALTER TABLE promo_pairs DROP COLUMN linked_at`); // as before the migration
    const ins = (a: string, b: string, last: string | null, n: number, blocked = false) => c.query(
      `INSERT INTO promo_pairs (source_ref, target_ref, last_promo_at, count_30d, blocked_at)
       VALUES ($1, $2, ${last ? `now() - interval '${last}'` : 'NULL'}, $3, ${blocked ? 'now()' : 'NULL'})`, [`telegram:${a}`, `instagram:${b}`, n]);
    await ins('@s_active', 'ig1', '10 days', 2);       // one direction only: the reverse row is added
    await ins('@s_count', 'ig2', null, 1);             // a count without a date
    await ins('@s_stale', 'ig3', '90 days', 0);        // too old
    await ins('@s_blocked', 'ig4', '3 days', 1, true); // the owner stopped it
    await ins('@s_never', 'ig5', null, 0);             // only a relevance row
    await c.query(MIGRATION);
    const linked = async (a: string, b: string) => [(await pair(c, `telegram:${a}`, `instagram:${b}`))?.linked, (await pair(c, `instagram:${b}`, `telegram:${a}`))?.linked];
    assert.deepEqual(await linked('@s_active', 'ig1'), [true, true]);
    assert.deepEqual(await linked('@s_count', 'ig2'), [true, true]);
    assert.deepEqual(await linked('@s_stale', 'ig3'), [false, undefined]);
    assert.deepEqual(await linked('@s_blocked', 'ig4'), [false, undefined]);
    assert.deepEqual(await linked('@s_never', 'ig5'), [false, undefined]);
    // applied again, the seed does not run: an unlinked pair stays unlinked
    await c.query(`UPDATE promo_pairs SET linked_at = NULL WHERE source_ref = 'telegram:@s_active'`);
    await c.query(MIGRATION);
    assert.equal((await pair(c, 'telegram:@s_active', 'instagram:ig1'))?.linked, false);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '091_promo_links'`)).rows[0].n, 1);
  });
});

test('links: several at a time, both ways, idempotent; breaking one stops the pair and skips its pending promo slots', { skip }, async () => {
  await inTx(async (c) => {
    const A = await tg(c, TG);
    const B = await ig(c, 'l1'), C = await ig(c, 'l2', null, 'facebook'), D = await ig(c, 'l3', null, 'threads');
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [TG]);
    const plan = (await c.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [TG])).rows[0].id as string;
    const slot = async (st: string, from: string, to: string) => (await c.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, promo, approved_at)
       VALUES ($1, $2, now(), 'text', 't', $3, $4, CASE WHEN $3 = 'approved' THEN now() END) RETURNING id`,
      [plan, TG, st, JSON.stringify({ kind: 'cross_promo', source_ref: from, target_ref: to })])).rows[0].id as string;
    const { actions, calls } = mkActions(c);

    assert.deepEqual(await actions.setLinks({ ref: A, add: [B, C, D] }), { ref: A, linked: [B, C, D], unlinked: [], canceled: 0 });
    for (const x of [B, C, D]) { assert.deepEqual(await pair(c, A, x), { linked: true, blocked: false }); assert.deepEqual(await pair(c, x, A), { linked: true, blocked: false }); }
    assert.equal(calls.invalidated, 1);
    const first = (await c.query(`SELECT linked_at FROM promo_pairs WHERE source_ref = $1 AND target_ref = $2`, [A, B])).rows[0].linked_at as Date;
    assert.deepEqual((await actions.setLinks({ ref: A, add: [B] })).linked, [], 'a pair that is linked already is not a change');
    assert.deepEqual((await c.query(`SELECT linked_at FROM promo_pairs WHERE source_ref = $1 AND target_ref = $2`, [A, B])).rows[0].linked_at, first, 'it keeps its date');
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM map_link_events WHERE kind = 'link_made'`)).rows[0].n, 3);

    const planned = await slot('planned', A, B), approved = await slot('approved', B, A), published = await slot('published', A, B), other = await slot('planned', A, C);
    const r = await actions.setLinks({ ref: B, remove: [A], add: [D] });
    assert.deepEqual([r.linked, r.unlinked, r.canceled], [[D], [A], 2]);
    assert.deepEqual(await pair(c, A, B), { linked: false, blocked: true });
    assert.deepEqual(await pair(c, B, A), { linked: false, blocked: true });
    const st = async (id: string) => (await c.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(await st(planned), { status: 'skipped', error: BLOCKED_SLOT_ERROR });
    assert.deepEqual(await st(approved), { status: 'skipped', error: BLOCKED_SLOT_ERROR });
    assert.equal((await st(published)).status, 'published');
    assert.equal((await st(other)).status, 'planned', 'another pair is untouched');
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM map_link_events WHERE kind = 'link_broken' AND ref = $1`, [B])).rows[0].n, 1);
    assert.equal((await actions.setLinks({ ref: B, remove: [A] })).unlinked.length, 0, 'breaking it again changes nothing');

    // linking again lifts the stop
    assert.deepEqual((await actions.setLinks({ ref: A, add: [B] })).linked, [B]);
    assert.deepEqual(await pair(c, B, A), { linked: true, blocked: false });
  });
});

test('links: invalid calls are refused', { skip }, async () => {
  await inTx(async (c) => {
    const A = await tg(c, TG), B = await ig(c, 'v1');
    const { actions } = mkActions(c);
    const many = Array.from({ length: 31 }, (_, i) => `instagram:x${i}`);
    assert.equal(await status(() => actions.setLinks({ ref: A, add: many })), 400, 'more than 30');
    assert.equal(await status(() => actions.setLinks({ ref: A, add: many.slice(0, 20), remove: many.slice(20, 31) })), 400, 'more than 30 in all');
    assert.equal(await status(() => actions.setLinks({ ref: A, add: [A] })), 400, 'itself');
    assert.equal(await status(() => actions.setLinks({ ref: A, add: [B], remove: [B] })), 400, 'both ways at once');
    assert.equal(await status(() => actions.setLinks({ ref: A, add: ['nonsense'] })), 400);
    assert.equal(await status(() => actions.setLinks({ ref: A })), 'ok', 'an empty change is not an error');
    assert.equal(await status(() => actions.setLinks({ ref: A, add: ['instagram:00000000-0000-0000-0000-000000000000'] })), 404);
    assert.equal(await status(() => actions.setLinks({ ref: 'telegram:@nope_058', add: [B] })), 404);
    assert.equal(await status(() => actions.setLinks({ ref: A, add: [B], extra: 1 })), 400);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM promo_pairs WHERE $1 IN (source_ref, target_ref)`, [A])).rows[0].n, 0, 'nothing was written');
  });
});

test('promo-block compatibility: blocking unlinks, allowing links again', { skip }, async () => {
  await inTx(async (c) => {
    const A = await tg(c, TG), B = await ig(c, 'c1');
    const { actions } = mkActions(c);
    await actions.setLinks({ ref: A, add: [B] });
    assert.equal((await actions.setPairBlocked({ a: A, b: B, blocked: true })).blocked, true);
    assert.deepEqual(await pair(c, A, B), { linked: false, blocked: true });
    await actions.setPairBlocked({ a: B, b: A, blocked: false });
    assert.deepEqual(await pair(c, A, B), { linked: true, blocked: false });
    assert.deepEqual(await pair(c, B, A), { linked: true, blocked: false });
  });
});

test('members in bulk: partial success with the clashing resource named, removals first, one invalidation', { skip }, async () => {
  await inTx(async (c) => {
    const g = await grp(c, 'Pglk members');
    const A = await tg(c, TG);
    const I1 = await ig(c, 'm1'), I2 = await ig(c, 'm2'), F1 = await ig(c, 'm3', null, 'facebook');
    const { actions, calls } = mkActions(c);
    const group = async (ref: string) => (await new ResourceCatalog({ pool: c }).list()).find((r) => r.ref === ref)?.groupId ?? null;

    const r1 = await actions.setMembers({ groupId: g, add: [A, I1, I2, F1, 'instagram:00000000-0000-0000-0000-000000000000'] });
    assert.deepEqual(r1.results.map((x) => [x.ref, x.ok]), [[A, true], [I1, true], [I2, false], [F1, true], ['instagram:00000000-0000-0000-0000-000000000000', false]]);
    assert.match(r1.results[2].error!, /already has a.* Instagram account/);
    assert.match(r1.results[2].error!, /m1/, 'names the resource that holds the place');
    assert.match(r1.results[4].error!, /not one of your connected resources/);
    assert.equal(calls.invalidated, 1);
    assert.equal(await group(I2), null, 'a refused one is not moved');
    assert.equal(await group(I1), g);

    // swapping the Instagram account in one call: the removal goes first
    const r2 = await actions.setMembers({ groupId: g, add: [I2], remove: [I1, A, 'telegram:@not_there_058'] });
    assert.deepEqual(r2.results.map((x) => [x.ref, x.ok]), [[I1, true], [A, true], ['telegram:@not_there_058', false], [I2, true]]);
    assert.match(r2.results[2].error!, /not in/);
    assert.equal(await group(I1), null);
    assert.equal(await group(I2), g);
    assert.equal(await group(A), null);
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM map_link_events WHERE kind = 'network_left'`)).rows[0].n, 2);
    assert.equal((await actions.setMembers({ groupId: g, add: [I2] })).results[0].ok, true, 'adding a member is a no-op');

    assert.equal(await status(() => actions.setMembers({ groupId: '00000000-0000-0000-0000-000000000000', add: [A] })), 404);
    assert.equal(await status(() => actions.setMembers({ groupId: g, add: [A], remove: [A] })), 400);
    assert.equal(await status(() => actions.setMembers({ add: [A] })), 400);
  });
});

test('leaving a network skips the copies still to go out to or from the resource', { skip }, async () => {
  await inTx(async (c) => {
    const g = await grp(c, 'Pglk copies');
    const A = await tg(c, TG, g);
    const I1 = await ig(c, 'd1', g), F1 = await ig(c, 'd2', g, 'facebook');
    await c.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [TG]);
    const plan = (await c.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [TG])).rows[0].id as string;
    const parent = (await c.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status) VALUES ($1, $2, now(), 'text', 'p', 'published') RETURNING id`, [plan, TG])).rows[0].id as string;
    const derived = async (resource: string, st: string, from: string | null = parent) => (await c.query(
      `INSERT INTO editor_slots (plan_id, channel_key, resource_ref, scheduled_at, format, topic, status, derived_from_slot_id, treatment, approved_at)
       VALUES ($1, $2, $3, now(), 'text', 'd', $4, $5, 'adapt', CASE WHEN $4 = 'approved' THEN now() END) RETURNING id`, [plan, TG, resource, st, from])).rows[0].id as string;
    const toI1 = [await derived(I1, 'planned'), await derived(I1, 'awaiting_approval'), await derived(I1, 'approved')];
    const doneI1 = await derived(I1, 'published');
    const toF1 = await derived(F1, 'planned');
    const own = (await c.query(
      `INSERT INTO editor_slots (plan_id, channel_key, resource_ref, scheduled_at, format, topic, status) VALUES ($1, $2, $3, now(), 'text', 'own', 'planned') RETURNING id`, [plan, TG, I1])).rows[0].id as string;
    const st = async (id: string) => (await c.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [id])).rows[0];
    const { actions } = mkActions(c);

    const out = await actions.setGroup({ ref: I1, groupId: null });
    assert.equal(out.canceled, 3);
    for (const id of toI1) assert.deepEqual(await st(id), { status: 'skipped', error: LEFT_NETWORK_SLOT_ERROR });
    assert.equal((await st(doneI1)).status, 'published', 'what went out stays');
    assert.equal((await st(own)).status, 'planned', 'its own posts are not copies');
    assert.equal((await st(toF1)).status, 'planned', 'a member that stays keeps its copies');

    // the source leaves: the copies from its posts to the others stop too (the anchor's slot has no resource_ref)
    const out2 = await actions.setMembers({ groupId: g, remove: [A] });
    assert.equal(out2.canceled, 1);
    assert.deepEqual(await st(toF1), { status: 'skipped', error: LEFT_NETWORK_SLOT_ERROR });

    // joining a network does not cancel anything
    const fresh = await derived(F1, 'planned');
    assert.equal((await actions.setGroup({ ref: I1, groupId: g })).canceled, 0);
    assert.equal((await st(fresh)).status, 'planned');
  });
});
