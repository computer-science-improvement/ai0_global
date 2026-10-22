import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { buildPlan, ImportListInput, previewOf, payloadOf, summaryOf } from './import-list';
import { failureText, importCaps, pagingNote, pagingPreview, readPages, type PageMeasure } from './json-pages';
import type { StoredDoc } from './doc-types';
import { promptschatPage, promptschatPageUrl, PROMPTSCHAT_TEXT_IMAGE_TITLES, PROMPTSCHAT_URL } from './testing/promptschat-fixture';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

type Answer = { status?: number; body: unknown; type?: string };
function api(answers: Record<string, Answer | (() => never)>) {
  const hits: string[] = [];
  const get = async (url: string) => {
    hits.push(url);
    const a = answers[url];
    if (!a) return { status: 404, headers: { 'content-type': 'text/html' }, data: 'nope' };
    if (typeof a === 'function') a();
    const r = a as Answer;
    return { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/json' }, data: r.body };
  };
  return { hits, http: { lookup, get } };
}

const PC = { [promptschatPageUrl(1)]: { body: promptschatPage(1) }, [promptschatPageUrl(2)]: { body: promptschatPage(2) } };

async function firstDoc(url: string, http: ReturnType<typeof api>['http']): Promise<StoredDoc> {
  const r: any = await fetchDocument(url, { docs: new DocStore(), http });
  assert.ok(r.doc, JSON.stringify(r));
  return r.doc;
}

const MAPPING = {
  title: 'field:title', prompt_text: 'field:content', media_url: 'field:mediaUrl', type: 'field:type', category: 'field:category.name',
  author: 'first_of:author.name|author.username', source_url: 'const:https://prompts.chat/',
};
const bothPages = () => [...(promptschatPage(1).prompts as unknown[]), ...(promptschatPage(2).prompts as unknown[])];

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('where type TEXT or IMAGE over both pages gives exactly the expected rows, with refs by id', async () => {
  const { http } = api(PC);
  const doc = await firstDoc(PROMPTSCHAT_URL, http);
  const plan = buildPlan(doc, { dataset: 'promptschat', mapping: MAPPING, filter: { where: { type: ['TEXT', 'IMAGE'] } } }, null, { records: bothPages() });
  assert.equal(plan.entries, 10);
  assert.equal(plan.filtered, 5);
  assert.deepEqual(plan.rows.map((r) => r.title), PROMPTSCHAT_TEXT_IMAGE_TITLES);
  assert.equal(plan.incomplete.length, 0);
  const [sarcasm, puffin, vault, maki, linux] = plan.rows as Array<Record<string, string>>;
  assert.deepEqual(sarcasm, {
    title: 'Sarcasm', prompt_text: 'I will provide comments. I may offer my own views on those comments.\nRespond with sarcasm: dry, short, never cruel.',
    type: 'TEXT', category: 'Writing', author: 'Robert Roquet', source_url: 'https://prompts.chat/',
    list_ref: 'https://prompts.chat/api/prompts#cmv_sarcasm', list_url: PROMPTSCHAT_URL,
  });
  assert.match(puffin.media_url, /puffins\.jpg$/);
  assert.equal(puffin.category, 'Image Generation');
  assert.equal(vault.author, 'dillonbowen123');
  assert.equal(maki.list_ref, 'https://prompts.chat/api/prompts#cmv_maki', 'the ref does not carry the page or page size');
  assert.match(linux.prompt_text, /terminal\.\nI will type commands.*\n\nMy first command is pwd\.$/s);
  assert.deepEqual(plan.notes, ['no licence given: rows get the dataset default (unknown)']);
});

test('the default required of a JSON import: the row needs its text or its picture; the dataset it creates says so', async () => {
  const doc = await firstDoc(PROMPTSCHAT_URL, api(PC).http);
  const plan = buildPlan(doc, { dataset: 'promptschat', mapping: MAPPING }, null, { records: bothPages() });
  assert.deepEqual(plan.required, [['prompt_text', 'media_url']]);
  assert.equal(plan.rows.length, 10, 'every record has a prompt');
  assert.deepEqual(plan.newSchema!.post_requires, [['prompt_text', 'media_url']]);
  assert.equal(plan.newSchema!.dedup_key[0], 'list_ref');
  const fields = Object.fromEntries(plan.newSchema!.fields.map((f) => [f.name, f]));
  assert.equal(fields.prompt_text.type, 'long_text');
  assert.equal(fields.media_url.type, 'image_url');
  assert.equal(fields.title.type, 'text');
  assert.deepEqual(['type', 'category', 'title', 'author'].map((n) => !!fields[n].filterable), [true, true, false, false], 'type, kind and category are filterable');

  const textOnly = buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'field:title', prompt_text: 'field:content' } }, null);
  assert.deepEqual(textOnly.required, ['prompt_text'], 'one such field: plain');
  assert.deepEqual(buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'field:title' } }, null).required, [], 'none: nothing required');
  const explicit = buildPlan(doc, { dataset: 'ds_p', mapping: MAPPING, required: ['title', 'media_url'] }, null, { records: bothPages() });
  assert.deepEqual(explicit.newSchema!.post_requires, [['title'], ['media_url']], 'a given list needs every field');
  assert.equal(explicit.rows.length, 2, 'only the two pictures');
  assert.equal(explicit.incomplete.length, 8);
  assert.throws(() => buildPlan(doc, { dataset: 'ds_p', mapping: MAPPING, required: ['nope'] }, null), /does not fill/);
});

