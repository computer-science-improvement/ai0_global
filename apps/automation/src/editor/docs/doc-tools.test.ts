import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';
import { toToolContent } from '../harness/truncate';
import { buildDocTools } from './doc-tools';
import { DocStore, docIdOf, type NewDoc } from './doc-store';
import { findIn, outlineOf, pageOf } from './doc-view';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function rig(pages: Record<string, { type?: string; body: string }>, docs = new DocStore()) {
  const hits: string[] = [];
  const get = async (url: string) => {
    hits.push(url);
    const p = pages[url];
    if (!p) return { status: 404, headers: { 'content-type': 'text/html' }, data: 'nope' };
    return { status: 200, headers: { 'content-type': p.type ?? 'text/html' }, data: p.body };
  };
  const pool = { query: async () => ({ rows: [] }) } as any;
  const list = [
    ...buildReadTools({ pool, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get }, docs }),
    ...buildDocTools({ docs }),
  ];
  return { docs, hits, tools: Object.fromEntries(list.map((t) => [t.name, t])) as Record<string, any> };
}

const longArticle = (sections: number) => `<html><head><title>Big page</title><meta name="description" content="About"></head><body><article>
  <p>Intro paragraph that opens the page.</p>
  ${Array.from({ length: sections }, (_, i) => `<h2>Part ${i + 1}</h2><img src="https://img.example/p${i + 1}.jpg"><p>${`Sentence of part ${i + 1}. `.repeat(60)}</p>`).join('\n')}
</article></body></html>`;

test('a short page keeps the shape it always had and gets no doc_id', async () => {
  const { tools } = rig({ 'https://a.example/s': { body: '<title>T</title><p>Body text</p>' } });
  const r = await tools.web_fetch.execute({ url: 'https://a.example/s' }, ctx);
  assert.equal(r.title, 'T');
  assert.match(r.text, /Body text/);
  assert.deepEqual(Object.keys(r), ['url', 'title', 'description', 'image', 'images', 'text', 'published_at']);
  assert.equal(r.doc_id, undefined);
  assert.equal(r.outline, undefined);
});

test('a large page comes as doc_id, outline with counts and a first chunk; the rest is read through read_doc', async () => {
  const url = 'https://a.example/big';
  const { tools, hits } = rig({ [url]: { body: longArticle(12) } });
  const r = await tools.web_fetch.execute({ url }, ctx);
  assert.equal(r.doc_id, docIdOf(url));
  assert.ok(r.size_chars > 6000);
  assert.equal(r.title, 'Big page');
  assert.equal(r.description, 'About');
  assert.ok(r.images.length > 1, 'an HTML page still lists its images');
  assert.ok(r.text.length <= 3000 && r.text.length > 1500, `first chunk ${r.text.length}`);
  assert.match(r.hint, /read_doc\(doc_id, section\|from\).*find_in_doc/);
  assert.equal(r.outline[0].heading, '(intro)');
  assert.deepEqual(r.outline[2], { id: 's3', heading: 'Part 2', level: 2, chars: r.outline[2].chars, code_blocks: 0, images: 1 });
  assert.equal(r.next_from, r.text.length);
  assert.ok(toToolContent(r, 14_000).length <= 14_000);

  const sec = await tools.read_doc.execute({ doc_id: r.doc_id, section: 's3', max_chars: 6000 }, ctx);
  assert.equal(sec.section.heading, 'Part 2');
  assert.match(sec.text, /^Part 2\nSentence of part 2\./);
  assert.deepEqual(sec.images, [{ src: 'https://img.example/p2.jpg', alt: '' }], 'the image of that section only');
  assert.equal(sec.next_from, null);
  const byHeading = await tools.read_doc.execute({ doc_id: r.doc_id, section: 'part 5' }, ctx);
  assert.equal(byHeading.section.id, 's6');
  assert.equal((await tools.read_doc.execute({ doc_id: r.doc_id, section: 'nope' }, ctx)).error, 'unknown_section');

  // The same address again is served from the store, without a request.
  assert.equal(hits.length, 1);
  const again = await tools.web_fetch.execute({ url }, ctx);
  assert.equal(again.cached, true);
  assert.equal(hits.length, 1);
  assert.equal(again.doc_id, r.doc_id);
});

