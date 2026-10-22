/**
 * Spec 061 FR-004: host blocks escalate 1 d -> 3 d -> 7 d, a timeout is a one-hour block that is not a strike, the
 * strikes start over after a successful fetch, source health sees the playbook's feeds, and the third strike is one owner
 * note. Pure and fake-pool tests; the real tables are covered by host-strikes.061.pg.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource } from '../card';
import { makeCard } from '../post/testing/fixtures';
import {
  classifyTimeout, fetchPageGuarded, nextBlock, strikeHours, type HostBlock, type HostFailureReason, type HostFailures, type PrevBlock,
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
});

test('classifyTimeout: node, axios and abort-signal timeouts; a reset or DNS failure is not one', () => {
  for (const e of [{ code: 'ECONNABORTED' }, { code: 'ETIMEDOUT' }, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, { name: 'TimeoutError' }, new Error('timeout of 10000ms exceeded'), new Error('The operation timed out')]) {
    assert.equal(classifyTimeout(e), true, JSON.stringify(e));
  }
  for (const e of [new Error('socket hang up'), { code: 'ENOTFOUND' }, null, undefined]) assert.equal(classifyTimeout(e), false);
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
  await assert.rejects(fetchPageGuarded('https://flaky.example/a', m, undefined, async () => { throw new Error('socket hang up'); }), /socket hang up/);
  assert.equal(m.records.length, 1);
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

test('source health: a second strike is worth a replacement; a one-hour timeout block is not', () => {
  const now = T0;
  const one = sourceHealthOf(FEED, [], [block('theverge.com', { strikes: 1 })], now);
  assert.equal(needsReplacement(one), false, 'one 24 h block is a blip');
  const two = sourceHealthOf(FEED, [], [block('theverge.com', { strikes: 2 })], now);
  assert.equal(needsReplacement(two), true);
  assert.match(two.detail, /2 blocks in a row/);
  assert.equal(two.blocked?.strikes, 2);
  const slow = sourceHealthOf(FEED, [], [block('theverge.com', { reason: 'timeout', statusCode: null, strikes: 0, failures: 3, until: plus(T0, 1) })], now);
  assert.equal(needsReplacement(slow), false);
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
