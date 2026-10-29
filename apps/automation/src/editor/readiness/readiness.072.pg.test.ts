/**
 * Spec 072 T6 against a throwaway database of its own (every migration applied; see testing/pg-db.ts): the real repository, the real
 * facts loader and the real doctor behind `ReadinessService`. A recheck stores and updates one row, `firstSeenAt` and the stamp
 * survive, `@X` and `@x` are one row, the sweep set is approve/live cards and open launches only, `applied_hash` is never written
 * by a recheck and is written by `setAppliedHash`, and a sweep makes no model call. Skipped unless EDITOR_PG_TEST_URL is set.
 * Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { makeCard } from '../post/testing/fixtures';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { loadChannelFacts, resolveChannelKey } from './facts';
import { closedSlotsPort } from './readiness-ports';
import { ReadinessRepository } from './readiness.repository';
import { ReadinessService, type RecheckEvent } from './readiness.service';
import { scratchDb, type ScratchDb } from './testing/pg-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;

/** Mixed case on purpose: the card's spelling is what is stored. */
const CH = '@Fx072Rd';
const MIN = 60_000;

let db: ScratchDb;
let pool: Pool;
let channels: EditorChannelsRepository;
let repo: ReadinessRepository;
let svc: ReadinessService;
let now = new Date('2026-10-20T10:00:00.000Z');
let autoOn = false;
const events: RecheckEvent[] = [];

const rowOf = async (key = CH) => (await pool.query(`SELECT * FROM channel_readiness WHERE channel_key = $1`, [key])).rows[0];
const card = (channelKey: string, mode: 'off' | 'shadow' | 'approve' | 'live', over: Record<string, unknown> = {}) =>
  channels.upsert(makeCard({ channelKey, mode, formats: { text: 1 }, hashtags: [], hashtagMin: 0, hashtagMax: 3, toolsAllow: null, ...over }));

before(async () => {
  if (!url) return;
  db = await scratchDb(url, 'ready');
  pool = db.pool;
  channels = new EditorChannelsRepository(pool);
  repo = new ReadinessRepository(pool);
  // The card has a hashtag minimum and no hashtags to take them from: an error with an auto-safe fix.
  await card(CH, 'approve', { hashtagMin: 2 });
  await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'RD', handle: 'fx072rd_orch', mode: 'approve', createdBy: 'owner' } as any);
  svc = new ReadinessService({
    repo,
    resolveKey: (k) => resolveChannelKey(pool, k),
    load: (k, at) => loadChannelFacts(pool, k, { now: at }),
    identity: async (k) => { const c = await channels.get(k); return c ? { mode: c.mode, agent: 'fx072rd_orch' } : null; },
    slots24h: closedSlotsPort(pool),
    fixes: {
      agentByHandle: async () => null, patchSkill: async () => undefined, retireMemory: async () => false, applyConflicts: async () => ({ applied: [], remaining: [] }),
      setHashtagMin: (k, m) => channels.setHashtagMin(k, m),
    },
    autoFix: () => autoOn,
    now: () => now,
  });
  svc.afterRecheck((e) => { events.push(e); });
});
after(async () => { if (db) await db.drop(); });

test('a recheck stores the row under the card\'s spelling: findings with firstSeenAt, counts, the config hash, no applied_hash, no stamp yet', { skip }, async () => {
  const v = await svc.recheck(CH.toLowerCase(), 'sweep');
  const r = await rowOf();
  assert.ok(r, 'stored under the card\'s own spelling, although the call said @fx072rd');
  assert.equal(r.checked_at.toISOString(), now.toISOString());
  assert.match(r.config_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.applied_hash, null);
  assert.equal(r.notified_at, null);
  assert.deepEqual(r.notified_blockers, []);
  const hashtag = r.findings.find((f: any) => f.check === 'hashtag_min_without_vocabulary');
  assert.ok(hashtag, JSON.stringify(r.findings.map((f: any) => f.check)));
  assert.equal(hashtag.firstSeenAt, now.toISOString());
  assert.equal(hashtag.severity, 'error');
  assert.equal(r.blockers, r.findings.filter((f: any) => f.severity === 'error').length);
  assert.equal(r.warnings, r.findings.filter((f: any) => f.severity === 'warn').length);
  assert.equal(v.channelKey, CH);
  assert.equal(v.mode, 'approve');
  assert.equal(v.blockers, r.blockers);
  assert.deepEqual(v.findings.find((f) => f.code === 'hashtag_min_without_vocabulary')?.fix, { label: 'Set minimum hashtags to 0', auto: true });
});

test('the next recheck updates the same row, keeps firstSeenAt and stamps the blockers that have been open for five minutes', { skip }, async () => {
  const first = (await rowOf()).findings.find((f: any) => f.check === 'hashtag_min_without_vocabulary').firstSeenAt;
  now = new Date(now.getTime() + 10 * MIN);
  await svc.recheck(CH, 'sweep');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM channel_readiness`)).rows[0].n, 1);
  const r = await rowOf();
  assert.equal(r.findings.find((f: any) => f.check === 'hashtag_min_without_vocabulary').firstSeenAt, first);
  assert.equal(r.checked_at.toISOString(), now.toISOString());
  const errors = r.findings.filter((f: any) => f.severity === 'error').map((f: any) => f.key).sort();
  assert.deepEqual(r.notified_blockers, errors);
  assert.equal(r.notified_at.toISOString(), now.toISOString());
});

test('a view neither stamps nor clears, and @X and @x stay one row', { skip }, async () => {
  const before = await rowOf();
  now = new Date(now.getTime() + MIN);
  await svc.recheck(CH, 'view');
  await svc.recheck(CH.toLowerCase(), 'view');
  await svc.recheck(CH.toUpperCase().replace('@', '@'), 'view');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM channel_readiness`)).rows[0].n, 1);
  const r = await rowOf();
  assert.deepEqual(r.notified_blockers, before.notified_blockers);
  assert.equal(r.notified_at.toISOString(), before.notified_at.toISOString());
  assert.equal(r.checked_at.toISOString(), now.toISOString());
});

