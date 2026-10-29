// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 076 FR-009: the lines, tones, badges and buttons of a source row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageText, hostOfRef, INK_OF_TONE, isReadFromServer, isUnreachable, probeFailed, probeLine, probeTone, rowFixes, runwayLine, sourceBadge, sourceErrorMessage, sourceName,
} from './source-probe';
import type { SourceProbe } from '../api/agents';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const ok = (o: Partial<SourceProbe> = {}): SourceProbe => ({
  ok: true, failure_class: null, status: 200, kind: 'rss', items: 24, newest_at: ago(120), checked_at: ago(180), via_proxy: false, detail: '24 items', ...o,
});
const bad = (cls: SourceProbe['failure_class'], o: Partial<SourceProbe> = {}): SourceProbe => ({
  ok: false, failure_class: cls, status: null, kind: 'rss', items: 0, newest_at: null, checked_at: ago(60), via_proxy: false, detail: 'failed', ...o,
});

test('ageText: just now, minutes, hours, days; an unreadable time says so', () => {
  assert.equal(ageText(ago(0), NOW), 'just now');
  assert.equal(ageText(ago(-5), NOW), 'just now', 'a clock a little ahead is not negative');
  assert.equal(ageText(ago(5), NOW), '5 min ago');
  assert.equal(ageText(ago(59), NOW), '59 min ago');
  assert.equal(ageText(ago(60), NOW), '1 h ago');
  assert.equal(ageText(ago(24 * 60 - 1), NOW), '23 h ago');
  assert.equal(ageText(ago(48 * 60), NOW), '2 d ago');
  assert.equal(ageText(null, NOW), 'unknown time');
  assert.equal(ageText('garbage', NOW), 'unknown time');
});

test('probeLine: a good feed, a good page, and one item', () => {
  assert.equal(probeLine(ok(), NOW), 'Server read: OK · 24 items · newest 2 h ago · checked 3 h ago');
  assert.equal(probeLine(ok({ items: 1 }), NOW), 'Server read: OK · 1 item · newest 2 h ago · checked 3 h ago');
  assert.equal(probeLine(ok({ kind: 'page', items: 0, newest_at: null }), NOW), 'Server read: OK · page · checked 3 h ago');
  assert.equal(probeLine(ok({ kind: 'page', items: 9, newest_at: null }), NOW), 'Server read: OK · 9 items · checked 3 h ago', 'a page that names a feed');
  assert.equal(probeLine(ok({ via_proxy: true }), NOW), 'Server read: OK · 24 items · newest 2 h ago · checked 3 h ago · via proxy');
});

test('probeLine: every failure class', () => {
  const line = (p: SourceProbe) => probeLine(p, NOW);
  assert.equal(line(bad('timeout')), 'Server read: timed out twice · checked 1 h ago');
  assert.equal(line(bad('refused', { status: 403 })), 'Server read: refused (HTTP 403) · checked 1 h ago');
  assert.equal(line(bad('refused')), 'Server read: refused by the site · checked 1 h ago');
  assert.equal(line(bad('tls')), 'Server read: TLS error · checked 1 h ago');
  assert.equal(line(bad('dns')), 'Server read: address not found · checked 1 h ago');
  assert.equal(line(bad('http', { status: 404 })), 'Server read: HTTP 404 · checked 1 h ago');
  assert.equal(line(bad('http')), 'Server read: HTTP error · checked 1 h ago');
  assert.equal(line(bad('empty')), 'Server read: no items in the feed · checked 1 h ago');
  assert.equal(line(bad('empty', { kind: 'page' })), 'Server read: no text on the page · checked 1 h ago');
  assert.equal(line(bad('timeout', { via_proxy: true })), 'Server read: timed out twice · checked 1 h ago · via proxy');
  assert.equal(line(bad(null, { detail: 'something odd' })), 'Server read: something odd · checked 1 h ago', 'a class this build does not know');
});

test('probeLine: an invalid address, and a source never read', () => {
  assert.equal(probeLine(bad('invalid'), NOW), 'Server read: Not a valid public address', 'nothing was read, so there is no time');
  assert.equal(probeLine(null, NOW), 'Server read: not read yet');
  assert.equal(probeLine(undefined, NOW), 'Server read: not read yet');
});

test('probeTone: green answered, amber answered with nothing, red did not answer, grey never read', () => {
  assert.equal(probeTone(ok()), 'success');
  assert.equal(probeTone(bad('empty')), 'warning');
  for (const c of ['timeout', 'refused', 'tls', 'dns', 'http', 'invalid'] as const) assert.equal(probeTone(bad(c)), 'danger', c);
  assert.equal(probeTone(null), 'neutral');
  assert.equal(probeTone(undefined), 'neutral');
  for (const tone of ['success', 'warning', 'danger', 'accent', 'neutral'] as const) assert.ok(INK_OF_TONE[tone], tone);
});

