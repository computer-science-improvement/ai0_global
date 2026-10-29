/**
 * Spec 076 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end): migration 100 up and
 * down, the `unreachable` strike through `PgHostFailures.record`, `succeeded` and what it keeps. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import { createProbeDb, MIGRATIONS_DIR, type ProbeDb } from '../agents/testing/probe-db';
import { PgHostFailures, feedKey } from './host-failures';
import { probeSource, type ProbeOpts, type ProbeResult } from '../sources/probe';
import { PgSourceProbes } from '../sources/source-probes.repository';
import { SourceHealthRepository } from '../sources/source-health.repository';
import { SourceHealthService } from '../sources/source-health.service';
import { OwnerInbox } from '../agents/owner-inbox';
import { makeCard } from '../post/testing/fixtures';
import { DataStore } from '../../data/data-store';
import { ContentLedger } from '../../data/content-ledger';
import { AgentsRepository } from '../agents/agents.repository';
import { sourceHealthOf } from '../sources/source-wiring';
import { NetworkHealthService } from '../health/network-health.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
const row = async (host: string) => (await pool.query(`SELECT * FROM source_host_failures WHERE host = $1`, [host])).rows[0];
const iso = (v: unknown) => new Date(v as string).toISOString();

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p076_reach');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('migration 100: up, the down twice, then up again (A17)', { skip }, async () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '100_source_reach.sql'), 'utf8');
  const down = readFileSync(join(MIGRATIONS_DIR, 'down', '100_source_reach.down.sql'), 'utf8');
  const exists = async () => ({
    table: (await pool.query(`SELECT to_regclass('public.source_probes') AS t`)).rows[0].t !== null,
    cols: (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'source_host_failures'
          AND column_name IN ('consecutive_timeouts','timeouts_since','last_success_at') ORDER BY 1`)).rows.map((r) => r.column_name),
    version: (await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '100_source_reach'`)).rowCount,
  });
  assert.deepEqual(await exists(), { table: true, cols: ['consecutive_timeouts', 'last_success_at', 'timeouts_since'], version: 1 });
  await pool.query(`INSERT INTO source_host_failures (host, reason, blocked_until, strikes) VALUES ('mig.example', 'unreachable', now() + interval '1 day', 1)`);
  await pool.query(down);
  await pool.query(down);
  assert.deepEqual(await exists(), { table: false, cols: [], version: 0 });
  assert.equal((await row('mig.example')).reason, 'timeout', 'the old code does not know `unreachable`');
  await pool.query(up);
  await pool.query(up);
  assert.deepEqual(await exists(), { table: true, cols: ['consecutive_timeouts', 'last_success_at', 'timeouts_since'], version: 1 });
  await pool.query(`DELETE FROM source_host_failures WHERE host = 'mig.example'`);
});

test('record: three timeouts at least an hour apart make an unreachable strike, then 3 d and 7 d; a timeout inside a block is not counted', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const host = 'geo.example';
  await hosts.record(host, 'timeout');
  let r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts, iso(r.blocked_until)], ['timeout', 0, 1, plus(now, 1).toISOString()]);
  now = plus(now, 0.25); // inside the hour: the same attempt
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.consecutive_timeouts, r.failures, iso(r.blocked_until)], [1, 2, plus(now, 1).toISOString()]);
  now = plus(now, 2);
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['timeout', 0, 2]);
  now = plus(now, 2);
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts, iso(r.blocked_until)], ['unreachable', 1, 3, plus(now, 24).toISOString()]);
  assert.equal(iso(r.timeouts_since), '2026-10-20T08:00:00.000Z', 'the streak started with the first timeout');
  const b = await hosts.blocked(host, 'page');
  assert.equal(b?.reason, 'unreachable');
  assert.equal((await hosts.blocked(host, 'feed'))?.reason, 'unreachable', 'pages and feeds alike');

  now = plus(now, 3); // a timeout inside the block: nothing changes but the note of the attempt
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['unreachable', 1, 3]);
  assert.equal(iso(r.blocked_until), plus(new Date('2026-10-20T12:15:00Z'), 24).toISOString(), 'the day-long block is not shortened');

  now = plus(now, 25); // the block ended
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts, iso(r.blocked_until)], ['unreachable', 2, 4, plus(now, 72).toISOString()]);
  now = plus(now, 73);
  await hosts.record(host, 'timeout');
  r = await row(host);
  assert.deepEqual([r.strikes, iso(r.blocked_until)], [3, plus(now, 168).toISOString()]);
});

test('record: the window slides on the last failure; a refusal keeps the count and the strikes of a timeout streak alone', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const host = 'quiet.example';
  await hosts.record(host, 'timeout');
  now = plus(now, 2);
  await hosts.record(host, 'timeout');
  now = plus(now, 24 * 15); // over 14 days since the last failure
  await hosts.record(host, 'timeout');
  let r = await row(host);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['timeout', 0, 1], 'the count started over');
  assert.equal(iso(r.timeouts_since), now.toISOString());

  const mixed = 'mixed.example';
  await hosts.record(mixed, 'timeout');
  now = plus(now, 2);
  await hosts.record(mixed, 'timeout');
  now = plus(now, 2);
  await hosts.record(mixed, 'refused', 403);
  r = await row(mixed);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['refused', 1, 2], 'the refusal is a strike and leaves the count');
  now = plus(now, 25);
  await hosts.record(mixed, 'timeout');
  r = await row(mixed);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['unreachable', 2, 3]);
});

test('succeeded (A2): a page success resets everything; a feed success keeps a refusal streak; both end a timeout / unreachable block', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);

  // A refused streak with strikes 2 and a note: a feed success keeps both, a page success resets them.
  const refused = 'refused.example';
  await hosts.record(refused, 'refused', 403);
  now = plus(now, 25);
  await hosts.record(refused, 'refused', 403);
  await pool.query(`UPDATE source_host_failures SET noted_at = $2 WHERE host = $1`, [refused, now]);
  now = plus(now, 1);
  await hosts.succeeded(refused, 'feed');
  let r = await row(refused);
  assert.equal(r.strikes, 2, 'a working feed never wipes the page refusals of its host');
  assert.ok(r.noted_at);
  assert.equal(iso(r.last_success_at), now.toISOString());
  assert.equal(iso(r.blocked_until), plus(new Date('2026-10-21T09:00:00Z'), 72).toISOString(), 'a refusal block is not ended');
  await hosts.succeeded(refused);
  r = await row(refused);
  assert.deepEqual([r.strikes, r.noted_at], [0, null]);

  // A feed success ends an unreachable block and writes last_success_at.
  const geo = 'ended.example';
  for (let i = 0; i < 3; i++) {
    await hosts.record(geo, 'timeout');
    now = plus(now, 2);
  }
  r = await row(geo);
  assert.equal(r.reason, 'unreachable');
  assert.ok((await hosts.blocked(geo, 'page')));
  await pool.query(`UPDATE source_host_failures SET noted_at = $2 WHERE host = $1`, [geo, now]);
  await hosts.succeeded(geo, 'feed');
  r = await row(geo);
  assert.deepEqual([r.strikes, r.noted_at, r.consecutive_timeouts, r.timeouts_since], [0, null, 0, null]);
  assert.equal(iso(r.last_success_at), now.toISOString());
  assert.equal(iso(r.blocked_until), now.toISOString(), 'the block ends now');
  assert.equal(await hosts.blocked(geo, 'page'), null);

  // A new streak starts at one.
  now = plus(now, 1);
  await hosts.record(geo, 'timeout');
  r = await row(geo);
  assert.deepEqual([r.reason, r.strikes, r.consecutive_timeouts], ['timeout', 0, 1]);

  // A page success on a timeout block does the same, and a host with no row is a no-op.
  await hosts.succeeded(geo);
  assert.equal(await hosts.blocked(geo, 'page'), null);
  await hosts.succeeded('norow.example');
  assert.equal(await row('norow.example'), undefined);
});

test('succeeded: the feed key recovers after a good read (A8)', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const key = feedKey('https://feeds.example/rss/all.xml')!;
  for (let i = 0; i < 3; i++) {
    await hosts.record(key, 'timeout');
    now = plus(now, 2);
  }
  assert.equal((await row(key)).reason, 'unreachable');
  assert.equal((await hosts.blocked(key, 'feed'))?.reason, 'unreachable');
  await hosts.succeeded(key, 'feed');
  assert.equal(await hosts.blocked(key, 'feed'), null);
  assert.equal(iso((await row(key)).last_success_at), now.toISOString());
});

const probeRow = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  ok: true, failure_class: null, status: 200, kind: 'rss', feed_url: 'https://cache.example/rss', items: 4, newest_at: '2026-10-29T10:00:00.000Z',
  sample_titles: ['A', 'B'], checked_at: '2026-10-29T12:00:00.000Z', via_proxy: false, url: 'https://cache.example/rss', detail: '4 items, newest 2 h ago',
  ms: 120, cached: false, blocked_until: null, ...over,
});

test('source_probes: put / get round trip, an upsert by canonical URL, latest() by the address as written; invalid is never stored', { skip }, async () => {
  const probes = new PgSourceProbes(pool);
  await probes.put(probeRow());
  const got = await probes.get('https://CACHE.example/rss/#frag');
  assert.deepEqual(got, probeRow(), 'the same address under another spelling');
  await probes.put(probeRow({ ok: false, failure_class: 'timeout', status: null, items: 0, newest_at: null, sample_titles: [], detail: 'timed out twice (10 s)', checked_at: '2026-10-29T13:00:00.000Z' }));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM source_probes WHERE host = 'cache.example'`)).rows[0].n, 1);
  assert.deepEqual([(await probes.get('https://cache.example/rss'))?.failure_class, (await probes.get('https://cache.example/rss'))?.ok], ['timeout', false]);
  await probes.put(probeRow({ ok: false, failure_class: 'invalid', url: 'http://127.0.0.1/a' }));
  assert.equal(await probes.get('http://127.0.0.1/a'), null);
  const latest = await probes.latest(['https://cache.example/rss/', 'https://nothing.example/']);
  assert.deepEqual([...latest.keys()], ['https://cache.example/rss/']);
  assert.equal(latest.get('https://cache.example/rss/')?.failure_class, 'timeout');
  assert.equal((await probes.latest([])).size, 0);
});

test('probeSource over the real cache and host record: a geoblocked host is read twice, recorded once, then answered from the cache; a good feed is cached for 6 h', { skip }, async () => {
  let now = new Date('2026-10-29T12:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const store = new PgSourceProbes(pool);
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let calls = 0;
  const geo = async () => { calls++; throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }); };
  const probe = (url: string, get: () => Promise<any>, o: Partial<ProbeOpts> = {}) =>
    probeSource(url, { kind: 'url', store, hosts, http: { lookup, get }, now: () => now, retryMs: 0, ...o });

  const first = await probe('https://zakon.geo.example/print', geo);
  assert.deepEqual([first.failure_class, first.detail, calls], ['timeout', 'timed out twice (10 s)', 2]);
  const r = await row('zakon.geo.example');
  assert.deepEqual([r.reason, r.consecutive_timeouts, r.strikes], ['timeout', 1, 0], 'one record(host, timeout) for the two tries');
  assert.equal((await store.get('https://zakon.geo.example/print'))?.failure_class, 'timeout');

  now = plus(now, 1.5); // the hour block is over, the cache is not
  assert.equal((await probe('https://zakon.geo.example/print', geo)).cached, true);
  assert.equal(calls, 2, 'no request inside the cache');
  now = plus(now, 5); // 6.5 h: the cache expired; the earlier timeout is counted again
  const again = await probe('https://zakon.geo.example/print', geo);
  assert.deepEqual([again.cached, calls], [false, 4]);
  assert.equal((await row('zakon.geo.example')).consecutive_timeouts, 2);
  // A forced probe inside an unreachable block is answered by a request and not counted again.
  now = plus(now, 7);
  await probe('https://zakon.geo.example/print', geo, { force: true });
  assert.equal((await row('zakon.geo.example')).reason, 'unreachable');
  const blocked = await probe('https://zakon.geo.example/other', geo);
  assert.deepEqual([blocked.failure_class, blocked.cached, typeof blocked.blocked_until], ['timeout', false, 'string']);
  assert.equal(await store.get('https://zakon.geo.example/other'), null, 'a block answer is not stored');

  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>One</title><link>https://ok.example/1</link><pubDate>${now.toUTCString()}</pubDate></item></channel></rss>`;
  let feedCalls = 0;
  const getFeed = async () => { feedCalls++; return { status: 200, headers: { 'content-type': 'application/rss+xml' }, data: feed }; };
  const ok = await probe('https://ok.example/rss', getFeed, { kind: 'rss' });
  assert.deepEqual([ok.ok, ok.items, ok.kind], [true, 1, 'rss']);
  now = plus(now, 5.9);
  assert.equal((await probe('https://ok.example/rss', getFeed, { kind: 'rss' })).cached, true);
  now = plus(now, 0.2);
  assert.equal((await probe('https://ok.example/rss', getFeed, { kind: 'rss' })).cached, false);
  assert.equal(feedCalls, 2);
});

// ── the host notes through the note gate (A9) ────────────────────────────────────────────────────────────────────────
/** Three timeouts two hours apart from `start`: an `unreachable` strike. Returns the clock after them. */
async function makeUnreachable(hosts: PgHostFailures, setNow: (d: Date) => void, host: string, start: Date): Promise<Date> {
  let t = start;
  for (let i = 0; i < 3; i++) { setNow(t); await hosts.record(host, 'timeout'); t = plus(t, 2); }
  return t;
}
const rssCard = (channelKey: string, host: string) => makeCard({ channelKey, sources: [{ id: 'feed', kind: 'rss', ref: `https://${host}/rss` }] });
const hostNotes = async (like: string) => (await pool.query(
  `SELECT title, severity, ref_type, ref_id, subject, parts FROM agent_inbox WHERE kind = 'host_struck' AND ref_id LIKE $1 ORDER BY id`, [like])).rows;

