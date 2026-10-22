import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';
import { toToolContent } from '../harness/truncate';
import { buildDocTools } from './doc-tools';
import { DocStore } from './doc-store';
import { buildJsonDoc, detectPagination, fieldsOf, findRecords, isJsonContentType, listBaseUrl, parseJsonBody, recordHeading } from './doc-json';
import { promptschatPage, PROMPTSCHAT_URL } from './testing/promptschat-fixture';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

type Page = { status?: number; type?: string; body: unknown };
function rig(pages: Record<string, Page>) {
  const hits: string[] = [];
  const get = async (url: string) => {
    hits.push(url);
    const p = pages[url];
    if (!p) return { status: 404, headers: { 'content-type': 'text/html' }, data: 'nope' };
    return { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'application/json; charset=utf-8' }, data: p.body };
  };
  const docs = new DocStore();
  const list = [
    ...buildReadTools({ pool: { query: async () => ({ rows: [] }) } as any, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get }, docs }),
    ...buildDocTools({ docs }),
  ];
  return { docs, hits, tools: Object.fromEntries(list.map((t) => [t.name, t])) as Record<string, any> };
}

// ── detection ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('JSON content types: application/json, +json and text/json; HTML and plain text are not', () => {
  for (const t of ['application/json', 'application/json; charset=utf-8', 'text/json', 'application/vnd.api+json', 'application/ld+json;profile=x', 'APPLICATION/JSON']) {
    assert.equal(isJsonContentType(t), true, t);
  }
  for (const t of ['text/html', 'text/plain', 'application/xml', 'application/jsonp-not', '']) assert.equal(isJsonContentType(t), false, t);
});

test('a JSON body is an object or an array; a scalar, broken JSON and prose are not', () => {
  assert.deepEqual(parseJsonBody(' {"a": 1} '), { a: 1 });
  assert.deepEqual(parseJsonBody('﻿[1, 2]'), [1, 2]);
  for (const b of ['', '42', '"x"', 'null', '{"a":', 'Hello {world}', '[a link](https://x)']) assert.equal(parseJsonBody(b), null, b);
});

test('web_fetch reads JSON by type, and a plain or untyped body that parses; an invalid JSON body is refused', async () => {
  const body = JSON.stringify({ items: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] });
  const { tools } = rig({
    'https://a.example/typed': { type: 'application/json', body },
    'https://a.example/plain': { type: 'text/plain', body },
    'https://a.example/untyped': { type: '', body },
    'https://a.example/bad': { type: 'application/json', body: '{"items": [' },
    'https://a.example/prose': { type: 'text/plain', body: '[not json] just text' },
    'https://a.example/readme.md': { type: 'text/plain', body: '[link](https://x.example)\n\n# Title\ntext' },
  });
  for (const u of ['typed', 'plain', 'untyped']) {
    const r = await tools.web_fetch.execute({ url: `https://a.example/${u}` }, ctx);
    assert.equal(r.json.records, 2, u);
    assert.equal(r.json.records_path, 'items', u);
    assert.ok(r.doc_id, u);
  }
  assert.deepEqual(await tools.web_fetch.execute({ url: 'https://a.example/bad' }, ctx), { error: 'unsupported_content', details: 'invalid JSON' });
  const prose = await tools.web_fetch.execute({ url: 'https://a.example/prose' }, ctx);
  assert.equal(prose.text, '[not json] just text', 'plain text that is not JSON stays text');
  const md = await tools.web_fetch.execute({ url: 'https://a.example/readme.md' }, ctx);
  assert.equal(md.title, 'Title', 'a markdown file that starts with a link is still markdown');
});

// ── records ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the records array: the root, the largest array of objects at a root key, or one level below it', () => {
  assert.equal(findRecords([{ a: 1 }, { a: 2 }])?.path, '');
  assert.equal(findRecords({ total: 3, prompts: [{ a: 1 }, { a: 2 }], tags: [{ t: 1 }] })?.path, 'prompts', 'the largest wins');
  assert.equal(findRecords({ meta: { n: 1 }, data: { items: [{ a: 1 }, { a: 2 }, { a: 3 }] }, other: [{ b: 1 }] })?.path, 'data.items');
  assert.equal(findRecords({ ids: [1, 2, 3], rows: [] }), null, 'scalars and empty arrays are not records');
  assert.equal(findRecords({ mixed: [{ a: 1 }, 2] }), null, 'every element must be an object');
  assert.equal(findRecords([1, 2]), null);
  assert.equal(findRecords({ a: { b: { c: [{ x: 1 }] } } }), null, 'deeper than one level below the root is not looked at');
});