test('read_doc pages through a range with next_from and finishes at null', async () => {
  const url = 'https://a.example/big';
  const { tools } = rig({ [url]: { body: longArticle(12) } });
  const r = await tools.web_fetch.execute({ url }, ctx);
  let from: number | null = r.next_from;
  let got = r.text.length;
  let pages = 0;
  while (from !== null && pages < 50) {
    const p: any = await tools.read_doc.execute({ doc_id: r.doc_id, from, max_chars: 2000 }, ctx);
    assert.equal(p.from, from);
    assert.ok(p.text.length <= 2000);
    got += p.text.length;
    from = p.next_from;
    pages++;
  }
  assert.equal(got, r.size_chars, 'every character was read exactly once');
});

test('spec 070: a doc_id keeps working after the lifetime of the fetch cache (the kept copy is stale, not gone)', async () => {
  const url = 'https://a.example/big';
  let now = 0;
  const { tools, hits } = rig({ [url]: { body: longArticle(12) } }, new DocStore({ ttlHours: 6, now: () => now }));
  const r = await tools.web_fetch.execute({ url }, ctx);
  now += 7 * 3_600_000;
  const page = await tools.read_doc.execute({ doc_id: r.doc_id, section: 's3' }, ctx);
  assert.equal(page.error, undefined);
  assert.match(page.text, /Sentence of part 2/);
  const found = await tools.find_in_doc.execute({ doc_id: r.doc_id, query: 'sentence of part 5' }, ctx);
  assert.ok(found.total >= 1);
  assert.equal(hits.length, 1, 'no refetch for reading');
  const again = await tools.web_fetch.execute({ url }, ctx);
  assert.equal(again.cached, undefined, 'a web_fetch past the lifetime fetches again');
  assert.equal(hits.length, 2);
});

test('an unknown, evicted or too old doc_id says what to fetch again', async () => {
  const url = 'https://a.example/big';
  let now = 0;
  const { tools } = rig({ [url]: { body: longArticle(12) }, 'https://a.example/other': { body: longArticle(2) } }, new DocStore({ ttlHours: 6, max: 1, now: () => now }));
  const r = await tools.web_fetch.execute({ url }, ctx);
  await tools.web_fetch.execute({ url: 'https://a.example/other' }, ctx);   // the least recently used goes
  const evicted = await tools.read_doc.execute({ doc_id: r.doc_id }, ctx);
  assert.equal(evicted.error, 'doc_expired');
  assert.equal(evicted.url, url);
  assert.match(evicted.details, /web_fetch\(https:\/\/a\.example\/big\)/);
  assert.equal((await tools.find_in_doc.execute({ doc_id: 'doc_nope', query: 'x1' }, ctx)).error, 'doc_expired');

  const old = await tools.web_fetch.execute({ url }, ctx);
  now += 169 * 3_600_000;
  const gone = await tools.read_doc.execute({ doc_id: old.doc_id }, ctx);
  assert.equal(gone.error, 'doc_expired', 'older than DOC_STALE_MAX_HOURS (168)');
  assert.equal(gone.url, url);
});

test('find_in_doc finds a phrase case-insensitively, else words that sit together; it names the section', async () => {
  const url = 'https://a.example/big';
  const { tools } = rig({ [url]: { body: longArticle(12) } });
  const r = await tools.web_fetch.execute({ url }, ctx);
  const f = await tools.find_in_doc.execute({ doc_id: r.doc_id, query: 'SENTENCE OF PART 7', limit: 2 }, ctx);
  assert.ok(f.total >= 1);
  assert.equal(f.matches[0].heading, 'Part 7');
  assert.equal(f.matches[0].section, 's8');
  assert.ok(f.matches[0].snippet.length <= 700);
  const words = await tools.find_in_doc.execute({ doc_id: r.doc_id, query: 'part 3 sentence' }, ctx);
  assert.ok(words.matches.length >= 1, 'the words occur together though not as a phrase');
  const none = await tools.find_in_doc.execute({ doc_id: r.doc_id, query: 'zebra' }, ctx);
  assert.equal(none.total, 0);
  assert.deepEqual(none.matches, []);
});