test('where and has beside filter are the same as inside it; kind and category are filterable too', async () => {
  const doc = await firstDoc(PROMPTSCHAT_URL, api(PC).http);
  const a = buildPlan(doc, { dataset: 'ds_p', mapping: MAPPING, filter: { where: { type: ['IMAGE'] }, has: ['mediaUrl'] } }, null, { records: bothPages() });
  const b = buildPlan(doc, { dataset: 'ds_p', mapping: MAPPING, where: { type: ['IMAGE'] }, has: ['mediaUrl'] }, null, { records: bothPages() });
  assert.deepEqual(b.rows, a.rows);
  assert.deepEqual(b.filter, { where: { type: ['IMAGE'] }, has: ['mediaUrl'] });
  const kind = buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'field:title', kind: 'field:type' } }, null);
  assert.equal(kind.newSchema!.fields.find((f) => f.name === 'kind')!.filterable, true);
  assert.doesNotThrow(() => ImportListInput.parse({ doc_id: 'doc_1234567890', dataset: 'ds_x', mapping: MAPPING, where: { type: ['TEXT', 'IMAGE'], voteCount: 3 }, has: ['mediaUrl'], pages: 5 }));
  assert.throws(() => ImportListInput.parse({ doc_id: 'doc_1234567890', dataset: 'ds_x', mapping: MAPPING, pages: 0 }));
});

test('JSON errors: a heading filter, a markdown extractor, a JSON document with no records', async () => {
  const doc = await firstDoc(PROMPTSCHAT_URL, api(PC).http);
  const err = (f: () => unknown) => { try { f(); } catch (e: any) { return e.code as string; } return undefined; };
  assert.equal(err(() => buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'heading' } }, null)), 'wrong_extractor');
  assert.equal(err(() => buildPlan(doc, { dataset: 'ds_p', mapping: MAPPING, filter: { has_image: true } }, null)), 'wrong_filter');
  assert.equal(err(() => buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'field:a[' } }, null)), 'bad_extractor');
  const none = await firstDoc('https://a.example/obj', api({ 'https://a.example/obj': { body: { a: 1 } } }).http);
  assert.equal(err(() => buildPlan(none, { dataset: 'ds_p', mapping: MAPPING }, null)), 'no_entries');
  assert.equal(err(() => buildPlan(doc, { dataset: 'ds_p', mapping: { ...MAPPING, title: 'field:title' }, level: 3 }, null)), undefined, 'level does not apply to JSON');
});

test('a ref is the list address without paging, then the id (else uuid, slug, title, position); a repeated id is counted once', async () => {
  const records = [
    { id: 'a1', title: 'One' }, { uuid: 'u2', title: 'Two' }, { slug: 's3', title: 'Three' }, { title: 'Four' }, { title: 'Four' }, { x: 1 },
    { id: 'a1', title: 'One again' }, { id: 7, title: 'Seven' },
  ];
  const doc = await firstDoc('https://a.example/api?perPage=50&page=1&type=IMAGE', api({ 'https://a.example/api?perPage=50&page=1&type=IMAGE': { body: { items: records.slice(0, 1), page: 1, totalPages: 1 } } }).http);
  const plan = buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'field:title' }, required: [] }, null, { records });
  assert.deepEqual(plan.rows.map((r) => r.list_ref), [
    'https://a.example/api?type=IMAGE#a1', 'https://a.example/api?type=IMAGE#u2', 'https://a.example/api?type=IMAGE#s3',
    'https://a.example/api?type=IMAGE#four', 'https://a.example/api?type=IMAGE#four (2)', 'https://a.example/api?type=IMAGE#record 6',
    'https://a.example/api?type=IMAGE#7',
  ]);
  assert.ok(plan.notes.some((n) => /no id, uuid, slug or title/.test(n)), 'a position ref is a warning');
  assert.ok(plan.notes.some((n) => /1 records repeat an id/.test(n)));
  const noWarn = buildPlan(doc, { dataset: 'ds_p', mapping: { title: 'field:title' }, required: [] }, null, { records: records.slice(0, 5) });
  assert.ok(!noWarn.notes.some((n) => /no id/.test(n)));
});