test('a record is labelled by title, name, slug or id, else its position', () => {
  assert.equal(recordHeading({ title: ' T ', name: 'N' }, 1), 'T');
  assert.equal(recordHeading({ title: '', name: 'N' }, 1), 'N');
  assert.equal(recordHeading({ slug: 's', id: 7 }, 1), 's');
  assert.equal(recordHeading({ id: 7 }, 1), '7');
  assert.equal(recordHeading({ x: 1 }, 4), '#4');
});

test('every record is a section of pretty-printed text; the root keys that are not records are the intro', () => {
  const j = buildJsonDoc(promptschatPage(1));
  assert.equal(j.sections.length, 6);
  assert.deepEqual([j.sections[0].heading, j.sections[0].level], ['', 0]);
  assert.deepEqual(j.sections.slice(1).map((s) => s.heading), ['Sarcasm', 'Web Accessibility taste', 'Room Paint Quantity Estimator', 'Photoreal Atlantic Puffin Colony on a Sea Cliff at Golden Hour', 'Prompt Vault Manager']);
  assert.equal(j.sections[0].start, 0);
  j.sections.forEach((s, i) => { if (i) assert.equal(s.start, j.sections[i - 1].end, 'the sections tile the text'); });
  assert.equal(j.sections.at(-1)!.end, j.text.length);
  assert.deepEqual(JSON.parse(j.text.slice(j.sections[0].start, j.sections[0].end)), { total: 10, page: 1, perPage: 5, totalPages: 2 });
  assert.equal(JSON.parse(j.text.slice(j.sections[1].start, j.sections[1].end)).title, 'Sarcasm');
  assert.match(j.text, /\n {2}"title": "Sarcasm"/, 'pretty-printed at 2 spaces');
  assert.equal(j.json.records.length, 5);
  assert.equal(j.json.records_path, 'prompts');

  const bare = buildJsonDoc([{ id: 1 }, { id: 2 }]);
  assert.deepEqual(bare.sections.map((s) => s.level), [1, 1], 'a root array has no intro');
  const nested = buildJsonDoc({ meta: { page: 1 }, data: { items: [{ id: 1 }], note: 'x' } });
  assert.deepEqual(JSON.parse(nested.text.slice(0, nested.sections[0].end)), { meta: { page: 1 }, data: { note: 'x' } }, 'the intro keeps the rest of the root, records removed');
  const none = buildJsonDoc({ a: 1 });
  assert.deepEqual([none.sections.length, none.json.records_path], [1, null]);
});

test('read_doc gives one record and find_in_doc finds records in it', async () => {
  const { tools } = rig({ [PROMPTSCHAT_URL]: { body: promptschatPage(1) } });
  const r = await tools.web_fetch.execute({ url: PROMPTSCHAT_URL }, ctx);
  const puffin = r.outline.find((o: any) => o.heading.startsWith('Photoreal'));
  const sec = await tools.read_doc.execute({ doc_id: r.doc_id, section: puffin.id }, ctx);
  assert.equal(sec.next_from, null);
  const rec = JSON.parse(sec.text);
  assert.equal(rec.type, 'IMAGE');
  assert.equal(rec.author.username, 'f');
  const byTitle = await tools.read_doc.execute({ doc_id: r.doc_id, section: 'Sarcasm' }, ctx);
  assert.match(byTitle.text, /Respond with sarcasm/);
  const found = await tools.find_in_doc.execute({ doc_id: r.doc_id, query: 'Budgeting' }, ctx);
  assert.equal(found.matches[0].heading, 'Room Paint Quantity Estimator');
  assert.equal(found.matches[0].section, 's4');
});

// ── shape ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the shape lists paths with type, share filled and a sample; objects one level down, arrays of objects as tags[].x', () => {
  const { fields } = fieldsOf((promptschatPage(1).prompts as unknown[]));
  const by = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.deepEqual([by.title.type, by.title.filled, by.title.sample], ['string', 1, 'Sarcasm']);
  assert.equal(by.mediaUrl.filled, 0.2, 'one record of five has a picture');
  assert.match(by.mediaUrl.sample!, /puffins\.jpg/);
  assert.equal(by['author.name'].filled, 0.8, 'one author has no name');
  assert.equal(by['author.username'].filled, 1);
  assert.equal(by['category.slug'].filled, 1);
  assert.equal(by['tags[].tag.name'].filled, 0.8, 'four of five records have tags');
  assert.equal(by['tags[].tag.name'].sample, 'Accessibility');
  assert.equal(by['_count.votes'].type, 'number');
  assert.ok(!('category.parentId' in by && by['category.parentId'].filled > 0), 'null values are not filled');
  assert.equal(by.content.sample!.includes('\n'), false, 'a sample is one line');
  assert.ok(fields.every((f) => !f.sample || f.sample.length <= 80));
});