test('host notes: two channels on one struck host get one note each, and a second run gets none', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  await makeUnreachable(hosts, (d) => { now = d; }, 'shared.example', now);
  assert.equal((await row('shared.example')).reason, 'unreachable');
  const inbox = new OwnerInbox(pool);
  const repo = new SourceHealthRepository(pool);
  const cardA = rssCard('@note_a', 'shared.example');
  const cardB = rssCard('@note_b', 'shared.example');
  const svc = (card: ReturnType<typeof makeCard>) => new SourceHealthService({ repo, channels: { get: async () => card }, pool, inbox });
  assert.deepEqual(await svc(cardA).noteStruckHosts(cardA, null), ['shared.example']);
  assert.deepEqual(await svc(cardB).noteStruckHosts(cardB, null), ['shared.example']);
  const notes = await hostNotes('@note_%/shared.example%');
  assert.deepEqual(notes.map((n) => [n.ref_type, n.subject, n.severity]), [
    ['host', 'host_struck:@note_a/shared.example', 'action'], ['host', 'host_struck:@note_b/shared.example', 'action'],
  ]);
  assert.equal(notes[0].title, 'shared.example cannot be reached from the server');
  assert.deepEqual(notes[0].parts, ['unreachable', 'strikes:1', 'since:never']);
  assert.ok(notes[0].ref_id.startsWith('@note_a/shared.example#'), 'the gate adds the parts key; the channel/host prefix stays');
  assert.deepEqual(await svc(cardA).noteStruckHosts(cardA, null), [], 'the same streak says nothing new');
  assert.deepEqual(await svc(cardB).noteStruckHosts(cardB, null), []);
  assert.equal((await hostNotes('@note_%/shared.example%')).length, 2);
});

