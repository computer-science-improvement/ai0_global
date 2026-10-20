/**
 * Spec 052 against a throwaway Postgres: migration 086 (idempotent, status check), one open launch per channel (the
 * partial unique index through ON CONFLICT), transitions guarded by status, requeue of a stuck analysis, JSON columns.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { LaunchRepository } from './launch.repository';
import { launchQueries } from './launch-queries';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '086_channel_launches.sql'), 'utf8');
const CH = '@pgtest_launch_052';
let pool: Pool;
let repo: LaunchRepository;

const NET = '@pgtest_launch_052_net';
const cleanup = async () => {
  await pool.query(`DELETE FROM channel_launches WHERE channel_key ILIKE '@pgtest_launch_052%'`);
  await pool.query(`DELETE FROM tracked_links WHERE target_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key ILIKE '@pgtest_launch_052%'`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key ILIKE '@pgtest_launch_052%'`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key ILIKE '@pgtest_launch_052%'`);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key ILIKE '@pgtest_launch_052%'`);
};

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  repo = new LaunchRepository(pool);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('086 applies again; an unknown status is refused', { skip }, async () => {
  await pool.query(MIGRATION);
  await assert.rejects(pool.query(`INSERT INTO channel_launches (channel_key, target_ref, brief, status) VALUES ($1, $2, 'b', 'weird')`, [`${CH}_x`, `telegram:${CH}_x`]));
});

test('one open launch per channel; a closed one does not block the next', { skip }, async () => {
  const a = await repo.insert({ channelKey: CH, title: 'T', brief: 'brief', refs: [{ ref: 'telegram:@ref_one', setId: null, status: 'queued', reason: null, title: null }], createdBy: 'owner' });
  assert.ok(a);
  assert.equal(a!.status, 'queued');
  assert.deepEqual(a!.refs[0].ref, 'telegram:@ref_one');
  assert.equal(await repo.insert({ channelKey: CH, title: null, brief: 'again', refs: [], createdBy: 'owner' }), null);
  assert.equal((await repo.openFor(CH.toUpperCase()))?.id, a!.id, 'the channel key matches case-insensitively');

  assert.equal(await repo.transition(a!.id, ['ready'], { status: 'running' }), null, 'guarded by the current status');
  const p = await repo.transition(a!.id, ['queued'], { status: 'preparing', botState: { state: 'ok', detail: 'd', bot: '@b' }, botCheckedAt: new Date() });
  assert.equal(p?.status, 'preparing');
  assert.equal(p?.botState?.bot, '@b');
  const f = await repo.update(a!.id, { status: 'failed', plan: { summary: 'x' }, graduation: { by: 'owner' }, costUsd: 0.0123 });
  assert.deepEqual(f?.plan, { summary: 'x' });
  assert.equal(f?.costUsd, 0.0123);
  assert.equal(await repo.openFor(CH), null);
  const b = await repo.insert({ channelKey: CH, title: null, brief: 'next', refs: [], createdBy: 'owner' });
  assert.ok(b, 'a failed launch does not block a new one');
  assert.deepEqual((await repo.list({ channel: CH })).map((l) => l.status), ['queued', 'failed']);
});

test('a launch stuck in analyzing goes back to preparing; active() honours retry_at', { skip }, async () => {
  const l = (await repo.openFor(CH))!;
  await repo.update(l.id, { status: 'analyzing' });
  await pool.query(`UPDATE channel_launches SET updated_at = now() - interval '1 hour' WHERE id = $1`, [l.id]);
  assert.equal(await repo.requeueStuck(new Date(Date.now() - 15 * 60_000)), 1);
  assert.equal((await repo.get(l.id))?.status, 'preparing');
  await repo.update(l.id, { retryAt: new Date(Date.now() + 60_000) });
  assert.ok(!(await repo.active(['preparing'], new Date())).some((x) => x.id === l.id));
  assert.ok((await repo.active(['preparing'], new Date(Date.now() + 120_000))).some((x) => x.id === l.id));
});

test('queries: published, decisions oldest first, critic verdicts, promo joins, own channels', { skip }, async () => {
  const q = launchQueries(pool);
  const start = new Date(Date.now() - 3 * 86_400_000);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, title) VALUES ($1, 'live', 'Мережа'), ($2, 'off', 'Новий')`, [NET, CH]);
  const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [CH])).rows[0].id;
  const slot = async (o: { status: string; at: Date; approvedAt?: Date | null; edited?: boolean; error?: string | null; critic?: string | null; ref?: string | null }) => pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, approved_at, approved_by, owner_edited, error, updated_at, critic, resource_ref)
     VALUES ($1, $2, $3, 'text', 't', $4, $5, CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE 'owner' END, $6, $7, $3, $8, $9)`,
    [plan, CH, o.at, o.status, o.approvedAt ?? null, o.edited ?? false, o.error ?? null, o.critic ? JSON.stringify({ verdict: o.critic }) : null, o.ref ?? null]);
  const h = (n: number) => new Date(start.getTime() + n * 3_600_000);
  await slot({ status: 'published', at: h(1), approvedAt: h(1), critic: 'pass' });
  await slot({ status: 'published', at: h(2), approvedAt: h(2), edited: true, critic: 'revise' });
  await slot({ status: 'skipped', at: h(3), error: 'rejected by owner', critic: 'reject' });
  await slot({ status: 'published', at: h(4), approvedAt: h(4), critic: 'pass', ref: `telegram:${CH}` });
  await slot({ status: 'published', at: new Date(start.getTime() - 86_400_000), approvedAt: new Date(start.getTime() - 86_400_000) });
  await slot({ status: 'published', at: h(5), ref: 'instagram:123' });
  assert.equal(await q.published(CH, start), 3);
  assert.deepEqual(await q.decisions(CH, start), ['clean', 'edited', 'rejected', 'clean']);
  assert.deepEqual(await q.critic(CH, start), { pass: 2, revise: 1, reject: 1 });

  const link = (await pool.query(
    `INSERT INTO tracked_links (kind, target_ref, source_ref, url) VALUES ('tg_invite', $1, 'telegram:@src', 'https://t.me/+pgtest052') RETURNING id`, [`telegram:${CH}`])).rows[0].id;
  await pool.query(`INSERT INTO link_joins (link_id, joined_at, count) VALUES ($1, now(), 2), ($1, now() - interval '30 days', 5)`, [link]);
  assert.equal(await q.joins(`telegram:${CH}`, start), 2);

  await pool.query(`INSERT INTO tracked_channels (channel_key, title, is_mine, subs_count) VALUES ($1, 'Мережа TG', true, 300), ($2, 'Новий', true, 0)`, [NET, CH]);
  const own = await q.ownChannels(CH);
  const net = own.find((c) => c.key === NET);
  assert.deepEqual(net && { title: net.title, subs: net.subs }, { title: 'Мережа', subs: 300 });
  assert.ok(!own.some((c) => c.key === CH), 'the launched channel is not its own promo source');
});