test('a record shape is capped at 40 fields, filled ones first', () => {
  const rec: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) rec[`empty${i}`] = null;
  for (let i = 0; i < 30; i++) rec[`full${i}`] = i;
  const { fields, more } = fieldsOf([rec]);
  assert.equal(fields.length, 40);
  assert.equal(more, 20);
  assert.ok(fields.slice(0, 30).every((f) => f.path.startsWith('full')));
});

test('under the cap, foreign keys and counters give way to the fields worth mapping', () => {
  const rec: Record<string, unknown> = { title: 'T', authorId: 'a', _count: { votes: 1 }, tags: [{ promptId: 'p', tag: { name: 'N' } }] };
  for (let i = 0; i < 38; i++) rec[`f${i}`] = i;
  const { fields } = fieldsOf([rec]);
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes('tags[].tag.name'));
  assert.ok(!paths.includes('tags[].promptId') && !paths.includes('_count.votes'), 'the minor ones are cut first');
  assert.equal(paths.includes('authorId'), false);
});

test('web_fetch of the prompts.chat shape: records_path, root scalars, fields, pagination, first record, a hint; within the result cap', async () => {
  const { tools } = rig({ [PROMPTSCHAT_URL]: { body: promptschatPage(1) } });
  const r = await tools.web_fetch.execute({ url: PROMPTSCHAT_URL }, ctx);
  assert.equal(r.url, PROMPTSCHAT_URL);
  assert.match(r.doc_id, /^doc_/);
  assert.equal(r.json.records_path, 'prompts');
  assert.equal(r.json.records, 5);
  assert.deepEqual(r.json.root, { total: 10, page: 1, perPage: 5, totalPages: 2 });
  assert.ok(r.json.fields.length >= 15 && r.json.fields.length <= 40);
  assert.equal(r.json.pagination.kind, 'page');
  assert.equal(r.json.pagination.pages_total, 2);
  assert.equal(r.json.pagination.next_url, 'https://prompts.chat/api/prompts?perPage=5&page=2');
  assert.equal(JSON.parse(r.first_record).title, 'Sarcasm');
  assert.match(r.hint, /read_doc\(doc_id, section\)/);
  assert.match(r.hint, /import_list\(doc_id, …\) з field:<шлях>/);
  assert.equal(r.outline.length, 5);
  assert.ok(toToolContent(r, 14_000).length <= 14_000);
  const again = await tools.web_fetch.execute({ url: PROMPTSCHAT_URL }, ctx);
  assert.equal(again.cached, true);
  assert.equal(again.doc_id, r.doc_id);
});

test('a full page of 100 big records still fits the answer cap, and the outline is cut', async () => {
  const records = Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, title: `Prompt number ${i}`.padEnd(70, 'x'), content: 'c'.repeat(5000), author: { name: 'N', username: 'u' }, tags: [{ tag: { name: 'T' } }] }));
  const { tools } = rig({ 'https://a.example/api': { body: { prompts: records, total: 2571, page: 1, perPage: 100, totalPages: 26 } } });
  const r = await tools.web_fetch.execute({ url: 'https://a.example/api' }, ctx);
  assert.equal(r.json.records, 100);
  assert.equal(r.outline.length, 20);
  assert.equal(r.outline_more, 80);
  assert.ok(r.first_record.length <= 3_001);
  assert.ok(toToolContent(r, 14_000).length <= 14_000);
});

test('a small JSON with no records array is answered whole; a big one goes through the outline', async () => {
  const { tools } = rig({
    'https://a.example/small': { body: { name: 'x', n: 3, nested: { a: [1, 2] } } },
    'https://a.example/big': { body: { rows: ['x'.repeat(100)], blob: 'y'.repeat(7000) } },
  });
  const s = await tools.web_fetch.execute({ url: 'https://a.example/small' }, ctx);
  assert.deepEqual(s.json, { name: 'x', n: 3, nested: { a: [1, 2] } });
  assert.match(s.doc_id, /^doc_/);
  const b = await tools.web_fetch.execute({ url: 'https://a.example/big' }, ctx);
  assert.ok(b.doc_id && b.outline && b.next_from, 'the large-document shape');
  assert.equal(b.json, undefined);
  const more = await tools.read_doc.execute({ doc_id: b.doc_id, from: b.next_from }, ctx);
  assert.ok(more.text.length > 0);
});

