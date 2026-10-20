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

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '086_channel_launches.sql'), 'utf8');
const CH = '@pgtest_launch_052';
let pool: Pool;
let repo: LaunchRepository;

const cleanup = () => pool.query(`DELETE FROM channel_launches WHERE channel_key ILIKE '@pgtest_launch_052%'`);

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
