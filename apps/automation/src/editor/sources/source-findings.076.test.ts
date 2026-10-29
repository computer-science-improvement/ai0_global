import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingKey } from '../sysadmin/audit-text';
import {
  FEED_STALE_DAYS, PROBE_FRESH_DAYS, SOURCE_FINDING_CODES, sourceFindings, UNTESTED_CHANNEL_DAYS,
  type SourceFact, type SourceFindingsInput, type SourceProbeFact,
} from './source-findings';
import { SOURCE_REASONS } from './codes';

/** Spec 076 FR-008 / L6 / A4: every code, its key, subject, title, link and fix, and the 7-day and 14-day rules. Pure, no I/O. */

const DAY = 86_400_000;
const NOW = new Date('2026-10-29T12:00:00Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const iso = (days: number): string => ago(days).toISOString();

const FEED = 'https://example.com/feed.xml';
const PAGE = 'https://blog.example.org/posts';

const probe = (o: Partial<SourceProbeFact> = {}): SourceProbeFact => ({
  ok: true, failure_class: null, items: 12, newest_at: iso(0.1), checked_at: iso(0.2), detail: '12 items, newest 2 h ago', ...o,
});
const failed = (cls: string, o: Partial<SourceProbeFact> = {}): SourceProbeFact => probe({ ok: false, failure_class: cls, items: null, newest_at: null, detail: `failed: ${cls}`, ...o });

const fact = (o: Partial<SourceFact> = {}): SourceFact => ({
  url: FEED, kind: 'rss', origin: 'card', host: 'example.com', hostBlock: null, id: 'news', ...o,
});
const input = (sources: SourceFact[], o: Partial<SourceFindingsInput> = {}): SourceFindingsInput => ({
  channelKey: '@chan', agent: 'chan_agent', now: NOW, createdAt: ago(60), sources, proxyConfigured: false, uploadedImports: [], ...o,
});
const only = (i: SourceFindingsInput) => {
  const out = sourceFindings(i);
  assert.equal(out.length, 1, JSON.stringify(out.map((f) => f.check)));
  return out[0];
};
const block = (reason: string, strikes = 1) => ({ reason, until: new Date(NOW.getTime() + 20 * 3_600_000).toISOString(), strikes });

test('source_probe_failed: the key, subject, title, detail, evidence and link', () => {
  const f = only(input([fact({ probe: failed('timeout', { checked_at: iso(1) }) })]));
  const subject = { type: 'channel', id: `@chan|${FEED}`, label: 'example.com', agent: 'chan_agent', channel: '@chan' };
  assert.equal(f.area, 'channel');
  assert.equal(f.check, 'source_probe_failed');
  assert.equal(f.severity, 'warn');
  assert.deepEqual(f.subject, subject);
  assert.equal(f.key, findingKey('channel', 'source_probe_failed', { type: 'channel', id: subject.id, agent: 'chan_agent', channel: '@chan' }));
  assert.equal(f.title, 'example.com: the server cannot read this source');
  assert.equal(f.detail, 'failed: timeout', 'the probe\'s own line');
  assert.deepEqual(f.evidence, { url: FEED, kind: 'rss', origin: 'card', failure_class: 'timeout', items: null, newest_at: null, checked_at: iso(1), block: null });
  assert.equal(f.link, '/app/agents/chan_agent?tab=settings');
  assert.deepEqual(f.fix, { kind: 'source_drop', channel: '@chan', sourceId: 'news' });
});

test('source_probe_failed: any class but empty, and an unreachable block even when no probe says so', () => {
  for (const cls of ['timeout', 'refused', 'tls', 'dns', 'http', 'invalid']) {
    assert.equal(only(input([fact({ probe: failed(cls) })])).check, 'source_probe_failed', cls);
  }
  const blocked = only(input([fact({ hostBlock: block('unreachable') })]));
  assert.equal(blocked.check, 'source_probe_failed');
  assert.equal(blocked.detail, `blocked until 2026-10-30 08:00 UTC (unreachable, 1 in a row)`, 'no probe: the block line');
  assert.deepEqual((blocked.evidence as any).block, block('unreachable'));
  // A block of another reason says nothing here (source health and the host note cover it).
  assert.deepEqual(sourceFindings(input([fact({ hostBlock: block('refused', 3) })], { createdAt: ago(60) })), []);
  // A good probe next to an unreachable block: the block decides, and the detail is not the good probe's line.
  const both = only(input([fact({ probe: probe(), hostBlock: block('unreachable', 2) })]));
  assert.equal(both.check, 'source_probe_failed');
  assert.equal(both.detail, 'blocked until 2026-10-30 08:00 UTC (unreachable, 2 in a row)');
  // One finding for a source even when a failed probe and a block both apply.
  assert.equal(only(input([fact({ probe: failed('timeout'), hostBlock: block('unreachable') })])).detail, 'failed: timeout');
});

test('source_probe_failed: error for a required source, warn otherwise', () => {
  assert.equal(only(input([fact({ probe: failed('timeout'), required: true })])).severity, 'error');
  assert.equal(only(input([fact({ probe: failed('timeout'), required: false })])).severity, 'warn');
  assert.equal(only(input([fact({ probe: failed('timeout') })])).severity, 'warn');
  assert.equal(only(input([fact({ hostBlock: block('unreachable'), required: true })])).severity, 'error');
});

test('the fix of source_probe_failed: the proxy for timeout and refused when one is configured, else a card source is removed', () => {
  const withProxy = (f: SourceFact) => only(input([f], { proxyConfigured: true })).fix;
  assert.deepEqual(withProxy(fact({ probe: failed('timeout') })), { kind: 'host_proxy_add', host: 'example.com' });
  assert.deepEqual(withProxy(fact({ probe: failed('refused') })), { kind: 'host_proxy_add', host: 'example.com' });
  assert.deepEqual(withProxy(fact({ hostBlock: block('unreachable') })), { kind: 'host_proxy_add', host: 'example.com' }, 'an unreachable block is repeated timeouts');
  for (const cls of ['dns', 'tls', 'http', 'invalid']) {
    assert.deepEqual(withProxy(fact({ probe: failed(cls) })), { kind: 'source_drop', channel: '@chan', sourceId: 'news' }, `${cls}: a proxy does not help`);
  }
  assert.deepEqual(withProxy(fact({ probe: failed('http'), hostBlock: block('unreachable') })), { kind: 'source_drop', channel: '@chan', sourceId: 'news' }, 'the probe\'s own class decides when it failed');
  assert.deepEqual(only(input([fact({ probe: failed('timeout') })])).fix, { kind: 'source_drop', channel: '@chan', sourceId: 'news' }, 'no proxy configured');
  assert.deepEqual(withProxy(fact({ probe: failed('timeout'), host: null })), { kind: 'source_drop', channel: '@chan', sourceId: 'news' }, 'no host to add');
  assert.equal(withProxy(fact({ probe: failed('timeout'), origin: 'series:Morning news', host: null })), undefined, 'a series source cannot be removed from the card');
  assert.deepEqual(withProxy(fact({ probe: failed('timeout'), origin: 'series:Morning news' })), { kind: 'host_proxy_add', host: 'example.com' }, 'but its host can be proxied');
  assert.equal(only(input([fact({ probe: failed('dns'), origin: 'series:Morning news' })])).fix, undefined);
  assert.deepEqual(only(input([fact({ probe: failed('dns'), id: undefined })])).fix, { kind: 'source_drop', channel: '@chan', sourceId: FEED }, 'a fact with no id names the source by its address');
});

test('source_empty: a probe that failed as empty, or an rss source whose newest item is over 7 days old; warn; a card source can be removed', () => {
  const empty = only(input([fact({ probe: failed('empty') })]));
  assert.equal(empty.check, 'source_empty');
  assert.equal(empty.severity, 'warn');
  assert.equal(empty.title, 'example.com: empty or not a feed');
  assert.equal(empty.detail, 'failed: empty');
  assert.deepEqual(empty.fix, { kind: 'source_drop', channel: '@chan', sourceId: 'news' });
  assert.equal(empty.link, '/app/agents/chan_agent?tab=settings');

  const stale = only(input([fact({ probe: probe({ newest_at: iso(FEED_STALE_DAYS + 1), detail: '3 items, newest 8 d ago' }) })]));
  assert.equal(stale.check, 'source_empty');
  assert.equal(stale.detail, '3 items, newest 8 d ago');
  assert.equal((stale.evidence as any).newest_at, iso(FEED_STALE_DAYS + 1));

  assert.deepEqual(sourceFindings(input([fact({ probe: probe({ newest_at: iso(FEED_STALE_DAYS - 0.5) }) })])), [], 'a feed that posts every week is fine');
  assert.deepEqual(sourceFindings(input([fact({ probe: probe({ newest_at: null }) })])), [], 'no date, no verdict');
  assert.deepEqual(sourceFindings(input([fact({ probe: probe({ newest_at: 'not a date' }) })])), []);
  assert.deepEqual(sourceFindings(input([fact({ kind: 'url', url: PAGE, probe: probe({ newest_at: iso(30) }) })])), [], 'only an rss source has a newest item');
  assert.equal(only(input([fact({ kind: 'url', url: PAGE, probe: failed('empty') })])).check, 'source_empty', 'a page can be empty');
  assert.equal(only(input([fact({ probe: failed('empty'), origin: 'series:S' })])).fix, undefined);
});

test('source_untested: an rss or url source with no probe on a channel created in the last 14 days; info; no fix', () => {
  const young = input([fact(), fact({ kind: 'url', url: PAGE, host: 'blog.example.org', id: 'blog' })], { createdAt: ago(3) });
  const out = sourceFindings(young);
  assert.deepEqual(out.map((f) => [f.check, f.severity, f.fix]), [['source_untested', 'info', undefined], ['source_untested', 'info', undefined]]);
  assert.equal(out[0].title, 'example.com: not read from the server yet');
  assert.equal(out[0].detail, 'The server has not read this source yet');
  assert.equal(out[0].link, '/app/agents/chan_agent?tab=settings');
  assert.notEqual(out[0].key, out[1].key);

  assert.deepEqual(sourceFindings(input([fact()], { createdAt: ago(UNTESTED_CHANNEL_DAYS + 1) })), [], 'an older channel is not nagged');
  assert.equal(sourceFindings(input([fact()], { createdAt: ago(UNTESTED_CHANNEL_DAYS - 0.1) })).length, 1);
  assert.deepEqual(sourceFindings(input([fact({ probe: probe() })], { createdAt: ago(3) })), [], 'a probed source is tested');
});

test('a probe older than 7 days counts as none, for every decision', () => {
  const old = (p: SourceProbeFact): SourceProbeFact => ({ ...p, checked_at: iso(PROBE_FRESH_DAYS + 0.1) });
  assert.deepEqual(sourceFindings(input([fact({ probe: old(failed('timeout')) })])), [], 'an old failure is not held against an old channel');
  assert.deepEqual(sourceFindings(input([fact({ probe: old(failed('empty')) })])), []);
  assert.deepEqual(sourceFindings(input([fact({ probe: old(probe({ newest_at: iso(30) })) })])), []);
  const young = only(input([fact({ probe: old(failed('timeout')) })], { createdAt: ago(2) }));
  assert.equal(young.check, 'source_untested', 'on a young channel it is as good as never tested');
  assert.equal((young.evidence as any).checked_at, null, 'and the old probe is not in the evidence');
  assert.equal(only(input([fact({ probe: { ...failed('timeout'), checked_at: iso(PROBE_FRESH_DAYS - 0.1) } })])).check, 'source_probe_failed', 'one under 7 days still counts');
  assert.equal(only(input([fact({ probe: failed('timeout', { checked_at: 'garbage' }) })], { createdAt: ago(2) })).check, 'source_untested', 'an unreadable time is no probe');
});

test('library and api sources are never read from the server: no probe finding, whatever their host says', () => {
  const lib = fact({ kind: 'library', url: 'library:prompts', host: null, id: 'lib' });
  const api = fact({ kind: 'api', url: 'api:nasa_apod', host: null, origin: 'series:Space photo', hostBlock: block('unreachable') });
  assert.deepEqual(sourceFindings(input([lib, api], { createdAt: ago(2) })), []);
});

test('card_without_sources: no card source and no series source, one info with the channel as its subject', () => {
  const f = only(input([], { createdAt: ago(1) }));
  assert.equal(f.check, 'card_without_sources');
  assert.equal(f.severity, 'info');
  assert.deepEqual(f.subject, { type: 'channel', id: '@chan', label: '@chan', agent: 'chan_agent', channel: '@chan' });
  assert.equal(f.key, findingKey('channel', 'card_without_sources', { type: 'channel', id: '@chan', agent: 'chan_agent', channel: '@chan' }));
  assert.equal(f.title, 'No sources: @chan writes from its brief only');
  assert.equal(f.detail, 'No sources: the channel writes from its brief only');
  assert.equal(f.link, '/app/agents/chan_agent?tab=settings');
  assert.equal(f.fix, undefined);
  // A library series is a source: the channel does not write from its brief alone.
  assert.deepEqual(sourceFindings(input([fact({ kind: 'library', url: 'library:prompts', host: null, origin: 'series:Prompt of the day', id: undefined })])), []);
});

test('dataset_resync_manual: one info per uploaded dataset, linked to the dataset', () => {
  const out = sourceFindings(input([fact({ probe: probe() })], { uploadedImports: ['pdr_rules', 'other_set', 'pdr_rules', ''] }));
  assert.deepEqual(out.map((f) => f.check), ['dataset_resync_manual', 'dataset_resync_manual']);
  const f = out[0];
  assert.equal(f.severity, 'info');
  assert.deepEqual(f.subject, { type: 'channel', id: '@chan|pdr_rules', label: 'pdr_rules', agent: 'chan_agent', channel: '@chan' });
  assert.equal(f.title, 'pdr_rules: re-sync is manual (uploaded page)');
  assert.equal(f.detail, 'Imported from an uploaded page: re-sync is manual');
  assert.deepEqual(f.evidence, { dataset: 'pdr_rules' });
  assert.equal(f.link, '/app/data/pdr_rules');
  assert.equal(f.fix, undefined);
  assert.notEqual(out[0].key, out[1].key);
});

test('with no agent the link goes to the channel page', () => {
  const out = sourceFindings(input([], { agent: null, uploadedImports: ['ds'] }));
  assert.deepEqual(out.map((f) => [f.check, f.link]), [['card_without_sources', '/app/editor/@chan'], ['dataset_resync_manual', '/app/data/ds']]);
  assert.equal(out[0].subject.agent, undefined);
  const withFact = only(input([fact({ probe: failed('timeout') })], { agent: null }));
  assert.equal(withFact.link, '/app/editor/@chan');
  assert.equal(withFact.key, findingKey('channel', 'source_probe_failed', { type: 'channel', id: `@chan|${FEED}`, agent: undefined, channel: '@chan' }));
});

test('the same address listed by the card and by a series is one finding, with the higher severity and a fix from either', () => {
  const series = fact({ origin: 'series:Morning news', id: undefined, probe: failed('dns'), required: true });
  const card = fact({ probe: failed('dns'), required: false });
  for (const order of [[card, series], [series, card]]) {
    const f = only(input(order));
    assert.equal(f.severity, 'error');
    assert.deepEqual(f.fix, { kind: 'source_drop', channel: '@chan', sourceId: 'news' }, 'the card\'s fix is kept');
  }
  assert.equal(sourceFindings(input([card, { ...card, url: PAGE, kind: 'url', id: 'blog' }])).length, 2, 'two addresses are two findings');
});

test('the order: sources as given, then the channel finding, then the datasets; every key is unique', () => {
  const out = sourceFindings(input([
    fact({ url: 'https://a.example/feed', host: 'a.example', id: 'a', probe: failed('dns') }),
    fact({ url: 'https://b.example/feed', host: 'b.example', id: 'b', probe: failed('empty') }),
  ], { uploadedImports: ['ds1'] }));
  assert.deepEqual(out.map((f) => f.check), ['source_probe_failed', 'source_empty', 'dataset_resync_manual']);
  assert.equal(new Set(out.map((f) => f.key)).size, out.length);
  const other = sourceFindings(input([fact({ probe: failed('dns') })], { channelKey: '@other' }));
  assert.notEqual(other[0].key, sourceFindings(input([fact({ probe: failed('dns') })]))[0].key, 'the key is per channel');
});

test('it is pure: a deep-frozen input is not touched, and the same input gives the same output', () => {
  const deep = <T>(o: T): T => { if (o && typeof o === 'object') { Object.values(o).forEach(deep); Object.freeze(o); } return o; };
  const i = deep(input([fact({ probe: failed('timeout'), hostBlock: block('unreachable') }), fact({ url: PAGE, kind: 'url', id: 'p' })], { proxyConfigured: true, uploadedImports: ['d'], createdAt: ago(2) }));
  const a = sourceFindings(i);
  assert.deepEqual(sourceFindings(i), a);
  assert.ok(a.length >= 3);
  assert.equal(i.sources.length, 2);
});

test('every check code has a catalogue entry, and the finding\'s detail falls back to its text', () => {
  const codes = new Set(SOURCE_REASONS.map((r) => r.code));
  for (const c of SOURCE_FINDING_CODES) assert.ok(codes.has(c), c);
  assert.deepEqual([...SOURCE_FINDING_CODES], ['source_probe_failed', 'source_empty', 'source_untested', 'card_without_sources', 'dataset_resync_manual']);
  const seen = new Set<string>();
  for (const f of sourceFindings(input([
    fact({ probe: failed('timeout') }), fact({ url: PAGE, kind: 'url', probe: failed('empty') }), fact({ url: 'https://c.example/f', probe: probe() }),
  ], { uploadedImports: ['d'] }))) seen.add(f.check);
  assert.deepEqual([...seen].sort(), ['dataset_resync_manual', 'source_empty', 'source_probe_failed']);
});

test('a 072 SourceFact is accepted as it is (its probe has no detail, it may carry lastSuccessAt)', () => {
  const from072: {
    url: string; kind: 'rss' | 'url' | 'library' | 'api'; origin: 'card' | `series:${string}`; host: string | null;
    hostBlock: { reason: string; until: string; strikes: number } | null; lastSuccessAt?: string | null; required?: boolean;
    probe?: { ok: boolean; failure_class: string | null; items: number | null; newest_at: string | null; checked_at: string } | null;
  } = { url: FEED, kind: 'rss', origin: 'card', host: 'example.com', hostBlock: null, lastSuccessAt: null, required: true, probe: { ok: false, failure_class: 'timeout', items: null, newest_at: null, checked_at: iso(1) } };
  const f = only(input([from072]));
  assert.equal(f.severity, 'error');
  assert.equal(f.detail, 'The server cannot read this source', 'no probe line, no block: the catalogue text');
  assert.deepEqual(f.fix, { kind: 'source_drop', channel: '@chan', sourceId: FEED }, 'no id: the address names the source');
});
