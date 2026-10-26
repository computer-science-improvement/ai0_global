/**
 * Spec 070 FR-003: when the refetch of a page fails because the site is down or turns the request away, the copy the
 * DocStore still keeps is answered (stale, with the time it was fetched). A page that is gone (404 / 410), a body that is
 * not a document and a re-sync (`fresh: true`) never get an old copy. No network: pages come from an injected getter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';
import type { HostBlock, HostFailures } from '../net/host-failures';
import { DocStore } from './doc-store';
import { fetchDocument, webFetchAnswer } from './doc-fetch';
import { buildDocTools } from './doc-tools';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const URL1 = 'https://news.example/2026/10/a-story';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-26T12:00:00Z');

type Answer = { status?: number; type?: string; body?: string } | Error;

function rig(first: Answer = { body: '<title>Story</title><p>The story text.</p>' }) {
  let now = T0;
  let answer: Answer = first;
  const hits: string[] = [];
  const get = async (url: string) => {
    hits.push(url);
    if (answer instanceof Error) throw answer;
    return { status: answer.status ?? 200, headers: { 'content-type': answer.type ?? 'text/html' }, data: answer.body ?? '' };
  };
  const docs = new DocStore({ ttlHours: 6, now: () => now });
  const http = { lookup, get };
  return {
    docs, hits, http,
    set: (a: Answer) => { answer = a; },
    later: (hours: number) => { now += hours * HOUR; },
    fetch: (o: { fresh?: boolean; hosts?: HostFailures } = {}) => fetchDocument(URL1, { docs, http, retryMs: 0, ...o }),
  };
}

const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

test('a reset after a first success serves the kept copy: same doc_id, cached, stale, with fetched_at and a note', async () => {
  const w = rig();
  const first: any = await w.fetch();
  assert.equal(first.cached, false);
  assert.equal(first.stale, undefined);
  w.later(7);                                  // past the 6 h lifetime of the fetch cache
  w.set(reset());
  const r: any = await w.fetch();
  assert.equal(r.doc.id, first.doc.id, 'the same doc_id');
  assert.equal(r.doc.fetched_at, T0, 'the copy of the first fetch');
  assert.equal(r.cached, true);
  assert.deepEqual(r.stale, { reason: 'host_unreachable' });
  assert.equal(w.hits.length, 3, 'the first fetch, then the refetch and its one retry');

  const a = webFetchAnswer(r.doc, r.cached, r.stale);
  assert.equal(a.stale, true);
  assert.equal(a.cached, true);
  assert.equal(a.fetched_at, '2026-10-26T12:00:00.000Z');
  assert.equal(a.note, 'копія від 2026-10-26 12:00 UTC; сайт зараз недоступний');
  assert.match(String(a.text), /The story text/);
  const plain = webFetchAnswer(first.doc, false);
  assert.equal(plain.stale, undefined);
  assert.equal(plain.fetched_at, undefined);
  assert.equal(plain.note, undefined);
});

test('inside the lifetime nothing is fetched and nothing is stale; past it a working site gives a fresh copy under the same id', async () => {
  const w = rig();
  const first: any = await w.fetch();
  w.later(5);
  const hit: any = await w.fetch();
  assert.deepEqual([hit.cached, hit.stale, w.hits.length], [true, undefined, 1]);
  w.later(2);
  w.set({ body: '<title>Story</title><p>The story, updated.</p>' });
  const again: any = await w.fetch();
  assert.equal(again.cached, false);
  assert.equal(again.stale, undefined);
  assert.equal(again.doc.id, first.doc.id);
  assert.ok(again.doc.fetched_at > T0);
  assert.match(again.doc.text, /updated/);
});

test('a blocked host, 5xx and the refusals 401 / 403 / 429 / 451 serve the kept copy', async () => {
  for (const status of [500, 502, 503, 401, 403, 429, 451]) {
    const w = rig();
    await w.fetch();
    w.later(10);
    w.set({ status, body: 'no' });
    const r: any = await w.fetch();
    assert.equal(r.doc?.text.includes('The story text'), true, `status ${status}`);
    assert.deepEqual(r.stale, { reason: `status ${status}` });
  }
  const w = rig();
  await w.fetch();
  w.later(10);
  const hosts: HostFailures = {
    blocked: async (host): Promise<HostBlock> => ({ host, reason: 'refused', statusCode: 403, until: new Date(T0 + 30 * HOUR) }),
    record: async () => undefined,
  };
  const before = w.hits.length;
  const r: any = await w.fetch({ hosts });
  assert.deepEqual(r.stale, { reason: 'host_blocked' });
  assert.equal(w.hits.length, before, 'a blocked host is not asked');
});

test('404, 410, other client errors and a body that is not a document never serve an old copy', async () => {
  for (const answer of [{ status: 404, body: 'gone' }, { status: 410, body: 'gone' }, { status: 400, body: 'bad' }, { type: 'image/png', body: 'PNG' }] as Answer[]) {
    const w = rig();
    await w.fetch();
    w.later(10);
    w.set(answer);
    const r: any = await w.fetch();
    assert.ok(r.error, JSON.stringify(answer));
    assert.equal(r.doc, undefined);
  }
});

test('fresh: true (a re-sync) never serves a stale copy', async () => {
  const w = rig();
  await w.fetch();
  w.later(10);
  w.set(reset());
  const r: any = await w.fetch({ fresh: true });
  assert.equal(r.error, 'host_unreachable');
  assert.equal(r.doc, undefined);
});

test('with no kept copy the failure is answered as before', async () => {
  const w = rig(reset());
  const r: any = await w.fetch();
  assert.equal(r.error, 'host_unreachable');
  assert.match(r.details, /сайт обірвав з'єднання/);
});

test('a copy older than the stale cap (168 h) is gone: the failure is answered', async () => {
  const w = rig();
  await w.fetch();
  w.later(169);
  w.set(reset());
  assert.equal(((await w.fetch()) as any).error, 'host_unreachable');
});

test('a JSON document answers stale too (the early return of jsonAnswer carries the flag, fetched_at and the note)', async () => {
  const w = rig({ type: 'application/json', body: JSON.stringify({ items: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }] }) });
  const first: any = await w.fetch();
  assert.equal(first.doc.kind, 'json');
  w.later(8);
  w.set({ status: 503, body: 'down' });
  const r: any = await w.fetch();
  const a = webFetchAnswer(r.doc, r.cached, r.stale);
  assert.equal(a.doc_id, first.doc.id);
  assert.equal(a.stale, true);
  assert.equal(a.cached, true);
  assert.equal(a.fetched_at, '2026-10-26T12:00:00.000Z');
  assert.match(String(a.note), /^копія від 2026-10-26 12:00 UTC; сайт зараз недоступний$/);
  assert.ok(a.json, 'the shape of the JSON is still answered');
});

test('web_fetch answers the stale copy through the tool, and read_doc reads the same copy by its doc_id', async () => {
  const w = rig({ body: `<title>Long</title><article>${'<h2>Part</h2><p>Sentence of the long page. </p>'.repeat(300)}</article>` });
  const pool = { query: async () => ({ rows: [] }) } as any;
  const tools = Object.fromEntries([
    ...buildReadTools({ pool, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: w.http, docs: w.docs, retryMs: 0 }),
    ...buildDocTools({ docs: w.docs }),
  ].map((t) => [t.name, t])) as Record<string, any>;
  const first = await tools.web_fetch.execute({ url: URL1 }, ctx);
  w.later(9);
  w.set(reset());
  const r = await tools.web_fetch.execute({ url: URL1 }, ctx);
  assert.equal(r.stale, true);
  assert.equal(r.cached, true);
  assert.equal(r.doc_id, first.doc_id);
  assert.equal(r.fetched_at, '2026-10-26T12:00:00.000Z');
  assert.match(r.note, /^копія від 2026-10-26 12:00 UTC/);
  const part = await tools.read_doc.execute({ doc_id: r.doc_id, section: 's2' }, ctx);
  assert.match(part.text, /Sentence of the long page/);
  assert.match(tools.web_fetch.description, /stale: true/);
});