// ── pagination ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const U = 'https://api.example/items?type=A&perPage=24';

test('detectPagination: a page number with totalPages, or with total and a page size', () => {
  const a = detectPagination({ page: 1, totalPages: 108, total: 2571, perPage: 24 }, U)!;
  assert.deepEqual([a.kind, a.param, a.page, a.pages_total, a.records_total, a.per_page], ['page', 'page', 1, 108, 2571, 24]);
  assert.equal(a.next_url, 'https://api.example/items?type=A&perPage=24&page=2');
  const b = detectPagination({ page: 2, total: 50, per_page: 20 }, U)!;
  assert.equal(b.pages_total, 3, 'ceil(total / per page)');
  assert.equal(b.next_url, 'https://api.example/items?type=A&perPage=24&page=3');
  assert.equal(detectPagination({ currentPage: 3, last_page: 3 }, 'https://x.example/l')!.next_url, null, 'the last page has no next');
  assert.equal(detectPagination({ page: 1, pages: 2 }, 'https://x.example/l')!.next_url, 'https://x.example/l?page=2');
  assert.equal(detectPagination({ page: 1, total: 9, limit: 3 }, 'https://x.example/l')!.pages_total, 3);
  assert.equal(detectPagination({ page: '2', totalPages: '4' }, 'https://x.example/l')!.next_url, 'https://x.example/l?page=3', 'numbers in strings');
});

test('the page parameter keeps the URL\'s own name and replaces the number, other parameters stay', () => {
  const p = detectPagination({ currentPage: 2, totalPages: 5 }, 'https://x.example/l?currentPage=2&q=a%20b')!;
  assert.equal(p.param, 'currentPage');
  assert.equal(p.next_url, 'https://x.example/l?currentPage=3&q=a+b');
  assert.equal(detectPagination({ page_number: 1, totalPages: 2 }, 'https://x.example/l?page_number=1')!.param, 'page_number');
  assert.equal(detectPagination({ page_number: 1, totalPages: 2 }, 'https://x.example/l')!.param, 'page', 'no parameter in the URL: page');
});

test('detectPagination: a next link (absolute, relative, links.next), a cursor, none', () => {
  assert.equal(detectPagination({ next: 'https://x.example/l?p=2' }, 'https://x.example/l')!.next_url, 'https://x.example/l?p=2');
  assert.equal(detectPagination({ next_url: '/l?p=2' }, 'https://x.example/api/l')!.next_url, 'https://x.example/l?p=2', 'relative links are resolved');
  assert.equal(detectPagination({ links: { next: 'https://x.example/l?p=2' } }, 'https://x.example/l')!.kind, 'link');
  assert.equal(detectPagination({ nextPage: 'l?p=2' }, 'https://x.example/api/')!.next_url, 'https://x.example/api/l?p=2');
  assert.equal(detectPagination({ next: null }, 'https://x.example/l')!.next_url, null, 'a null link is the last page');
  const c = detectPagination({ next_cursor: 'abc123' }, 'https://x.example/l?q=1')!;
  assert.deepEqual([c.kind, c.param, c.next_url], ['cursor', 'next_cursor', 'https://x.example/l?q=1&next_cursor=abc123']);
  assert.equal(detectPagination({ nextCursor: '' }, 'https://x.example/l')!.next_url, null);
  assert.equal(detectPagination({ items: [], total: 4 }, 'https://x.example/l'), null);
  assert.equal(detectPagination([{ a: 1 }], 'https://x.example/l'), null, 'a root array has no keys to read');
  assert.equal(detectPagination({ page: 1 }, 'https://x.example/l'), null, 'a page number alone does not say how many pages');
});

test('the address of a list loses its paging parameters and keeps the rest', () => {
  assert.equal(listBaseUrl('https://prompts.chat/api/prompts?perPage=100&page=3&type=IMAGE'), 'https://prompts.chat/api/prompts?type=IMAGE');
  assert.equal(listBaseUrl('https://x.example/l?cursor=abc&Page=2&q=a'), 'https://x.example/l?q=a');
  assert.equal(listBaseUrl('https://x.example/l?tok=abc', 'tok'), 'https://x.example/l');
});