test('sourceBadge: Unreachable beats the state; a failed read on a source that looked fine is "Cannot be read"; otherwise the state stands', () => {
  const unreachable = { reason: 'unreachable', host: 'x.example', statusCode: null, until: ago(-60), failures: 3, strikes: 1 };
  assert.deepEqual(sourceBadge({ state: 'blocked', probe: bad('timeout'), blocked: unreachable }), { label: 'Unreachable', tone: 'danger' });
  assert.deepEqual(sourceBadge({ state: 'ok', probe: undefined, blocked: unreachable }), { label: 'Unreachable', tone: 'danger' });
  assert.deepEqual(sourceBadge({ state: 'ok', probe: bad('dns'), blocked: null }), { label: 'Cannot be read', tone: 'warning' });
  assert.deepEqual(sourceBadge({ state: 'unused', probe: bad('empty'), blocked: null }), { label: 'Cannot be read', tone: 'warning' });
  assert.equal(sourceBadge({ state: 'failing', probe: bad('timeout'), blocked: null }), null, 'the state is already bad');
  assert.equal(sourceBadge({ state: 'blocked', probe: bad('refused'), blocked: { ...unreachable, reason: 'refused' } }), null);
  assert.equal(sourceBadge({ state: 'ok', probe: ok(), blocked: null }), null);
  assert.equal(sourceBadge({ state: 'ok', probe: null, blocked: null }), null);
  assert.equal(sourceBadge({ state: 'ok', blocked: null }), null, 'a report from an older server');
});

test('the predicates', () => {
  assert.ok(isReadFromServer({ kind: 'rss' }) && isReadFromServer({ kind: 'url' }));
  assert.ok(!isReadFromServer({ kind: 'library' }) && !isReadFromServer({ kind: 'api' }));
  assert.ok(isUnreachable({ blocked: { reason: 'unreachable', host: 'h', statusCode: null, until: '', failures: 1 } }));
  assert.ok(!isUnreachable({ blocked: { reason: 'timeout', host: 'h', statusCode: null, until: '', failures: 1 } }));
  assert.ok(!isUnreachable({ blocked: null }));
  assert.ok(probeFailed(bad('dns')) && !probeFailed(ok()) && !probeFailed(null) && !probeFailed(undefined));
});

test('rowFixes: the buttons appear only for a failed read or an unreachable block, and the proxy only when one is configured', () => {
  const rss = { kind: 'rss' as const, origin: 'card' as const, probe: undefined as SourceProbe | null | undefined, blocked: null as any };
  const unreachable = { reason: 'unreachable', host: 'x.example', statusCode: null, until: ago(-60), failures: 3 };
  const withProxy = { proxyConfigured: true };
  const without = { proxyConfigured: false };

  assert.deepEqual(rowFixes(rss, withProxy), ['test'], 'never read: only the test');
  assert.deepEqual(rowFixes({ ...rss, probe: null }, withProxy), ['test']);
  assert.deepEqual(rowFixes({ ...rss, probe: ok() }, withProxy), ['test'], 'a good read');
  assert.deepEqual(rowFixes({ ...rss, blocked: { ...unreachable, reason: 'refused' } }, withProxy), ['test'], 'a block of another reason is not this');

  assert.deepEqual(rowFixes({ ...rss, probe: bad('timeout') }, withProxy), ['test', 'proxy', 'upload', 'remove']);
  assert.deepEqual(rowFixes({ ...rss, probe: bad('timeout') }, without), ['test', 'upload', 'remove'], 'no proxy configured: no proxy button');
  assert.deepEqual(rowFixes({ ...rss, blocked: unreachable }, withProxy), ['test', 'proxy', 'upload', 'remove'], 'the block alone is enough');
  assert.deepEqual(rowFixes({ ...rss, probe: ok(), blocked: unreachable }, without), ['test', 'upload', 'remove']);
  assert.deepEqual(rowFixes({ ...rss, kind: 'url', probe: bad('empty', { kind: 'page' }) }, withProxy), ['test', 'proxy', 'upload', 'remove']);

  assert.deepEqual(rowFixes({ ...rss, origin: 'playbook', probe: bad('timeout') }, withProxy), ['test', 'proxy', 'upload'], 'a playbook source is not removed from the card');
  assert.deepEqual(rowFixes({ ...rss, origin: undefined, probe: bad('dns') }, withProxy), ['test', 'proxy', 'upload', 'remove'], 'a report with no origin is a card source');
  assert.deepEqual(rowFixes({ ...rss, probe: bad('timeout', { via_proxy: true }) }, withProxy), ['test', 'upload', 'remove'], 'it already went through the proxy');

  assert.deepEqual(rowFixes({ ...rss, probe: bad('invalid') }, withProxy), ['test', 'remove'], 'nothing to route or upload for an address that is not valid');
  assert.deepEqual(rowFixes({ ...rss, origin: 'playbook', probe: bad('invalid') }, withProxy), ['test']);
  assert.deepEqual(rowFixes({ ...rss, probe: bad('invalid'), blocked: unreachable }, withProxy), ['test', 'proxy', 'upload', 'remove'], 'a block still counts');

  for (const kind of ['library', 'api'] as const) assert.deepEqual(rowFixes({ ...rss, kind, probe: bad('timeout'), blocked: unreachable }, withProxy), [], kind);
});

