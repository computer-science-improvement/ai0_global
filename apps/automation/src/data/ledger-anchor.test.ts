// Spec 061 FR-002: reference documents in the content ledger — the pure helpers and the ContentLedger client over a fake pool
// (the rules themselves run in SQL; see ledger-anchor.pg.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentLedger, specRefs } from './content-ledger';
import {
  anchorOf, fragmentOf, isReusableHost, normalizeAnchor, refHost, reusableHosts, sourceRefOf, sourceUsedDetails, splitRef,
} from './ledger-anchor';

const LAW = 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF';

function fakePool(answer: (sql: string, params: unknown[]) => any[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: answer(sql, params), rowCount: 0 }; } } as any,
  };
}

test('reusableHosts: the setting as a host list, the default when unset', () => {
  assert.deepEqual(reusableHosts({}), ['zakon.rada.gov.ua']);
  assert.deepEqual(reusableHosts({ LEDGER_REUSABLE_HOSTS: ' ' }), ['zakon.rada.gov.ua']);
  assert.deepEqual(reusableHosts({ LEDGER_REUSABLE_HOSTS: 'Zakon.Rada.gov.ua, www.iso.org' }), ['zakon.rada.gov.ua', 'iso.org']);
});

test('isReusableHost: the host and its subdomains, not look-alikes', () => {
  const hosts = ['zakon.rada.gov.ua'];
  assert.equal(isReusableHost(LAW, hosts), true);
  assert.equal(isReusableHost('http://www.zakon.rada.gov.ua/x', hosts), true);
  assert.equal(isReusableHost('https://m.zakon.rada.gov.ua/x', hosts), true);
  assert.equal(isReusableHost('https://evilzakon.rada.gov.ua.example/x', hosts), false);
  assert.equal(isReusableHost('https://rada.gov.ua/x', hosts), false);
  assert.equal(isReusableHost('data://prompts/1', hosts), false);
  assert.equal(refHost('not a url'), null);
});

test('normalizeAnchor: trimmed, one space, lower case, at most 40 characters; blank is none', () => {
  assert.equal(normalizeAnchor('  П.1.10  '), 'п.1.10');
  assert.equal(normalizeAnchor('Розділ   2,\n п. 3'), 'розділ 2, п. 3');
  assert.equal(normalizeAnchor('   '), null);
  assert.equal(normalizeAnchor(undefined), null);
  assert.equal(normalizeAnchor('x'.repeat(60))!.length, 40);
});

test('anchorOf / sourceRefOf: source.anchor wins over the #fragment; the ref carries the anchor as its fragment', () => {
  assert.equal(anchorOf({ url: LAW, anchor: 'п.1.10' }), 'п.1.10');
  assert.equal(anchorOf({ url: `${LAW}#п.2.3` }), 'п.2.3');
  assert.equal(anchorOf({ url: `${LAW}#%D0%BF.2.3` }), 'п.2.3', 'a percent-encoded fragment is decoded');
  assert.equal(anchorOf({ url: `${LAW}#п.2.3`, anchor: 'п.9' }), 'п.9');
  assert.equal(anchorOf({ url: LAW }), null);
  assert.equal(anchorOf(undefined), null);
  assert.equal(sourceRefOf({ url: LAW }), LAW);
  assert.equal(sourceRefOf({ url: `${LAW}#old`, anchor: 'п.1.10' }), `${LAW}#п.1.10`);
  assert.equal(sourceRefOf(undefined), null);
  assert.equal(fragmentOf(LAW), null);
});

test('splitRef: the anchor counts only on a reusable host', () => {
  const hosts = ['zakon.rada.gov.ua'];
  assert.deepEqual(splitRef(`${LAW}#П.1.10`, hosts), { url: LAW, anchor: 'п.1.10', reusable: true });
  assert.deepEqual(splitRef(LAW, hosts), { url: LAW, anchor: null, reusable: true });
  assert.deepEqual(splitRef('https://nasa.gov/a#top', hosts), { url: 'https://nasa.gov/a', anchor: null, reusable: false });
});

test('specRefs: a source with an anchor comes with it as the ref fragment', () => {
  assert.deepEqual(specRefs({ source: { url: LAW, anchor: 'п.1.10' } }), [`${LAW}#п.1.10`]);
  assert.deepEqual(specRefs({ library_ref: 'data://pdr/1', source: { url: LAW } }), ['data://pdr/1', LAW]);
});