test('applied_hash is never written by a recheck, and setAppliedHash writes it; the hooks see it', { skip }, async () => {
  assert.equal(await repo.setAppliedHash(CH, 'hash-of-074'), true);
  events.length = 0;
  now = new Date(now.getTime() + MIN);
  await svc.recheck(CH, 'owner');
  assert.equal((await rowOf()).applied_hash, 'hash-of-074');
  assert.equal(events.length, 1);
  assert.equal(events[0].appliedHash, 'hash-of-074');
  assert.equal(events[0].reason, 'owner');
  assert.equal(events[0].prevHash, events[0].hash, 'nothing in the config changed');
  assert.equal(await repo.setAppliedHash('@no_such_channel', 'x'), false);
});

test('GET: the stored row is returned inside the window with no new check; a row older than 60 seconds is checked again', { skip }, async () => {
  const stored = (await rowOf()).checked_at.toISOString();
  now = new Date(now.getTime() + 30_000);
  const quick = await svc.current(CH);
  assert.equal(quick.checkedAt, stored, 'under 60 s: the stored row');
  now = new Date(now.getTime() + 31_000);
  const again = await svc.current(CH);
  assert.equal(again.checkedAt, now.toISOString());
  assert.equal(await svc.view('@Fx072Nobody').catch((e) => e.code), 'channel_not_found');
});

test('the sweep set is the approve and live cards and the channels with an open launch, nothing else', { skip }, async () => {
  await card('@Fx072Live', 'live');
  await card('@Fx072Shadow', 'shadow');
  await card('@Fx072Off', 'off');
  await card('@Fx072Launch', 'shadow');
  await card('@Fx072Graduated', 'shadow');
  const launch = (key: string, status: string) => pool.query(`INSERT INTO channel_launches (channel_key, target_ref, brief, status) VALUES ($1, $2, 'brief', $3)`, [key, `telegram:${key}`, status]);
  await launch('@Fx072Launch', 'running');
  await launch('@Fx072Graduated', 'graduated');
  assert.deepEqual((await repo.sweepSet()).sort(), [CH, '@Fx072Launch', '@Fx072Live'].sort());
  assert.equal(await repo.inSweepSet('@Fx072Launch'), true);
  assert.equal(await repo.inSweepSet('@Fx072Shadow'), false);
  assert.equal(await repo.inSweepSet('@Fx072Graduated'), false);
  assert.equal(await repo.inSweepSet('@fx072live'), false, 'the repository takes the card\'s own spelling; the service resolves it');
});

test('a sweep checks exactly that set, one channel at a time, and makes no model call', { skip }, async () => {
  const spend = async () => ({
    usage: (await pool.query(`SELECT count(*)::int AS n FROM llm_usage`)).rows[0].n,
    runs: (await pool.query(`SELECT count(*)::int AS n FROM editor_runs`)).rows[0].n,
  });
  const before = await spend();
  events.length = 0;
  now = new Date(now.getTime() + MIN);
  const r = await svc.sweep();
  assert.deepEqual(r, { checked: 3, failed: 0 });
  assert.deepEqual(events.map((e) => e.channelKey).sort(), [CH, '@Fx072Launch', '@Fx072Live'].sort());
  assert.ok(events.every((e) => e.reason === 'sweep'));
  const keys = (await pool.query(`SELECT channel_key FROM channel_readiness ORDER BY channel_key`)).rows.map((x) => x.channel_key);
  assert.deepEqual(keys, [CH, '@Fx072Launch', '@Fx072Live'].sort(), 'no row for the shadow, off and graduated cards');
  assert.deepEqual(await spend(), before, 'no model usage, no agent run');
});

test('with READINESS_AUTO_FIX on, a sweep sets the hashtag minimum to 0 itself, shows the fix as an auto_fixed row and drops the blocker', { skip }, async () => {
  autoOn = true;
  now = new Date(now.getTime() + MIN);
  const v = await svc.recheck(CH, 'sweep');
  assert.equal((await channels.get(CH))!.hashtagMin, 0);
  const r = await rowOf();
  assert.ok(!r.findings.some((f: any) => f.check === 'hashtag_min_without_vocabulary'));
  const fixed = r.findings.filter((f: any) => f.check === 'auto_fixed');
  assert.equal(fixed.length, 1);
  assert.match(fixed[0].subject.id, new RegExp(`^hashtag_min_zero:${CH}:\\d+$`));
  assert.equal(fixed[0].firstSeenAt, now.toISOString());
  assert.equal(v.infos, r.findings.filter((f: any) => f.severity === 'info' && f.check !== 'auto_fixed').length, 'the auto_fixed row is in no total');
  // Still there on the next recheck (24 hours), and the hash of the config changed once (the hashtag minimum is config).
  const hash = r.config_hash;
  now = new Date(now.getTime() + MIN);
  await svc.recheck(CH, 'view');
  const r2 = await rowOf();
  assert.equal(r2.findings.filter((f: any) => f.check === 'auto_fixed').length, 1);
  assert.equal(r2.config_hash, hash);
  assert.equal(r2.notified_blockers.includes(r.findings.find((f: any) => f.check === 'hashtag_min_without_vocabulary')?.key), false);
});
