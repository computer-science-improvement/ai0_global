import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocStore } from '../docs/doc-store';
import { fetchDocument } from '../docs/doc-fetch';
import { buildImportListTools } from '../docs/import-list-tools';
import { PDR_HTML, PDR_MAPPING, PDR_SPLIT_ON, PDR_URL } from '../docs/testing/pdr-fixture';
import { importReach, REACH_MANUAL_LINE, type ReachProbe } from './import-reach';
import { uploadPage, UploadPageBody } from './upload-page';
import type { ProbeResult } from './probe';

/** Spec 076 A16: `reach` in the `import_list` preview, with its four cases. */

const HOUR = 3_600_000;
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: PDR_HTML });
const jsonBody = JSON.stringify([{ title: 'First', text: 'The first record of the list' }, { title: 'Second', text: 'The second record of the list' }]);
const json = async () => ({ status: 200, headers: { 'content-type': 'application/json' }, data: jsonBody });
const ctx = { runId: 'r', role: 'composer', channelKey: null, extras: {} };

const probeResult = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  ok: true, failure_class: null, status: 200, kind: 'page', feed_url: null, items: 0, newest_at: null, sample_titles: [], checked_at: '2026-10-29T10:00:00.000Z',
  via_proxy: false, url: PDR_URL, detail: 'page, 4000 characters', ms: 120, cached: false, blocked_until: null, ...over,
});

function rig(probe?: ReachProbe) {
  const proposed: any[] = [];
  const pool = { query: async () => ({ rows: [] }) } as any;
  let now = Date.UTC(2026, 9, 29, 10, 0, 0);
  const docs = new DocStore({ now: () => now });
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs, now: () => new Date(now), ...(probe ? { probe } : {}),
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const run = (doc_id: string) => tools.import_list.execute(tools.import_list.input.parse({
    doc_id, dataset: 'pdr_rules', mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР',
  }), ctx);
  return { docs, run, proposed, pass: (ms: number) => { now += ms; } };
}

const calls = (): { probe: ReachProbe; seen: Array<[string, unknown]> } => {
  const seen: Array<[string, unknown]> = [];
  return { seen, probe: async (u, o) => { seen.push([u, o]); return probeResult(); } };
};

test('a page fetched live a moment ago: reach is auto, "read just now", and nothing is probed', async () => {
  const { probe, seen } = calls();
  const r = rig(probe);
  const f: any = await fetchDocument(PDR_URL, { docs: r.docs, http: { lookup, get: html } });
  r.pass(2 * HOUR);
  const out = await r.run(f.doc.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.preview.reach, { ok: true, resync: 'auto', detail: 'read just now' });
  assert.ok(!(out.preview.notes ?? []).includes(REACH_MANUAL_LINE));
  assert.deepEqual(seen, []);
});

test('an uploaded page: reach is manual with the line, and nothing is probed', async () => {
  const { probe, seen } = calls();
  const r = rig(probe);
  const up: any = await uploadPage({ docs: r.docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  const out = await r.run(up.doc_id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.preview.reach, { ok: false, resync: 'manual', detail: 'uploaded page' });
  assert.ok(out.preview.notes.includes('The server cannot re-read this page: re-sync of this dataset is manual (upload the page again).'));
  assert.deepEqual(seen, []);
  assert.equal(r.proposed[0].payload.uploaded, true);
});

test('an older page is probed, cache first: a page that answers is auto, one that does not is manual with the line', async () => {
  for (const [label, result, resync] of [
    ['ok', probeResult(), 'auto'],
    ['timeout', probeResult({ ok: false, failure_class: 'timeout', status: null, detail: 'timed out twice (10 s)', via_proxy: false }), 'manual'],
  ] as const) {
    const seen: Array<[string, any]> = [];
    const r = rig(async (u, o) => { seen.push([u, o]); return result; });
    const f: any = await fetchDocument(PDR_URL, { docs: r.docs, http: { lookup, get: html } });
    r.pass(7 * HOUR);
    const out = await r.run(f.doc.id);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(seen, [[PDR_URL, { kind: 'url' }]], `${label}: probed once, not forced`);
    assert.equal(out.preview.reach.resync, resync, label);
    assert.equal(out.preview.reach.ok, result.ok);
    assert.equal(out.preview.reach.detail, result.detail);
    assert.equal(out.preview.reach.checked_at, result.checked_at);
    assert.equal((out.preview.notes ?? []).includes(REACH_MANUAL_LINE), resync === 'manual', label);
    if (!result.ok) assert.equal(out.preview.reach.failure_class, 'timeout');
  }
});

test('a JSON document has no reach, and without the port the preview has none either', async () => {
  const { probe, seen } = calls();
  const withPort = rig(probe);
  const j: any = await fetchDocument('https://api.example.test/items', { docs: withPort.docs, http: { lookup, get: json } });
  const jsonRun = await buildImportListTools({
    pool: { query: async () => ({ rows: [] }) } as any, docs: withPort.docs, probe,
    actions: { propose: async (a: any) => ({ id: 'pa', ...a }) } as any,
  }).find((t) => t.name === 'import_list')!.execute(
    { doc_id: j.doc.id, dataset: 'items_set', mapping: { title: 'field:title', text: 'field:text' }, sample: 3 } as any, ctx as any) as any;
  assert.equal(jsonRun.ok, true, JSON.stringify(jsonRun));
  assert.ok(!('reach' in jsonRun.preview));
  assert.deepEqual(seen, []);

  const plain = rig();
  const f: any = await fetchDocument(PDR_URL, { docs: plain.docs, http: { lookup, get: html } });
  plain.pass(9 * HOUR);
  const noPort = await plain.run(f.doc.id);
  assert.equal(noPort.ok, true, JSON.stringify(noPort));
  assert.ok(!('reach' in noPort.preview), 'the existing preview is unchanged');
});

test('a probe that throws leaves the preview as it was', async () => {
  const r = rig(async () => { throw new Error('probe broke'); });
  const f: any = await fetchDocument(PDR_URL, { docs: r.docs, http: { lookup, get: html } });
  r.pass(8 * HOUR);
  const out = await r.run(f.doc.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(!('reach' in out.preview));
});

test('importReach on its own: the order of the cases', async () => {
  const live = { kind: 'html' as const, fetched_at: 1_000_000 };
  const probe: ReachProbe = async () => probeResult();
  assert.equal(await importReach(live, PDR_URL, undefined), null, 'no port');
  assert.equal(await importReach({ ...live, kind: 'json' }, PDR_URL, probe), null, 'JSON');
  assert.equal((await importReach({ ...live, origin: 'upload' }, PDR_URL, probe, new Date(live.fetched_at + 30 * 24 * HOUR)))!.reach.resync, 'manual', 'an upload is manual however old');
  assert.equal((await importReach(live, PDR_URL, probe, new Date(live.fetched_at + 6 * HOUR)))!.reach.detail, 'read just now', 'exactly 6 h still counts');
  assert.equal((await importReach(live, PDR_URL, probe, new Date(live.fetched_at + 6 * HOUR + 1)))!.reach.detail, 'page, 4000 characters', 'past 6 h the probe answers');
});