test('sourceUsedDetails: what was used, when, in which slot, and the remedy (Ukrainian)', () => {
  const at = new Date('2026-10-20T10:00:00Z');
  const plain = sourceUsedDetails('https://x.example/a', { at, slotId: 'slot-7', status: 'published' }, false);
  assert.match(plain, /джерело https:\/\/x\.example\/a уже використано 2026-10-20 у слоті slot-7/);
  assert.match(plain, /source\.anchor/);
  const clause = sourceUsedDetails(`${LAW}#п.1.10`, { at, slotId: 'slot-9', status: 'published', anchor: 'п.1.10' }, true);
  assert.match(clause, /\(п\.1\.10\)/);
  assert.match(clause, /інший пункт/);
  assert.match(sourceUsedDetails('https://x.example/a', { status: 'waiting', slotId: 's' }, false), /чекає на публікацію у слоті s/);
});

test('ContentLedger.record: a reusable host with an anchor goes to content_ledger_record with the anchor; the URL has no fragment', async () => {
  const f = fakePool(() => [{ added: true }]);
  const l = new ContentLedger(f.pool, undefined, () => ['zakon.rada.gov.ua']);
  assert.equal(await l.record(`${LAW}#П.1.10`, { resourceRef: '@pdr', origin: 'editor', status: 'published', publishedPostId: 3 }), true);
  assert.match(f.calls[0].sql, /content_ledger_record_anchored/);
  assert.equal(f.calls[0].params[1], LAW);
  assert.equal(f.calls[0].params[2], 'п.1.10');
  // Another host keeps the old 9-argument call and its own ref.
  await l.record('https://nasa.gov/a#top', { resourceRef: '@pdr', origin: 'editor', status: 'published' });
  assert.doesNotMatch(f.calls[1].sql, /anchored/);
  assert.equal(f.calls[1].params[1], 'https://nasa.gov/a#top');
  // No anchor on a reusable host: the plain row, as before.
  await l.record(LAW, { resourceRef: '@pdr', origin: 'editor', status: 'published' });
  assert.doesNotMatch(f.calls[2].sql, /anchored/);
});

test('ContentLedger.check: a reusable host without an anchor is never stopped; with an anchor the anchored ref is asked', async () => {
  const f = fakePool((sql) => (sql.includes('content_ref_anchored($1, $2) AS r') ? [{ r: `${LAW}#п.1.10` }] : []));
  const l = new ContentLedger(f.pool, undefined, () => ['zakon.rada.gov.ua']);
  assert.deepEqual(await l.check('@pdr', LAW, { waiting: true }), { used: false });
  assert.equal(f.calls.length, 0, 'no query at all without an anchor');

  assert.deepEqual(await l.check('@pdr', `${LAW}#П.1.10`), { used: false });
  assert.deepEqual(f.calls[0].params, [LAW, 'п.1.10']);
  assert.deepEqual(f.calls[1].params.slice(0, 3), ['telegram:@pdr', [`${LAW}#п.1.10`], 'resource'], 'the blocking query asks for the anchored ref only');
});

test('ContentLedger.check: a hit on an anchored ref says which clause and which slot', async () => {
  const at = new Date('2026-10-20T10:00:00Z');
  const f = fakePool((sql) => (sql.includes('content_ref_anchored($1, $2) AS r') ? [{ r: `${LAW}#п.1.10` }]
    : sql.includes('content_ledger_blocking') ? [{ status: 'published', resource_ref: 'telegram:@pdr', source_ref: `${LAW}#п.1.10`, used_at: at, slot_id: 'slot-1' }] : []));
  const v = await new ContentLedger(f.pool, undefined, () => ['zakon.rada.gov.ua']).check('@pdr', `${LAW}#п.1.10`);
  assert.deepEqual(v, { used: true, status: 'published', resourceRef: 'telegram:@pdr', ref: `${LAW}#п.1.10`, at, slotId: 'slot-1', anchor: 'п.1.10' });
});

test('ContentLedger.recordRefs: a reusable URL given plain and with its anchor is recorded once, under the anchor', async () => {
  const f = fakePool(() => [{ added: true }]);
  const l = new ContentLedger(f.pool, undefined, () => ['zakon.rada.gov.ua']);
  const n = await l.recordRefs([LAW, `${LAW}#п.1.10`, 'https://nasa.gov/a'], { resourceRef: '@pdr', origin: 'editor', status: 'published' });
  assert.equal(n, 2);
  assert.deepEqual(f.calls.map((c) => c.params[1]), [LAW, 'https://nasa.gov/a']);
  assert.equal(f.calls[0].params[2], 'п.1.10');
});