test('the preview counts the first page and says what Apply reads; the card line says about how many', async () => {
  const caps = importCaps(() => undefined);
  assert.deepEqual(caps, { maxPages: 30, maxRows: 3000 });
  const doc = await firstDoc(PROMPTSCHAT_URL, api(PC).http);
  const plan = buildPlan(doc, { dataset: 'promptschat', mapping: MAPPING }, null);
  const paging = pagingPreview(doc, { caps });
  assert.deepEqual([paging.kind, paging.pages_total, paging.records_total, paging.pages_to_read, paging.notes], ['page', 2, 10, 2, []]);
  const preview: any = previewOf(plan, 3, false, 'promptschat', paging);
  assert.equal(preview.importable, 5, 'the first page');
  assert.deepEqual(preview.pages, { counts_are_of: 'the first page', kind: 'page', pages_total: 2, records_total: 10, pages_to_read: 2 });
  assert.match(summaryOf(plan, 'promptschat', false, paging), /^Import about 10 entries \(5 on the first page, up to 2 pages\)/);
  assert.match(summaryOf(plan, 'promptschat', false, { ...paging, pages_to_read: 1 }), /^Import 5 entries from/);
  assert.equal(payloadOf(plan, 'promptschat', 4).pages, 4);
  assert.equal(payloadOf(plan, 'promptschat').pages, undefined);
});

test('too many pages: the preview says what Apply reads and how to narrow the request', async () => {
  const big = { prompts: promptschatPage(1).prompts, total: 2571, page: 1, perPage: 24, totalPages: 108 };
  const doc = await firstDoc('https://prompts.chat/api/prompts', api({ 'https://prompts.chat/api/prompts': { body: big } }).http);
  const p = pagingPreview(doc, { caps: { maxPages: 30, maxRows: 3000 } });
  assert.equal(p.pages_to_read, 30);
  assert.equal(p.pages_total, 108);
  assert.match(p.notes[0], /108 pages \(2571 records\) but Apply reads 30 \(cap IMPORT_MAX_PAGES = 30\).*\?type=IMAGE, \?perPage=100/);
  assert.equal(p.notes.length, 1, '2571 records are under the row cap');
  assert.match(pagingPreview(doc, { caps: { maxPages: 200, maxRows: 1000 } }).notes[0], /2571 records in total: Apply stops once 1000 entries have passed the filter \(IMPORT_MAX_ROWS\)/);
  const asked = pagingPreview(doc, { pages: 5, caps: { maxPages: 30, maxRows: 3000 } });
  assert.equal(asked.pages_to_read, 5);
  assert.match(asked.notes[0], /pages argument/);
  const one = pagingPreview(await firstDoc('https://a.example/o', api({ 'https://a.example/o': { body: { items: [{ id: 1 }] } } }).http), { caps: { maxPages: 30, maxRows: 3000 } });
  assert.deepEqual([one.kind, one.pages_to_read], ['none', 1]);
  const cursor = pagingPreview(await firstDoc('https://a.example/c', api({ 'https://a.example/c': { body: { items: [{ id: 1 }], next_cursor: 'x' } } }).http), { caps: { maxPages: 30, maxRows: 3000 } });
  assert.deepEqual([cursor.pages_total, cursor.pages_to_read], [null, 30]);
  assert.match(cursor.notes[0], /not known/);
});

test('the caps come from settings, falling back to the defaults for nonsense', () => {
  assert.deepEqual(importCaps((k) => ({ IMPORT_MAX_PAGES: '5', IMPORT_MAX_ROWS: '250' } as Record<string, string>)[k]), { maxPages: 5, maxRows: 250 });
  assert.deepEqual(importCaps((k) => ({ IMPORT_MAX_PAGES: '0', IMPORT_MAX_ROWS: 'many' } as Record<string, string>)[k]), { maxPages: 30, maxRows: 3000 });
  assert.deepEqual(importCaps((k) => ({ IMPORT_MAX_PAGES: '9999', IMPORT_MAX_ROWS: '5' } as Record<string, string>)[k]), { maxPages: 30, maxRows: 3000 });
});