test('hostOfRef and sourceName', () => {
  assert.equal(hostOfRef('https://www.Example.com/feed.xml'), 'example.com');
  assert.equal(hostOfRef('https://news.example.org:8443/a'), 'news.example.org');
  assert.equal(hostOfRef('not a url'), null);
  assert.equal(hostOfRef('library:prompts'), null, 'a scheme with no host');
  assert.equal(sourceName({ id: 'series:Prompt of the day' }), 'Prompt of the day');
  assert.equal(sourceName({ id: 'verge' }), 'verge');
  assert.equal(sourceName({ id: 'playbook:marktechpost.com' }), 'playbook:marktechpost.com');
});

test('runwayLine: rounds, none left, under 7 days, and plenty', () => {
  assert.equal(runwayLine(null), null);
  assert.equal(runwayLine(undefined), null);
  assert.deepEqual(runwayLine({ unposted: 40, days: null, rounds: true }), { text: 'Repeats in rounds', tone: 'neutral' });
  assert.deepEqual(runwayLine({ unposted: 0, days: null, rounds: false }), { text: '0 rows left', tone: 'danger' });
  assert.deepEqual(runwayLine({ unposted: 0, days: 0, rounds: false }), { text: '0 rows left', tone: 'danger' });
  assert.deepEqual(runwayLine({ unposted: 3, days: 0, rounds: false }), { text: '3 rows left · under a day', tone: 'danger' }, '0 days is the red badge');
  assert.deepEqual(runwayLine({ unposted: 12, days: 6, rounds: false }), { text: '12 rows left · ~6 days', tone: 'warning' });
  assert.deepEqual(runwayLine({ unposted: 2, days: 0.4, rounds: false }), { text: '2 rows left · under a day', tone: 'warning' });
  assert.deepEqual(runwayLine({ unposted: 1, days: 1, rounds: false }), { text: '1 row left · ~1 day', tone: 'warning' });
  assert.deepEqual(runwayLine({ unposted: 40, days: 7, rounds: false }), { text: '40 rows left · ~7 days', tone: 'neutral' });
  assert.deepEqual(runwayLine({ unposted: 1200, days: 40.4, rounds: false }), { text: '1,200 rows left · ~40 days', tone: 'neutral' });
  assert.deepEqual(runwayLine({ unposted: 30, days: null, rounds: false }), { text: '30 rows left', tone: 'neutral' }, 'no series uses it, so no days');
  assert.deepEqual(runwayLine({ unposted: null, days: 5, rounds: false }), { text: '~5 days', tone: 'warning' });
  assert.equal(runwayLine({ unposted: null, days: null, rounds: false }), null, 'nothing known');
});

test('sourceErrorMessage: the codes of the source endpoints in words, anything else is left to the shared toast', () => {
  const body = (error: string, details?: string) => JSON.stringify({ error, ...(details ? { details } : {}) });
  assert.match(sourceErrorMessage(409, body('proxy_not_configured'))!, /EGRESS_PROXY_URL/);
  assert.equal(sourceErrorMessage(400, body('invalid_host')), 'That host name is not valid.');
  assert.equal(sourceErrorMessage(404, body('source_not_found')), 'That source is no longer on the card.');
  assert.equal(sourceErrorMessage(404, body('channel_not_found')), 'That channel does not exist.');
  assert.match(sourceErrorMessage(404, body('no_list_import'))!, /nothing to re-sync/);
  assert.equal(sourceErrorMessage(409, body('url_mismatch', 'imported from https://a.example/x')), 'The dataset was imported from another address: imported from https://a.example/x');
  assert.equal(sourceErrorMessage(409, body('url_mismatch')), 'The dataset was imported from another address.');
  assert.match(sourceErrorMessage(400, body('unsupported_content'))!, /JSON/);
  assert.match(sourceErrorMessage(400, body('empty_page'))!, /no text/);
  assert.match(sourceErrorMessage(413, body('too_large'))!, /5,000,000 characters/);
  assert.match(sourceErrorMessage(413, 'Payload Too Large')!, /too large/, 'a proxy in front answers 413 in plain text');
  assert.equal(sourceErrorMessage(400, body('invalid_body')), null);
  assert.equal(sourceErrorMessage(500, 'oops'), null);
  assert.equal(sourceErrorMessage(400, ''), null);
});
