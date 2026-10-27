/**
 * Spec 061 FR-004: host blocks escalate 1 d -> 3 d -> 7 d, a timeout is a one-hour block that is not a strike, the
 * strikes start over after a successful fetch, source health sees the playbook's feeds, and the third strike is one owner
 * note. Pure and fake-pool tests; the real tables are covered by host-strikes.061.pg.test.ts.
 *
 * Spec 070 changes on purpose: a connection reset is no longer thrown but retried once and recorded as a timeout; feed
 * failures (`feed_*`) carry no strikes; an RSS source is not blocked by a host `refused` row, so a dead feed reaches the
 * owner through source health `failing`, not through strikes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource } from '../card';
import { makeCard } from '../post/testing/fixtures';
import {
  classifyTimeout, classifyTransient, fetchPageGuarded, nextBlock, resetFailure, retryReset, strikeHours,
  type HostBlock, type HostFailureReason, type HostFailures, type PrevBlock,
} from './host-failures';
import { playbookSources } from '../sources/playbook-feeds';
import { SourceHealthService } from '../sources/source-health.service';
import { needsReplacement, sourceHealthOf, type HostBlockRow } from '../sources/source-health';

const T0 = new Date('2026-10-20T08:00:00Z');
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);

test('strikeHours: 1 d, 3 d, then the 7 d cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(strikeHours), [24, 24, 72, 168, 168, 168]);
});

test('nextBlock: a refusal after the block ended is the next strike; inside a block it is the same one; 7 d is the cap', () => {
  const a = nextBlock(null, 'refused', T0);
  assert.deepEqual([a.strikes, a.until.toISOString(), a.keep], [1, plus(T0, 24).toISOString(), false]);
  const inside = nextBlock({ reason: 'refused', blockedUntil: a.until, strikes: 1 }, 'refused', plus(T0, 2));
  assert.deepEqual([inside.strikes, inside.until.toISOString(), inside.keep], [1, a.until.toISOString(), true]);
  const t1 = plus(T0, 25);
  const b = nextBlock({ reason: 'refused', blockedUntil: a.until, strikes: 1 }, 'dns', t1);
  assert.deepEqual([b.strikes, b.until.toISOString()], [2, plus(t1, 72).toISOString()]);
  const t2 = plus(t1, 73);
  const c = nextBlock({ reason: 'dns', blockedUntil: b.until, strikes: 2 }, 'tls', t2);
  assert.deepEqual([c.strikes, c.until.toISOString()], [3, plus(t2, 168).toISOString()]);
  const t3 = plus(t2, 169);
  const d = nextBlock({ reason: 'tls', blockedUntil: c.until, strikes: 3 }, 'refused', t3);
  assert.deepEqual([d.strikes, d.until.toISOString()], [4, plus(t3, 168).toISOString()], 'the block stays 7 d');
});

test('nextBlock: a timeout blocks for an hour, adds no strike and never shortens a longer block', () => {
  const t = nextBlock(null, 'timeout', T0);
  assert.deepEqual([t.strikes, t.until.toISOString(), t.keep], [0, plus(T0, 1).toISOString(), false]);
  const long: PrevBlock = { reason: 'refused', blockedUntil: plus(T0, 70), strikes: 2 };
  const kept = nextBlock(long, 'timeout', plus(T0, 5));
  assert.deepEqual([kept.strikes, kept.until.toISOString(), kept.keep], [2, long.blockedUntil.toISOString(), true]);
  const again = nextBlock({ reason: 'timeout', blockedUntil: plus(T0, 0.5), strikes: 0 }, 'timeout', plus(T0, 0.25));
  assert.equal(again.until.toISOString(), plus(T0, 1.25).toISOString());
  // A refusal on top of an hour-long timeout block is a real strike, not "the same block".
  const refusal = nextBlock({ reason: 'timeout', blockedUntil: plus(T0, 0.5), strikes: 0 }, 'refused', plus(T0, 0.25));
  assert.deepEqual([refusal.strikes, refusal.keep], [1, false]);
  // After the timeout block, earlier strikes are still counted.
  const after = nextBlock({ reason: 'timeout', blockedUntil: plus(T0, 1), strikes: 2 }, 'refused', plus(T0, 2));
  assert.equal(after.strikes, 3);
});

test('nextBlock: a feed failure is a flat day on its own address and leaves the strikes alone', () => {
  const f = nextBlock({ reason: 'feed_unparseable', blockedUntil: plus(T0, -1), strikes: 0 }, 'feed_too_large', T0);
  assert.deepEqual([f.strikes, f.until.toISOString(), f.keep], [0, plus(T0, 24).toISOString(), false]);
  // Spec 070: refused and missing feeds are flat days too, however often they fail: no strike, no 3 d / 7 d.
  for (const reason of ['feed_refused', 'feed_missing'] as const) {
    const first = nextBlock(null, reason, T0);
    assert.deepEqual([first.strikes, first.until.toISOString(), first.keep], [0, plus(T0, 24).toISOString(), false], reason);
    const again = nextBlock({ reason, blockedUntil: plus(T0, 24), strikes: 0 }, reason, plus(T0, 25));
    assert.deepEqual([again.strikes, again.until.toISOString(), again.keep], [0, plus(T0, 49).toISOString(), false], `${reason}: a day again`);
    const inside = nextBlock({ reason, blockedUntil: plus(T0, 24), strikes: 0 }, reason, plus(T0, 3));
    assert.equal(inside.until.toISOString(), plus(T0, 27).toISOString());
  }
});

test('classifyTimeout: node, axios and abort-signal timeouts; a reset or DNS failure is not one', () => {
  for (const e of [{ code: 'ECONNABORTED' }, { code: 'ETIMEDOUT' }, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, { name: 'TimeoutError' }, new Error('timeout of 10000ms exceeded'), new Error('The operation timed out')]) {
    assert.equal(classifyTimeout(e), true, JSON.stringify(e));
  }
  for (const e of [new Error('socket hang up'), { code: 'ENOTFOUND' }, null, undefined]) assert.equal(classifyTimeout(e), false);
});

test('spec 070 classifyTransient: resets, refused and unreachable connections, closed sockets; not timeouts, DNS or certificates', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']) {
    assert.equal(classifyTransient({ code }), true, code);
    assert.equal(classifyTransient({ cause: { code } }), true, `cause ${code}`);
  }
  for (const message of ['socket hang up', 'Client network socket disconnected before secure TLS connection was established', 'SocketError: other side closed']) {
    assert.equal(classifyTransient(new Error(message)), true, message);
  }
  for (const e of [{ code: 'ETIMEDOUT' }, { code: 'ENOTFOUND' }, { code: 'CERT_HAS_EXPIRED' }, new Error('timeout of 10000ms exceeded'), new Error('status 500'), null, undefined]) {
    assert.equal(classifyTransient(e), false, JSON.stringify(e));
  }
});

test('spec 070 retryReset: one more try for a reset only; the second error, and any other error, are thrown at once', async () => {
  let calls = 0;
  assert.equal(await retryReset(async () => { if (++calls === 1) throw new Error('socket hang up'); return 'ok'; }, 0), 'ok');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(retryReset(async () => { calls++; throw new Error('socket hang up'); }, 0), /socket hang up/);
  assert.equal(calls, 2);
  for (const err of [new Error('boom'), Object.assign(new Error('x'), { code: 'ENOTFOUND' }), Object.assign(new Error('timeout of 1ms exceeded'), { code: 'ECONNABORTED' })]) {
    calls = 0;
    await assert.rejects(retryReset(async () => { calls++; throw err; }, 0));
    assert.equal(calls, 1, `${err.message} is not retried`);
  }
  assert.match(resetFailure('a.example').details, /^a\.example: сайт обірвав з'єднання; година паузи/);
});

class Memory implements HostFailures {
  records: Array<[string, HostFailureReason]> = [];
  ok: string[] = [];
  async blocked(): Promise<HostBlock | null> { return null; }
  async record(h: string, r: HostFailureReason) { this.records.push([h, r]); }
  async succeeded(h: string) { this.ok.push(h); }
}

test('fetchPageGuarded: a timeout records a one-hour failure and answers instead of throwing; success resets the strikes; other errors still throw', async () => {
  const m = new Memory();
  const slow = await fetchPageGuarded('https://slow.example/a', m, undefined, async () => { throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }); });
  assert.deepEqual(slow, { error: 'host_unreachable', details: slow && 'details' in slow ? slow.details : '' });
  assert.match((slow as { details: string }).details, /^slow\.example: сайт не відповів вчасно\. Година паузи/);
  assert.deepEqual(m.records, [['slow.example', 'timeout']]);
  // Spec 070: a reset is tried twice, then recorded as a timeout with its own words; any other error still throws.
  let tries = 0;
  const cut = await fetchPageGuarded('https://flaky.example/a', m, undefined, async () => { tries++; throw new Error('socket hang up'); }, 0);
  assert.deepEqual(cut, resetFailure('flaky.example'));
  assert.equal(tries, 2);
  assert.deepEqual(m.records, [['slow.example', 'timeout'], ['flaky.example', 'timeout']]);
  await assert.rejects(fetchPageGuarded('https://odd.example/a', m, undefined, async () => { throw new Error('something else'); }, 0), /something else/);
  assert.equal(m.records.length, 2);
  const good = await fetchPageGuarded('https://fine.example/a', m, undefined, async () => ({ status: 200 }));
  assert.deepEqual(good, { status: 200 });
  assert.deepEqual(m.ok, ['fine.example']);
  await fetchPageGuarded('https://gone.example/a', m, undefined, async () => ({ status: 404 }));
  assert.deepEqual(m.ok, ['fine.example'], 'a 404 is not a success');
});

test('playbookSources: series feed addresses and rule links the card does not read; an id of a card source is not a new one', () => {
  const card: CardSource[] = [{ id: 'verge', kind: 'rss', ref: 'https://www.theverge.com/rss/index.xml' }];
  const body = {
    series: [
      { name: 'a', active: true, source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' } },
      { name: 'b', source: { kind: 'feed', ref: 'verge' } },
      { name: 'c', source: { kind: 'feed', ref: 'https://www.theverge.com/ai-artificial-intelligence' } },
      { name: 'd', active: false, source: { kind: 'feed', ref: 'https://off.example/rss' } },
      { name: 'e', source: { kind: 'api', source: 'nasa_apod' } },
    ],
    rules: ['Бери новини з https://techcrunch.com/category/artificial-intelligence/, не вигадуй.', 'Без посилань', 'Ще раз https://www.marktechpost.com/feed/.'],
  };
  const r = playbookSources(body, card);
  assert.deepEqual(r.map((s) => [s.id, s.kind, s.ref]), [
    ['playbook:marktechpost.com', 'rss', 'https://www.marktechpost.com/feed/'],
    ['playbook:techcrunch.com', 'url', 'https://techcrunch.com/category/artificial-intelligence/'],
  ]);
  assert.deepEqual(playbookSources(null, card), []);
  assert.deepEqual(playbookSources({ series: 'x', rules: 5 }, card), []);
});

const FEED: CardSource = { id: 'verge', kind: 'rss', ref: 'https://www.theverge.com/rss/index.xml' };
const block = (host: string, o: Partial<HostBlockRow> = {}): HostBlockRow => ({ host, reason: 'refused', statusCode: 403, until: plus(T0, 100), failures: 1, strikes: 1, ...o });

const PAGE: CardSource = { id: 'verge-pages', kind: 'url', ref: 'https://www.theverge.com/ai-artificial-intelligence' };

test('source health: a second strike is worth a replacement; a one-hour timeout block is not (a url source, or a feed behind a DNS block)', () => {
  const now = T0;
  const one = sourceHealthOf(PAGE, [], [block('theverge.com', { strikes: 1 })], now);
  assert.equal(needsReplacement(one), false, 'one 24 h block is a blip');
  const two = sourceHealthOf(PAGE, [], [block('theverge.com', { strikes: 2 })], now);
  assert.equal(needsReplacement(two), true);
  assert.match(two.detail, /2 blocks in a row/);
  assert.equal(two.blocked?.strikes, 2);
  const slow = sourceHealthOf(PAGE, [], [block('theverge.com', { reason: 'timeout', statusCode: null, strikes: 0, failures: 3, until: plus(T0, 1) })], now);
  assert.equal(needsReplacement(slow), false);
  // A feed is stopped by the host's DNS / TLS / timeout rows, so its strikes still count there.
  const dns = sourceHealthOf(FEED, [], [block('theverge.com', { reason: 'dns', statusCode: null, strikes: 2 })], now);
  assert.equal(dns.state, 'blocked');
  assert.equal(needsReplacement(dns), true);
});

test('spec 070 source health: a host `refused` row does not block an RSS source; its own feed_refused / feed_missing row does', () => {
  const now = T0;
  const refused = sourceHealthOf(FEED, [], [block('theverge.com', { strikes: 2 })], now);
  assert.equal(refused.blocked, null, 'a page 403 says nothing about the feed');
  assert.notEqual(refused.state, 'blocked');
  assert.equal(needsReplacement(refused), false);
  const own = sourceHealthOf(FEED, [], [block('theverge.com/rss/index.xml', { reason: 'feed_refused', statusCode: 403, strikes: 0 })], now);
  assert.equal(own.state, 'blocked');
  assert.match(own.detail, /feed_refused 403/);
  const gone = sourceHealthOf(FEED, [], [block('theverge.com/rss/index.xml', { reason: 'feed_missing', statusCode: 404, strikes: 0 })], now);
  assert.equal(gone.state, 'blocked');
  // The page source keeps the old rule: refused blocks it, a feed row does not.
  assert.equal(sourceHealthOf(PAGE, [], [block('theverge.com')], now).state, 'blocked');
  assert.notEqual(sourceHealthOf(PAGE, [], [block('theverge.com/rss/index.xml', { reason: 'feed_refused' })], now).state, 'blocked');
  // A feed at the root of a site: its row is host/, the host's own row is another key.
  const root: CardSource = { id: 'root', kind: 'rss', ref: 'https://example.com/' };
  assert.equal(sourceHealthOf(root, [], [block('example.com')], now).blocked, null);
  assert.equal(sourceHealthOf(root, [], [block('example.com/', { reason: 'feed_refused' })], now).state, 'blocked');
});

test('spec 070 source health: a dead feed reaches the owner as failing (3 failed reads), not through strikes', () => {
  const now = T0;
  const fail = (h: number) => ({ at: plus(T0, -h), tool: 'fetch_feed', input: { url: FEED.ref }, isError: true, error: 'http_error', details: 'status 403', items: null, slotId: null, slotStatus: null });
  const h = sourceHealthOf(FEED, [fail(30), fail(20), fail(10)], [block('theverge.com/rss/index.xml', { reason: 'feed_refused', statusCode: 403, strikes: 0 })], now);
  assert.equal(h.state, 'blocked');
  const noBlock = sourceHealthOf(FEED, [fail(30), fail(20), fail(10)], [], now);
  assert.equal(noBlock.state, 'failing');
  assert.equal(needsReplacement(noBlock), true);
});

function service(o: { card: ReturnType<typeof makeCard>; playbook?: unknown; struck?: Array<HostBlockRow & { notedAt: Date | null }>; noted?: Set<string>; posts?: any[] }) {
  const posts = o.posts ?? [];
  const noted = o.noted ?? new Set<string>();
  const svc = new SourceHealthService({
    repo: {
      steps: async () => [], blocks: async () => [],
      playbookOf: async () => o.playbook ?? null,
      struck: async (keys: string[]) => (o.struck ?? []).filter((b) => keys.includes(b.host)),
      claimNote: async (host: string) => { if (noted.has(host)) return false; noted.add(host); return true; },
    },
    channels: { get: async () => o.card }, now: () => T0,
    inbox: { post: async (i: any) => { posts.push(i); return 1; } },
  });
  return { svc, posts };
}

test('source health lists the playbook feeds of the orchestrator, tagged; they are not offered for a card replacement', async () => {
  const card = makeCard({ channelKey: '@ai0_global', sources: [] });
  const playbook = { series: [{ name: 'AI news', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' } }], rules: [] };
  const { svc } = service({ card, playbook });
  const r = await svc.forCard(card);
  assert.deepEqual(r.sources.map((s) => [s.id, s.origin, s.state]), [['playbook:marktechpost.com', 'playbook', 'unused']]);
  assert.deepEqual(await svc.needingReplacement(card), []);
});

test('the third strike on a playbook feed is one owner note in Ukrainian (once per streak); a card source says the agent looks for a replacement', async () => {
  const card = makeCard({ channelKey: '@ai0_global', sources: [FEED] });
  const playbook = { series: [{ name: 'AI news', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' } }], rules: [] };
  const struck = [
    { ...block('marktechpost.com', { strikes: 3, until: plus(T0, 160) }), notedAt: null },
    { ...block('theverge.com', { strikes: 4, until: plus(T0, 160) }), notedAt: null },
    { ...block('elsewhere.example', { strikes: 3 }), notedAt: null },
  ];
  const noted = new Set<string>();
  const { svc, posts } = service({ card, playbook, struck, noted });
  assert.deepEqual(await svc.noteStruckHosts(card, 'orch'), ['marktechpost.com', 'theverge.com']);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, 'marktechpost.com відмовляє нам 3 рази поспіль — прибрати з плейбука @ai0_global?');
  assert.equal(posts[0].severity, 'action');
  assert.equal(posts[0].refId, '@ai0_global/marktechpost.com');
  assert.match(posts[0].body, /заблоковано до 2026-10-27/);
  assert.match(posts[0].body, /прибери її з плейбука/);
  assert.match(posts[1].title, /^theverge\.com відмовляє нам 4 рази поспіль — прибрати з джерел @ai0_global \(картка каналу\)\?$/);
  assert.match(posts[1].body, /агент шукає заміну/);
  assert.deepEqual(await svc.noteStruckHosts(card, 'orch'), [], 'claimed once — no second note');
  assert.equal(posts.length, 2);
});

test('without the repository hooks or the inbox the note step does nothing', async () => {
  const card = makeCard({ channelKey: '@c', sources: [FEED] });
  const bare = new SourceHealthService({ repo: { steps: async () => [], blocks: async () => [] }, channels: { get: async () => card } });
  assert.deepEqual(await bare.noteStruckHosts(card, null), []);
});