// ── never cutting a code block (pageOf on a hand-built document) ─────────────────────────────────────────────────────

function withBlock(before: number, block: number, after: number) {
  const store = new DocStore();
  const pre = 'a '.repeat(before / 2);
  const code = '```text\n' + 'c'.repeat(block) + '\n```';
  const post = '\n' + 'z '.repeat(after / 2);
  const text = pre + code + post;
  const input: NewDoc = {
    url: 'https://a.example/code', fetched_url: null, final_url: 'https://a.example/code', kind: 'markdown', title: null, description: null,
    image: null, images: [], published_at: null, text,
    sections: [{ heading: 'S', level: 2, start: 0, end: text.length, images: [], links: [], code_blocks: [{ lang: 'text', text: 'c'.repeat(block), start: pre.length, end: pre.length + code.length }] }],
  };
  return { doc: store.put(input), blockStart: pre.length, blockEnd: pre.length + code.length };
}

test('pageOf stops before a code block that would be cut, and the next page starts on it', () => {
  const { doc, blockStart, blockEnd } = withBlock(4000, 3000, 500);
  const p1 = pageOf(doc, 0, doc.text.length, 6000);
  assert.equal(p1.to, blockStart, 'the first page ends where the block begins');
  const p2 = pageOf(doc, p1.next_from!, doc.text.length, 6000);
  assert.ok(p2.text.startsWith('```text'));
  assert.ok(p2.to >= blockEnd, 'the block is whole on the next page');
});

test('pageOf takes a code block whole when little text precedes it, even past max_chars', () => {
  const { doc, blockEnd } = withBlock(300, 7000, 500);
  const p = pageOf(doc, 0, doc.text.length, 6000);
  assert.equal(p.to, blockEnd);
  assert.ok(p.text.endsWith('```'));
  assert.equal(p.split_block, undefined);
});

test('a code block longer than the whole-block limit is split at a line and flagged', () => {
  const store = new DocStore();
  const line = 'x'.repeat(99) + '\n';
  const body = line.repeat(150);                          // 15 000 chars
  const text = '```text\n' + body + '```';
  const doc = store.put({
    url: 'https://a.example/huge', fetched_url: null, final_url: 'https://a.example/huge', kind: 'markdown', title: null, description: null,
    image: null, images: [], published_at: null, text,
    sections: [{ heading: 'S', level: 2, start: 0, end: text.length, images: [], links: [], code_blocks: [{ lang: 'text', text: body, start: 0, end: text.length }] }],
  });
  const p = pageOf(doc, 0, text.length, 6000);
  assert.equal(p.split_block, true);
  assert.ok(p.text.endsWith('\n'), 'cut at a line');
  assert.ok(p.text.length <= 6000);
  assert.ok(p.next_from !== null && p.next_from > 0);
});

test('outlineOf lists at most 80 sections and says how many more there are; findIn limits and counts', () => {
  const store = new DocStore();
  const text = Array.from({ length: 100 }, (_, i) => `## Item ${i}\nfoo bar ${i}\n`).join('');
  let pos = 0;
  const sections = Array.from({ length: 100 }, (_, i) => {
    const len = `## Item ${i}\nfoo bar ${i}\n`.length;
    const s = { heading: `Item ${i}`, level: 2, start: pos, end: pos + len, images: [], links: [], code_blocks: [] };
    pos += len;
    return s;
  });
  const doc = store.put({ url: 'https://a.example/list', fetched_url: null, final_url: 'https://a.example/list', kind: 'markdown', title: null, description: null, image: null, images: [], published_at: null, text, sections });
  const o = outlineOf(doc);
  assert.equal(o.outline.length, 80);
  assert.equal(o.more, 20);
  const f = findIn(doc, 'foo bar', 3);
  assert.equal(f.matches.length, 3);
  assert.ok(f.total >= 3);
});