test('host notes: a success, then a new streak is a new `since:` part and a new note', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const end = await makeUnreachable(hosts, (d) => { now = d; }, 'again.example', now);
  const inbox = new OwnerInbox(pool);
  const card = rssCard('@note_c', 'again.example');
  const svc = new SourceHealthService({ repo: new SourceHealthRepository(pool), channels: { get: async () => card }, pool, inbox });
  assert.deepEqual(await svc.noteStruckHosts(card, null), ['again.example']);
  now = plus(end, 30);
  await hosts.succeeded('again.example', 'page');
  const r = await row('again.example');
  assert.deepEqual([r.strikes, r.consecutive_timeouts, r.noted_at], [0, 0, null]);
  assert.deepEqual(await svc.noteStruckHosts(card, null), [], 'recovered: no strike, nothing to say');
  await makeUnreachable(hosts, (d) => { now = d; }, 'again.example', plus(now, 1));
  assert.deepEqual(await svc.noteStruckHosts(card, null), ['again.example']);
  const notes = await hostNotes('@note_c/again.example%');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes[0].parts.slice(0, 2), ['unreachable', 'strikes:1']);
  assert.equal(notes[0].parts[2], 'since:never');
  assert.equal(notes[1].parts[2], 'since:20261021T2000', 'the streak now starts at the success of 2026-10-21 20:00');
});

