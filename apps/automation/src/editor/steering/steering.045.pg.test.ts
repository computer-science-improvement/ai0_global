/**
 * Spec 045 against a throwaway Postgres: migration 081 (idempotent), one pending set per (target, source), the claim /
 * retry / stuck queue, activation (≤ 3, supersede, texts dropped), the prompt rules, the copy guard and the estimate.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { SteeringRepository } from './steering.repository';
import { checkSteeringCopy } from './steering-guard';
import type { SourcePost, SteeringRule } from './steering.types';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '081_steering.sql'), 'utf8');
const T = 'telegram:@pgtest_steer_045';
const T2 = 'telegram:@pgtest_steer_045_b';
const COPY = 'Жовтий сигнал світлофора не означає дозвіл проїхати перехрестя на швидкості, якщо ви ще не перетнули стоп-лінію.';
let pool: Pool;
let repo: SteeringRepository;

const post = (key: string, text: string): SourcePost => ({
  key, msgId: Number(key.slice(1)), postedAt: '2026-10-01T09:00:00.000Z', text, mediaType: null, views: 100, reactions: 3, forwards: 1, comments: 0,
});
const rule = (id: string, p: Partial<SteeringRule> = {}): SteeringRule => ({
  id, kind: 'hook', text: `Правило ${id}: починай із хибної думки`, evidence: { post_ids: ['r1'], note: 'n n n' }, conflict: null, enabled: true, ...p,
});

async function cleanup() {
  await pool.query(`DELETE FROM steering_sets WHERE target_ref = ANY($1)`, [[T, T2]]);
}

/** A set at `ready` with posts and rules. */
async function ready(target: string, source: string): Promise<string> {
  const { set } = await repo.enqueue({ targetRef: target, channelKey: target.replace('telegram:', ''), sourceRef: source, createdBy: 'owner' });
  await repo.update(set.id, {
    status: 'ready', sourceTitle: 'Ref', posts: [post('r1', COPY), post('r2', 'Другий пост')], summary: 'summary',
    rules: [rule('s1'), rule('s2', { enabled: false }), rule('s3', { conflict: { with: 'format_prefs: emoji', note: 'n n n' }, enabled: false })],
    runId: null, costUsd: 0.04,
  });
  return set.id;
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  repo = new SteeringRepository(pool);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('081 applies again; an unknown status is refused', { skip }, async () => {
  await pool.query(MIGRATION);
  await assert.rejects(
    pool.query(`INSERT INTO steering_sets (target_ref, source_ref, status, created_by) VALUES ($1, 'telegram:@x', 'maybe', 'owner')`, [T]),
    /steering_sets_status_check/);
  const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '081_steering'`);
  assert.equal(rows.length, 1);
});

test('queue: one pending set per (target, source); claim respects retry_at; stuck sets go back', { skip }, async () => {
  const a = await repo.enqueue({ targetRef: T, channelKey: '@pgtest_steer_045', sourceRef: 'telegram:@ref_q', createdBy: 'owner' });
  const twin = await repo.enqueue({ targetRef: T, channelKey: '@pgtest_steer_045', sourceRef: 'telegram:@ref_q', createdBy: 'builder' });
  assert.equal(a.created, true);
  assert.equal(twin.created, false);
  assert.equal(twin.set.id, a.set.id);
  await repo.update(a.set.id, { retryAt: new Date(Date.now() + 60_000) });
  const early = await repo.claimNext(new Date());
  assert.ok(!early || early.targetRef !== T, 'not before the retry time');
  const claimed = await repo.claimNext(new Date(Date.now() + 120_000));
  assert.equal(claimed?.id, a.set.id);
  assert.equal(claimed?.status, 'collecting');
  await pool.query(`UPDATE steering_sets SET updated_at = now() - interval '1 hour' WHERE id = $1`, [a.set.id]);
  assert.ok(await repo.requeueStuck(new Date(Date.now() - 15 * 60_000)) >= 1);
  assert.equal((await repo.get(a.set.id))?.status, 'queued');
  // The worker never overwrites a status it no longer holds.
  await repo.update(a.set.id, { status: 'discarded' });
  assert.equal(await repo.update(a.set.id, { status: 'ready' }, { from: ['analyzing'] }), null);
  assert.equal((await repo.get(a.set.id))?.status, 'discarded');
});

test('activate: ready only; a new analysis of the same source supersedes the old set and drops its texts', { skip }, async () => {
  const first = await ready(T, 'telegram:@ref_a');
  const { set: queued } = await repo.enqueue({ targetRef: T, channelKey: null, sourceRef: 'telegram:@ref_queued', createdBy: 'owner' });
  assert.deepEqual(await repo.activate(queued.id, 3), { error: 'not_ready' });
  const on = await repo.activate(first, 3);
  assert.ok('set' in on && on.set.status === 'active' && on.set.activatedAt);
  const second = await ready(T, 'telegram:@ref_a');
  await repo.activate(second, 3);
  const old = await repo.get(first);
  assert.equal(old?.status, 'superseded');
  assert.ok(old!.posts.every((p) => p.text === '') && old!.posts.length === 2, 'ids and numbers stay, texts go');
  assert.equal((await repo.get(second))?.status, 'active');
  await repo.update(queued.id, { status: 'discarded' });
});

test('activate: at most three active references per target; pause frees a place; resume rechecks', { skip }, async () => {
  const ids = [await ready(T2, 'telegram:@ref_1'), await ready(T2, 'telegram:@ref_2'), await ready(T2, 'telegram:@ref_3'), await ready(T2, 'telegram:@ref_4')];
  for (const id of ids.slice(0, 3)) assert.ok('set' in await repo.activate(id, 3));
  assert.deepEqual(await repo.activate(ids[3], 3), { error: 'too_many_active' });
  await repo.update(ids[0], { status: 'paused' });
  assert.ok('set' in await repo.activate(ids[3], 3));
  assert.deepEqual(await repo.activate(ids[0], 3), { error: 'too_many_active' }, 'resuming counts the other active sets');
});

test('prompt rules: enabled, non-conflicting rules of active sets only; the copy guard reads their texts', { skip }, async () => {
  const rules = await repo.promptRules(T);
  assert.deepEqual(rules, [{ source: '@ref_a «Ref»', kind: 'hook', text: 'Правило s1: починай із хибної думки' }]);
  assert.deepEqual(await repo.promptRules('telegram:@nobody_here'), []);
  const hit = await checkSteeringCopy(pool, T, `Пам'ятайте: ${COPY}`);
  assert.equal(hit?.error, 'steering_copy');
  assert.equal(await checkSteeringCopy(pool, T, 'Своїми словами про жовтий сигнал і стоп-лінію.'), null);
  assert.equal((await repo.list({ targetRef: T })).length >= 2, true);
  assert.equal(await repo.estimateUsd(), null, 'no analysed sets with a run yet, no ok onboarder runs in a fresh base');
});
