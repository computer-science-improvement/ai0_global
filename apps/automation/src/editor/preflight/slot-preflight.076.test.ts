/**
 * Spec 076 A21: a `feed:<id>` / `rss:<id>` hint that resolves to an http card source is judged by its host blocks. Fakes only.
 * (slot-preflight.068.test.ts keeps "a feed hint counts as usable" green.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlotPreflight, type PreflightDeps } from './slot-preflight';
import { makeCard } from '../post/testing/fixtures';
import type { HostBlock, HostFailureReason } from '../net/host-failures';

const NOW = new Date('2030-05-06T12:00:00Z');
const FEED = 'https://feeds.example/news/rss';
const PAGE = 'https://pages.example/list';
const card = makeCard({ sources: [
  { id: 'rss1', kind: 'rss', ref: FEED },
  { id: 'list1', kind: 'url', ref: PAGE },
  { id: 'lib', kind: 'library', ref: 'recipes' },
] });

/** `blocked`: key → reason. The fake answers a key whatever the `use` is, and records the questions. */
function build(blocked: Record<string, HostFailureReason> = {}, opts: { used?: Set<string> } = {}) {
  const asked: string[] = [];
  const d: PreflightDeps = {
    ledger: { check: async (_r: string, ref: string) => (opts.used?.has(ref) ? { used: true, status: 'published', resourceRef: 'telegram:@chan', ref, at: NOW, slotId: 'old' } : { used: false }) } as any,
    hosts: {
      blocked: async (key: string, use: 'page' | 'feed'): Promise<HostBlock | null> => {
        asked.push(`${key}|${use}`);
        const reason = blocked[key];
        return reason ? { host: key, reason, statusCode: null, until: new Date(NOW.getTime() + 86_400_000) } : null;
      },
    },
    ideas: { idea: async () => null, accepted: async () => [], claim: async () => true, release: async () => {} },
    retopic: async () => {},
    env: () => undefined,
    freshnessHours: async () => 36,
    now: () => NOW,
  };
  return { pf: new SlotPreflight(d), asked };
}
const slot = (hints: string[], over: any = {}): any => ({
  id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'text', topic: 'Тема', angle: null, sourceHints: hints,
  ideaId: null, seriesName: null, isExperiment: false, status: 'running', attempts: 0, ...over,
});

test('a blocked feed hint is preflight_host_blocked, with the feed id, the time and the reason', async () => {
  const b = build({ 'feeds.example': 'unreachable' });
  const r = await b.pf.run(slot(['feed:rss1']), card);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'preflight_host_blocked');
  assert.equal(!r.ok && r.reason, 'стрічка rss1 недоступна з сервера до 2030-05-07T12:00Z (unreachable)');
  assert.deepEqual(b.asked, ['feeds.example|feed'], 'an rss source is asked with use feed');
  const byKey = await build({ 'feeds.example/news/rss': 'feed_unparseable' }).pf.run(slot(['rss:rss1']), card);
  assert.equal(!byKey.ok && byKey.code, 'preflight_host_blocked', 'the feed address counts as well as the host');
  const page = build({ 'pages.example': 'unreachable' });
  const p = await page.pf.run(slot(['feed:list1']), card);
  assert.equal(!p.ok && p.code, 'preflight_host_blocked');
  assert.deepEqual(page.asked, ['pages.example|page'], 'a url source is asked with use page, and has no address key');
});

test('an unblocked feed hint is usable, and so is one usable source beside a blocked URL', async () => {
  assert.equal((await build({}).pf.run(slot(['feed:rss1']), card)).ok, true);
  const mixed = build({ 'bad.example': 'refused' });
  assert.equal((await mixed.pf.run(slot(['feed:rss1', 'https://bad.example/x']), card)).ok, true, 'the feed is usable');
  const other = await build({ 'feeds.example': 'unreachable' }).pf.run(slot(['feed:rss1', 'https://good.example/x']), card);
  assert.equal(other.ok, true, 'the URL is usable beside the blocked feed');
  const both = await build({ 'feeds.example': 'unreachable', 'bad.example': 'refused' }).pf.run(slot(['feed:rss1', 'https://bad.example/x']), card);
  assert.equal(!both.ok && both.code, 'preflight_host_blocked', 'every source is out');
});

test('a one-hour timeout block is a slow site, not a dead one: the feed hint passes', async () => {
  assert.equal((await build({ 'feeds.example': 'timeout' }).pf.run(slot(['feed:rss1']), card)).ok, true);
  assert.equal((await build({ 'feeds.example/news/rss': 'timeout' }).pf.run(slot(['feed:rss1']), card)).ok, true);
});

test('an unresolved id, a library id and the other kinds stay unjudgeable', async () => {
  const b = build({ 'feeds.example': 'unreachable' });
  assert.equal((await b.pf.run(slot(['feed:nope']), card)).ok, true, 'an id the card does not have');
  assert.equal((await b.pf.run(slot(['feed:lib']), card)).ok, true, 'a library source is not a feed');
  assert.equal((await b.pf.run(slot(['api:nasa_apod']), card)).ok, true);
  assert.equal((await b.pf.run(slot(['feed:rss1', 'api:nasa_apod']), card)).ok, true, 'an unjudgeable hint beside a blocked feed lets the slot go on');
  assert.deepEqual(b.asked, [], 'nothing was asked');
});

test('a feed hint is not run through the ledger or the staleness check', async () => {
  const used = new Set([FEED, 'rss1', 'feed:rss1']);
  assert.equal((await build({}, { used }).pf.run(slot(['feed:rss1']), card)).ok, true);
});

test('assessPlanned inherits the rule: the planner is told to change the source', async () => {
  const b = build({ 'feeds.example': 'unreachable' });
  const p = await b.pf.assessPlanned(slot(['feed:rss1']), card);
  assert.equal(p?.code, 'preflight_host_blocked');
  assert.match(p?.reason ?? '', /^стрічка rss1 недоступна з сервера до /);
  assert.equal(await build({}).pf.assessPlanned(slot(['feed:rss1']), card), null);
});

test('a live slot is still not judged here (its feeds are read by the scan)', async () => {
  const live = slot(['feed:rss1'], { topicMode: 'live' });
  assert.equal((await build({ 'feeds.example': 'unreachable' }).pf.run(live, card)).ok, true);
});