test('host notes: a legacy host the 061 code already noted (noted_at set) stays quiet until a success clears it', { skip }, async () => {
  let now = new Date('2026-10-20T08:00:00Z');
  const hosts = new PgHostFailures(pool, () => now);
  const end = await makeUnreachable(hosts, (d) => { now = d; }, 'legacy.example', now);
  await pool.query(`UPDATE source_host_failures SET noted_at = now() WHERE host = 'legacy.example'`);
  const inbox = new OwnerInbox(pool);
  const card = rssCard('@note_d', 'legacy.example');
  const svc = new SourceHealthService({ repo: new SourceHealthRepository(pool), channels: { get: async () => card }, pool, inbox });
  assert.deepEqual(await svc.noteStruckHosts(card, null), []);
  assert.equal((await hostNotes('@note_d/%')).length, 0);
  now = plus(end, 30);
  await hosts.succeeded('legacy.example', 'page');
  await makeUnreachable(hosts, (d) => { now = d; }, 'legacy.example', plus(now, 1));
  assert.deepEqual(await svc.noteStruckHosts(card, null), ['legacy.example'], 'the next streak is heard of');
  // The new code never sets noted_at.
  assert.equal((await row('legacy.example')).noted_at, null);
});

// ── coverage (A22, A23): the shape of @ai0_prompts_dev ───────────────────────────────────────────────────────────────
test('a card with no sources and a library series: one source row with its runway on the agent report and on network health; empty = exhausted', { skip }, async () => {
  const CHAN = '@e2e_prompts076';
  const RES = `telegram:${CHAN}`;
  const key = 'p076_prompts';
  const store = new DataStore(pool);
  await store.createSchema({
    key, title: key, description: 'series source runway', entity: 'item',
    fields: [{ name: 'label', type: 'text', description: 'Label' }], roles: { title: 'label' }, dedup_key: [], language: 'uk', default_license: 'own',
    reuse_policy: { kind: 'never' }, suitable_for: 'tests', contains_personal_data: false, status: 'active',
  } as any, 'pgtest');
  await store.upsert(key, [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] as any);
  const ids = (await pool.query(`SELECT d.id::text AS id FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1 ORDER BY d.id`, [key])).rows.map((r) => r.id as string);

  const orch = await new AgentsRepository(pool).insert({ kind: 'orchestrator', scope: 'resource', scopeId: RES, name: 'P076P', handle: 'p076_prompts_orch', mode: 'live', createdBy: 'owner' });
  const body = {
    platforms: [{ resource_ref: RES, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 2 } }],
    series: [{ name: 'Prompt of the day', cadence: 'daily@10:00', resource_ref: RES, source: { kind: 'library', table: key } }], rules: [],
  };
  await pool.query(`INSERT INTO playbooks (agent_id, version, status, body, created_by) VALUES ($1, 1, 'active', $2, 'orchestrator')`, [orch.id, JSON.stringify(body)]);

  const card = makeCard({ channelKey: CHAN, sources: [] });
  const svc = sourceHealthOf(pool, { get: async () => card });
  const report = (await svc.forChannel(CHAN))!;
  assert.equal(report.noSources, false);
  assert.deepEqual(report.sources.map((x) => [x.id, x.kind, x.ref, x.origin, x.state]), [['series:Prompt of the day', 'library', key, 'playbook', 'unused']]);
  assert.deepEqual(report.sources[0].runway, { unposted: 4, days: 4, rounds: false }, 'four rows left, one a day');

  // Every row posted on this resource: no unposted rows and no rounds.
  const ledger = new ContentLedger(pool);
  for (const id of ids) await ledger.record(`data://${key}/${id}`, { resourceRef: RES, origin: 'editor', status: 'published' });
  const empty = (await svc.forChannel(CHAN))!;
  assert.deepEqual([empty.sources[0].state, empty.sources[0].detail, empty.sources[0].runway?.unposted], ['exhausted', 'no unposted rows left', 0]);

  // Network health lists it although the card has no source of its own; a channel with nothing at all is skipped.
  const blank = makeCard({ channelKey: '@e2e_blank076', sources: [] });
  const health = await new NetworkHealthService({
    pool, channels: { listActive: async () => [card, blank] }, budgets: async () => ({ rows: [], agentCaps: [], blocking: [] }),
    sources: (c) => sourceHealthOf(pool, { get: async () => c }).forCard(c),
  }).health();
  assert.deepEqual(health.sources.map((x) => [x.channelKey, x.id, x.state, x.runway?.unposted]), [[CHAN, 'series:Prompt of the day', 'exhausted', 0]]);
});
