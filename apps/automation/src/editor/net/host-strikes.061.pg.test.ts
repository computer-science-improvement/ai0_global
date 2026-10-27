/**
 * Spec 061 FR-004 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end): host
 * blocks escalate 1 d -> 3 d -> 7 d in `source_host_failures`, a timeout is a one-hour block without a strike, a success
 * starts the strikes over (and clears `noted_at`), the third strike is claimed once, and source health reads the active
 * playbook of the channel's orchestrator. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from '../agents/testing/probe-db';
import { AgentsRepository } from '../agents/agents.repository';
import { SourceHealthRepository } from '../sources/source-health.repository';
import { SourceHealthService } from '../sources/source-health.service';
import { PgHostFailures } from './host-failures';
import { makeCard } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pg061host';
let db: ProbeDb;
let pool: Pool;
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
const row = async (host: string) => (await pool.query(`SELECT * FROM source_host_failures WHERE host = $1`, [host])).rows[0];

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p061_hosts');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('strikes: 1 d, 3 d, 7 d; a repeat inside a block is the same strike; the cap holds', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const host = 'esc.example';
  await hosts.record(host, 'refused', 403);
  let r = await row(host);
  assert.deepEqual([r.strikes, new Date(r.blocked_until).toISOString()], [1, plus(now, 24).toISOString()]);
  now = plus(now, 3);
  await hosts.record(host, 'refused', 403);
  r = await row(host);
  assert.deepEqual([r.strikes, r.failures, new Date(r.blocked_until).toISOString()], [1, 2, '2026-10-21T08:00:00.000Z'], 'same block, same strike');
  now = plus(now, 22); // 2026-10-21T09:00, the block ended
  await hosts.record(host, 'dns');
  r = await row(host);
  assert.deepEqual([r.strikes, r.reason, new Date(r.blocked_until).toISOString()], [2, 'dns', plus(now, 72).toISOString()]);
  now = plus(now, 73);
  await hosts.record(host, 'refused', 403);
  r = await row(host);
  assert.deepEqual([r.strikes, new Date(r.blocked_until).toISOString()], [3, plus(now, 168).toISOString()]);
  now = plus(now, 169);
  await hosts.record(host, 'refused', 403);
  r = await row(host);
  assert.deepEqual([r.strikes, new Date(r.blocked_until).toISOString()], [4, plus(now, 168).toISOString()]);
  assert.equal((await hosts.blocked(host, 'page'))?.until.toISOString(), plus(now, 168).toISOString());
});

test('timeout: an hour, no strike, never shortens a longer block; the strikes survive the expiry and a success resets them', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const slow = 'slow.example';
  await hosts.record(slow, 'timeout');
  let r = await row(slow);
  assert.deepEqual([r.reason, r.strikes, new Date(r.blocked_until).toISOString()], ['timeout', 0, plus(now, 1).toISOString()]);
  assert.equal((await hosts.blocked(slow, 'page'))?.reason, 'timeout');
  now = plus(now, 2);
  assert.equal(await hosts.blocked(slow, 'page'), null);

  const hard = 'hard.example';
  await hosts.record(hard, 'refused', 403);
  now = plus(now, 5);
  await hosts.record(hard, 'timeout');
  r = await row(hard);
  assert.deepEqual([r.reason, r.status_code, r.strikes, new Date(r.blocked_until).toISOString()], ['refused', 403, 1, '2026-10-21T10:00:00.000Z'], 'the day-long block is kept');
  now = plus(now, 30);
  await hosts.record(hard, 'refused', 403);
  assert.equal((await row(hard)).strikes, 2, 'the strike survived the expiry');
  await pool.query(`UPDATE source_host_failures SET noted_at = now() WHERE host = $1`, [hard]);
  await hosts.succeeded(hard);
  r = await row(hard);
  assert.deepEqual([r.strikes, r.noted_at], [0, null]);
  now = plus(now, 80);
  await hosts.record(hard, 'refused', 403);
  assert.equal((await row(hard)).strikes, 1, 'a new streak starts at one');
});

test('a feed failure is a flat day on its own address and does not touch strikes', { skip }, async () => {
  const now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  await hosts.record('feedhost.example/rss', 'feed_unparseable');
  await hosts.record('feedhost.example/rss', 'feed_unparseable');
  const r = await row('feedhost.example/rss');
  assert.deepEqual([r.strikes, new Date(r.blocked_until).toISOString()], [0, plus(now, 24).toISOString()]);
});

test('struck / claimNote / blocks / playbookOf over the real tables', { skip }, async () => {
  const repo = new SourceHealthRepository(pool);
  const now = new Date();
  const hosts = new PgHostFailures(pool, () => now);
  for (let i = 0; i < 3; i++) { await hosts.record('three.example', 'refused', 403); await pool.query(`UPDATE source_host_failures SET blocked_until = now() - interval '1 minute' WHERE host = 'three.example'`); }
  await hosts.record('three.example', 'refused', 403);
  assert.equal((await row('three.example')).strikes, 4);
  await hosts.record('two.example', 'refused', 403);
  await hosts.record('feedhost2.example/rss', 'feed_unparseable');

  const keys = ['three.example', 'two.example', 'feedhost2.example/rss'];
  assert.deepEqual((await repo.struck(keys, 3)).map((b) => b.host), ['three.example'], 'two strikes and feed addresses are not raised');
  assert.equal((await repo.blocks(keys, new Date(Date.now() - 86_400_000))).find((b) => b.host === 'three.example')?.strikes, 4);
  assert.equal(await repo.claimNote('three.example'), true);
  assert.equal(await repo.claimNote('three.example'), false, 'one note per streak');
  assert.deepEqual(await repo.struck(keys, 3), []);

  const orch = await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'P061H', handle: 'p061_hosts_orch', mode: 'live', createdBy: 'owner' });
  assert.equal(await repo.playbookOf(`telegram:${CH}`), null, 'no active playbook yet');
  const body = { platforms: [{ resource_ref: `telegram:${CH}`, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 2 } }], series: [{ name: 'AI', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' } }], rules: [] };
  await pool.query(`INSERT INTO playbooks (agent_id, version, status, body, created_by) VALUES ($1, 1, 'active', $2, 'orchestrator')`, [orch.id, JSON.stringify(body)]);
  assert.deepEqual(await repo.playbookOf(`telegram:${CH}`), body);
});

test('the daily note over the real tables: one inbox note for the struck playbook feed, then nothing; the next streak is noted again', { skip }, async () => {
  const card = makeCard({ channelKey: CH, sources: [] });
  const repo = new SourceHealthRepository(pool);
  const posts: any[] = [];
  const svc = new SourceHealthService({
    repo, channels: { get: async () => card }, pool, inbox: { post: async (i: any) => { posts.push(i); return 1; } },
  });
  const hosts = new PgHostFailures(pool);
  const expire = () => pool.query(`UPDATE source_host_failures SET blocked_until = now() - interval '1 minute' WHERE host = 'marktechpost.com'`);
  for (let i = 0; i < 3; i++) { await hosts.record('marktechpost.com', 'refused', 403); await expire(); }
  await hosts.record('marktechpost.com', 'refused', 403);
  assert.deepEqual(await svc.noteStruckHosts(card, null), ['marktechpost.com']);
  assert.equal(posts.length, 1);
  assert.match(posts[0].title, /^marktechpost\.com відмовляє нам 4 рази поспіль — прибрати з плейбука @pg061host\?$/);
  assert.deepEqual(await svc.noteStruckHosts(card, null), []);
  // The daily run entry point does the same and never fails the run.
  assert.deepEqual(await svc.toReplaceToday(card, null), []);
  assert.equal(posts.length, 1);
  // A success, then three more strikes: a new streak, a new note.
  await expire();
  await hosts.succeeded('marktechpost.com');
  for (let i = 0; i < 3; i++) { await hosts.record('marktechpost.com', 'refused', 403); await expire(); }
  await hosts.record('marktechpost.com', 'refused', 403);
  await svc.toReplaceToday(card, null);
  assert.equal(posts.length, 2);
  // Spec 070: the host's page refusals (4 strikes, still noted above) no longer stop its feed; only the feed's own row does, with no strikes.
  const report = await svc.forCard(card);
  assert.deepEqual(report.sources.map((s) => [s.id, s.origin, s.state]), [['playbook:marktechpost.com', 'playbook', 'unused']]);
  assert.equal(report.sources[0].blocked, null);
  await hosts.record('marktechpost.com/feed', 'feed_refused', 403);
  const own = await svc.forCard(card);
  assert.deepEqual(own.sources.map((s) => [s.id, s.state]), [['playbook:marktechpost.com', 'blocked']]);
  assert.deepEqual([own.sources[0].blocked?.host, own.sources[0].blocked?.reason, own.sources[0].blocked?.strikes], ['marktechpost.com/feed', 'feed_refused', 0]);
  await svc.toReplaceToday(card, null);
  assert.equal(posts.length, 2, 'a feed\'s own refusal carries no strike, so no owner note');
});