// ── the page loop ───────────────────────────────────────────────────────────────────────────────────────────────────────

const CAPS = { maxPages: 30, maxRows: 3000 };
const count = (records: unknown[]): PageMeasure => ({ kept: records.length, refs: records.map((r: any) => r.id) });

test('Apply reads the pages in order and stops at totalPages; the later pages are fetched fresh and never stored', async () => {
  const { hits, http } = api(PC);
  const docs = new DocStore();
  const r: any = await fetchDocument(PROMPTSCHAT_URL, { docs, http });
  const out = await readPages(r.doc, { http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.deepEqual(hits, [promptschatPageUrl(1), promptschatPageUrl(2)], 'one request per page, page 2 not asked for twice');
  assert.equal(out.records.length, 10);
  assert.deepEqual((out.records as any[]).map((x) => x.id).slice(4, 6), ['cmv_vault', 'cmv_maki'], 'in page order');
  assert.deepEqual(out.paging, { pages_read: 2, pages_total: 2, records_total: 10, stopped: 'last_page' });
  assert.equal(docs.size, 1, 'only the first page is in the store');
  assert.equal(docs.getByUrl(promptschatPageUrl(2)), null);
});

test('the pages argument, the page cap and the row cap each stop the run', async () => {
  const one = api(PC);
  const doc = await firstDoc(PROMPTSCHAT_URL, one.http);
  const byArg = await readPages(doc, { http: one.http }, { pages: 1, caps: CAPS, delayMs: 0, measure: count });
  assert.equal(byArg.paging.stopped, 'pages');
  assert.equal(byArg.records.length, 5);
  assert.deepEqual(one.hits, [promptschatPageUrl(1)], 'no second request');
  assert.equal(pagingNote(byArg.paging, { pages: 1, caps: CAPS }), 'прочитано 1 з 2 сторінок (pages = 1)');

  const byCap = await readPages(doc, { http: one.http }, { caps: { maxPages: 1, maxRows: 3000 }, delayMs: 0, measure: count });
  assert.equal(byCap.paging.stopped, 'max_pages');
  assert.equal(pagingNote(byCap.paging, { caps: { maxPages: 1, maxRows: 3000 } }), 'прочитано 1 з 2 сторінок (ліміт IMPORT_MAX_PAGES = 1)');

  const byRows = await readPages(doc, { http: one.http }, { caps: { maxPages: 30, maxRows: 4 }, delayMs: 0, measure: count });
  assert.equal(byRows.paging.stopped, 'max_rows');
  assert.equal(byRows.paging.pages_read, 1);
  assert.match(pagingNote(byRows.paging, { caps: { maxPages: 30, maxRows: 4 } })!, /ліміту 4 записів \(IMPORT_MAX_ROWS\)/);
  assert.equal(pagingNote({ pages_read: 2, pages_total: 2, records_total: 10, stopped: 'last_page' }, { caps: CAPS }), null, 'the end of the list is not worth a note');

  // Kept rows are counted after the filter: a page the filter empties does not use the row budget.
  const filtered = await readPages(doc, { http: one.http }, { caps: { maxPages: 30, maxRows: 4 }, delayMs: 0, measure: (recs) => ({ kept: recs.filter((x: any) => x.type === 'IMAGE').length, refs: [] }) });
  assert.equal(filtered.paging.stopped, 'last_page');
});

test('a failing page stops the run and keeps what was read; the note says where and why', async () => {
  const a = api({ ...PC, [promptschatPageUrl(2)]: { status: 429, body: 'slow down' } });
  const doc = await firstDoc(PROMPTSCHAT_URL, a.http);
  const out = await readPages(doc, { http: a.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.equal(out.records.length, 5);
  assert.equal(out.paging.stopped, 'failed');
  assert.match(out.paging.failure!, /^status 429/);
  assert.equal(pagingNote(out.paging, { caps: CAPS }), 'прочитано 1 з 2 сторінок: status 429');

  const boom = api({ ...PC, [promptschatPageUrl(2)]: () => { throw new Error('socket hang up'); } });
  const o2 = await readPages(await firstDoc(PROMPTSCHAT_URL, boom.http), { http: boom.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.deepEqual([o2.paging.stopped, o2.paging.failure], ['failed', 'socket hang up']);

  const html = api({ ...PC, [promptschatPageUrl(2)]: { type: 'application/json', body: '<html>not json</html>' } });
  const o3 = await readPages(await firstDoc(PROMPTSCHAT_URL, html.http), { http: html.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.match(o3.paging.failure!, /unsupported_content: invalid JSON/);
  assert.equal(failureText({ error: 'http_error', details: 'status 503' }), 'status 503');
});

test('next links and cursors are followed, a repeated address ends the run, an empty page is the end', async () => {
  const link = api({
    'https://a.example/l': { body: { items: [{ id: 1 }], next: '/l?p=2' } },
    'https://a.example/l?p=2': { body: { items: [{ id: 2 }], next: 'https://a.example/l?p=3' } },
    'https://a.example/l?p=3': { body: { items: [{ id: 3 }], next: null } },
  });
  const l = await readPages(await firstDoc('https://a.example/l', link.http), { http: link.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.deepEqual((l.records as any[]).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual([l.paging.stopped, l.paging.pages_total], ['last_page', 3], 'the total is known once the end is reached');

  const cur = api({
    'https://a.example/c?q=1': { body: { items: [{ id: 1 }], next_cursor: 'k2' } },
    'https://a.example/c?q=1&next_cursor=k2': { body: { items: [{ id: 2 }], next_cursor: 'k2' } },
  });
  const c = await readPages(await firstDoc('https://a.example/c?q=1', cur.http), { http: cur.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.equal(c.records.length, 2, 'a cursor that points back at itself is not followed twice');
  assert.equal(c.paging.stopped, 'last_page');

  const empty = api({ 'https://a.example/e': { body: { items: [{ id: 1 }], page: 1, totalPages: 9 } }, 'https://a.example/e?page=2': { body: { items: [], page: 2, totalPages: 9 } } });
  const e = await readPages(await firstDoc('https://a.example/e', empty.http), { http: empty.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.equal(e.records.length, 1);
  assert.equal(e.paging.stopped, 'last_page');
});

test('a source with no pagination is one page', async () => {
  const a = api({ 'https://a.example/o': { body: [{ id: 1 }, { id: 2 }] } });
  const out = await readPages(await firstDoc('https://a.example/o', a.http), { http: a.http }, { caps: CAPS, delayMs: 0, measure: count });
  assert.deepEqual([out.records.length, out.paging.stopped, out.paging.pages_read], [2, 'single', 1]);
  assert.deepEqual(a.hits, ['https://a.example/o']);
});

test('incremental: reading stops after the first page that adds no new ref', async () => {
  const mk = (n: number) => ({ items: Array.from({ length: 3 }, (_, i) => ({ id: `p${n}r${i}` })), page: n, totalPages: 5 });
  const pages: Record<string, Answer> = {};
  for (let n = 1; n <= 5; n++) pages[n === 1 ? 'https://a.example/n' : `https://a.example/n?page=${n}`] = { body: mk(n) };
  const run = async (have: (ref: string) => boolean) => {
    const a = api(pages);
    const out = await readPages(await firstDoc('https://a.example/n', a.http), { http: a.http }, {
      caps: CAPS, delayMs: 0, measure: count, known: async (refs) => new Set(refs.filter(have)),
    });
    return { out, hits: a.hits.length };
  };
  const nothingNew = await run(() => true);
  assert.deepEqual([nothingNew.out.paging.stopped, nothingNew.out.paging.pages_read, nothingNew.hits], ['no_new', 1, 1], 'page 1 unchanged: one request');
  const twoNew = await run((ref) => /^p[3-5]/.test(ref));
  assert.deepEqual([twoNew.out.paging.stopped, twoNew.out.paging.pages_read, twoNew.hits], ['no_new', 3, 3], 'pages 1 and 2 have new refs, page 3 has none');
  const allNew = await run(() => false);
  assert.deepEqual([allNew.out.paging.stopped, allNew.out.paging.pages_read], ['last_page', 5]);
  const noRefs = await readPages(await firstDoc('https://a.example/n', api(pages).http), { http: api(pages).http }, { caps: CAPS, delayMs: 0, measure: (r) => ({ kept: r.length, refs: [] }), known: async () => new Set() });
  assert.equal(noRefs.paging.pages_read, 5, 'a page with no rows says nothing, so reading goes on');
});

test('the pause between pages is taken before every page after the first', async () => {
  const a = api(PC);
  const doc = await firstDoc(PROMPTSCHAT_URL, a.http);
  const t0 = Date.now();
  await readPages(doc, { http: a.http }, { caps: CAPS, delayMs: 60, measure: count });
  assert.ok(Date.now() - t0 >= 55, 'one pause for the one page after the first');
});
