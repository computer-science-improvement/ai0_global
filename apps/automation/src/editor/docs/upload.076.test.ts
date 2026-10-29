import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_STALE_MAX_HOURS, DocStore, docIdOf } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { buildPlan } from './import-list';
import { PDR_HTML, PDR_MAPPING, PDR_SPLIT_ON, PDR_URL } from './testing/pdr-fixture';
import { UPLOAD_BODY_LIMIT, UPLOAD_PAGE_MAX_CHARS, UploadPageBody, uploadPage } from '../sources/upload-page';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const getHtml = async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: PDR_HTML });
/** A fetch that must never happen. */
const noGet = async (): Promise<never> => { throw new Error('the server fetched an uploaded page'); };

const ARGS = { dataset: 'pdr_rules', mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР', license: undefined };
const HOUR = 3_600_000;

test('an uploaded page and a live fetch of the same body give the same doc id and the same refs under split_on (the § 29 mapping)', async () => {
  const live: any = await fetchDocument(PDR_URL, { docs: new DocStore(), http: { lookup, get: getHtml } });
  const docs = new DocStore();
  const up: any = await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  assert.equal(up.error, undefined);
  assert.equal(up.doc_id, live.doc.id, 'the same address gives the same doc id');
  assert.equal(up.doc_id, docIdOf(PDR_URL));
  assert.equal(up.url, PDR_URL);
  assert.equal(up.kind, 'html');
  assert.equal(up.sections, live.doc.sections.length);
  assert.equal(up.chars, live.doc.text.length);

  const stored = docs.get(up.doc_id)!;
  assert.equal(stored.origin, 'upload');
  assert.equal(live.doc.origin, undefined, 'a fetched page is not marked');
  assert.deepEqual({ ...stored, origin: undefined, fetched_at: 0 }, { ...live.doc, origin: undefined, fetched_at: 0 }, 'the parse is the same');

  const fromLive = buildPlan(live.doc, ARGS, null);
  const fromUpload = buildPlan(stored, ARGS, null);
  assert.deepEqual(fromUpload.rows.map((r) => r.list_ref), fromLive.rows.map((r) => r.list_ref));
  assert.deepEqual(fromUpload.rows, fromLive.rows, 'every row, the url_anchor values included, equals the live import');
  assert.equal(fromUpload.rows.length, 8);
  assert.equal(fromUpload.rows.find((r) => r.clause === '14.6')!.list_ref, `${PDR_URL}#14.6`);
});

test('the address is stored canonical: no fragment, no trailing slash, lower-case host', async () => {
  const docs = new DocStore();
  const up: any = await uploadPage({ docs }, UploadPageBody.parse({ url: `https://ZAKON.rada.gov.ua/laws/show/1306-2001-%D0%BF/print/#top`, content: PDR_HTML }));
  assert.equal(up.url, PDR_URL);
  assert.equal(up.doc_id, docIdOf(PDR_URL));
  assert.equal(docs.get(up.doc_id)!.final_url, PDR_URL);
});

test('plain text and markdown uploads are parsed like a fetch of that type', async () => {
  const docs = new DocStore();
  const text: any = await uploadPage({ docs }, UploadPageBody.parse({ url: 'https://example.com/rules', content: 'Line one\r\nLine two', content_type: 'text/plain' }));
  assert.equal(text.kind, 'text');
  assert.equal(docs.get(text.doc_id)!.text, 'Line one\nLine two');
  const md: any = await uploadPage({ docs }, UploadPageBody.parse({ url: 'https://example.com/list', content: '# Title\n\n## One\n\ntext', content_type: 'text/markdown' }));
  assert.equal(md.kind, 'markdown');
  assert.equal(md.title, 'Title');
  assert.equal(md.sections, 2, 'two headings, no intro');
});

test('JSON is refused with unsupported_content and nothing is stored', async () => {
  const docs = new DocStore();
  const r: any = await uploadPage({ docs }, UploadPageBody.parse({ url: 'https://api.example.com/items', content: '{"items":[{"a":1},{"a":2}]}', content_type: 'text/plain' }));
  assert.equal(r.error, 'unsupported_content');
  assert.match(r.details, /JSON/);
  assert.equal(docs.size, 0);
  const arr: any = await uploadPage({ docs }, UploadPageBody.parse({ url: 'https://api.example.com/items', content: '[{"a":1}]', content_type: 'text/plain' }));
  assert.equal(arr.error, 'unsupported_content');
  assert.equal(docs.size, 0);
});

test('a page with no text is refused with empty_page', async () => {
  const docs = new DocStore();
  const r: any = await uploadPage({ docs }, UploadPageBody.parse({ url: 'https://example.com/blank', content: '<html><head></head><body>   </body></html>' }));
  assert.equal(r.error, 'empty_page');
  assert.equal(docs.size, 0);
});

test('an upload stays fresh for DOC_STALE_MAX_HOURS, a fetched page only for the fetch-cache hours', async () => {
  let now = 1_000_000_000_000;
  const docs = new DocStore({ now: () => now });
  const up: any = await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  now += 7 * HOUR;   // past the 6 h fetch cache
  assert.ok(docs.fresh(PDR_URL), 'the upload is fresh after 7 h');
  now += 100 * HOUR;
  assert.ok(docs.fresh(PDR_URL), 'and after 107 h');
  assert.equal(docs.get(up.doc_id)?.origin, 'upload');
  now += (DOC_STALE_MAX_HOURS - 107) * HOUR + 60_000;
  assert.equal(docs.fresh(PDR_URL), null, 'past the stale cap it is gone');
  assert.equal(docs.get(up.doc_id), null);

  // The same clock with a fetched page: stale after 6 h, still kept.
  const live = new DocStore({ now: () => now });
  const r: any = await fetchDocument(PDR_URL, { docs: live, http: { lookup, get: getHtml } });
  now += 7 * HOUR;
  assert.equal(live.fresh(PDR_URL), null);
  assert.ok(live.get(r.doc.id), 'the stale copy is still kept');
});

test('fetchDocument serves the upload without a request, and a fresh fetch is the only way past it', async () => {
  const docs = new DocStore();
  await uploadPage({ docs }, UploadPageBody.parse({ url: PDR_URL, content: PDR_HTML }));
  const r: any = await fetchDocument(PDR_URL, { docs, http: { lookup, get: noGet } });
  assert.equal(r.cached, true);
  assert.equal(r.doc.origin, 'upload');
  // A later live fetch of the same address replaces the upload with a fetched copy.
  const live: any = await fetchDocument(PDR_URL, { docs, http: { lookup, get: getHtml }, fresh: true });
  assert.equal(live.cached, false);
  assert.equal(live.doc.origin, undefined);
  assert.equal(docs.get(docIdOf(PDR_URL))!.origin, undefined);
});

test('the body schema: http(s) only, content size, default content type, dataset key', () => {
  const ok = UploadPageBody.parse({ url: 'https://example.com/a', content: 'x' });
  assert.equal(ok.content_type, 'text/html');
  assert.equal(ok.dataset, undefined);
  assert.equal(UploadPageBody.parse({ url: 'https://example.com/a', content: 'x', dataset: 'pdr_rules' }).dataset, 'pdr_rules');
  assert.throws(() => UploadPageBody.parse({ url: 'ftp://example.com/a', content: 'x' }));
  assert.throws(() => UploadPageBody.parse({ url: 'javascript:alert(1)', content: 'x' }));
  assert.throws(() => UploadPageBody.parse({ url: 'https://example.com/a', content: '' }));
  assert.throws(() => UploadPageBody.parse({ url: 'https://example.com/a', content: 'x', content_type: 'application/pdf' }));
  assert.throws(() => UploadPageBody.parse({ url: 'https://example.com/a', content: 'x', dataset: 'Not A Key' }));
  assert.equal(UPLOAD_PAGE_MAX_CHARS, 5_000_000);
  assert.ok(UploadPageBody.safeParse({ url: 'https://example.com/a', content: 'a'.repeat(UPLOAD_PAGE_MAX_CHARS) }).success);
  assert.ok(!UploadPageBody.safeParse({ url: 'https://example.com/a', content: 'a'.repeat(UPLOAD_PAGE_MAX_CHARS + 1) }).success);
  assert.equal(UPLOAD_BODY_LIMIT, 12 * 1024 * 1024);
});
