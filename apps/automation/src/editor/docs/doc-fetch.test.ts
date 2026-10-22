import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { SkillLibrary } from '../skills/skill-library';
import type { ToolContext } from '../harness/tool';
import { toToolContent } from '../harness/truncate';
import { extractPageFull } from '../net/extract-page';
import { buildDocTools } from './doc-tools';
import { DocStore } from './doc-store';
import { NANOBANANA_README, NANOBANANA_RAW_URL, NANOBANANA_URL } from './testing/nanobanana-fixture';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

type Page = { status?: number; type?: string; body: string };
function rig(pages: Record<string, Page>) {
  const hits: string[] = [];
  const get = async (url: string) => {
    hits.push(url);
    const p = pages[url];
    if (!p) return { status: 404, headers: { 'content-type': 'text/html' }, data: 'nope' };
    return { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html' }, data: p.body };
  };
  const docs = new DocStore();
  const list = [
    ...buildReadTools({ pool: { query: async () => ({ rows: [] }) } as any, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get }, docs }),
    ...buildDocTools({ docs }),
  ];
  return { docs, hits, tools: Object.fromEntries(list.map((t) => [t.name, t])) as Record<string, any> };
}

const readme: Page = { type: 'text/plain; charset=utf-8', body: NANOBANANA_README };

test('a GitHub repository page is fetched as its raw README and read as markdown', async () => {
  const { tools, hits } = rig({ [NANOBANANA_RAW_URL]: readme });
  const r = await tools.web_fetch.execute({ url: NANOBANANA_URL }, ctx);
  assert.deepEqual(hits, [NANOBANANA_RAW_URL]);
  assert.equal(r.url, NANOBANANA_URL, 'the address asked for stays as url');
  assert.equal(r.fetched_url, NANOBANANA_RAW_URL);
  assert.equal(r.title, 'Awesome Nano Banana Pro 🍌');
  assert.ok(r.doc_id && r.size_chars > 3000);
  assert.ok(r.outline.length > 10 && r.outline.every((o: any) => o.heading));
  const crowd = r.outline.find((o: any) => o.heading.startsWith('1.1.'));
  assert.deepEqual([crowd.level, crowd.code_blocks, crowd.images], [3, 1, 1]);
  assert.equal(r.image, 'https://github.com/user-attachments/assets/39087148-9caa-4b37-8563-2da68df19713', 'the first picture that is not a badge');
  assert.equal(r.images, undefined, 'a markdown file\'s pictures are per section');
  assert.ok(toToolContent(r, 14_000).length <= 14_000);
});

test('main is tried first, then master; a missing README falls back to the page itself', async () => {
  const master = 'https://raw.githubusercontent.com/o/r/master/README.md';
  const a = rig({ [master]: readme });
  const r = await a.tools.web_fetch.execute({ url: 'https://github.com/o/r' }, ctx);
  assert.deepEqual(a.hits, ['https://raw.githubusercontent.com/o/r/main/README.md', master]);
  assert.equal(r.fetched_url, master);

  const b = rig({ 'https://github.com/o/r': { body: '<title>o/r</title><p>A repo page</p>' } });
  const page = await b.tools.web_fetch.execute({ url: 'https://github.com/o/r' }, ctx);
  assert.deepEqual(b.hits, ['https://raw.githubusercontent.com/o/r/main/README.md', 'https://raw.githubusercontent.com/o/r/master/README.md', 'https://github.com/o/r']);
  assert.equal(page.title, 'o/r');
  assert.equal(page.fetched_url, undefined);
});

test('a GitHub blob page is that file raw; any other error is not retried on another branch', async () => {
  const file = 'https://raw.githubusercontent.com/o/r/main/lists/a.md';
  const a = rig({ [file]: readme });
  const r = await a.tools.web_fetch.execute({ url: 'https://github.com/o/r/blob/main/lists/a.md' }, ctx);
  assert.deepEqual(a.hits, [file]);
  assert.equal(r.fetched_url, file);

  const b = rig({ 'https://raw.githubusercontent.com/o/r/main/README.md': { status: 500, body: 'oops' } });
  const err = await b.tools.web_fetch.execute({ url: 'https://github.com/o/r' }, ctx);
  assert.equal(err.error, 'http_error');
  assert.deepEqual(b.hits, ['https://raw.githubusercontent.com/o/r/main/README.md']);
});

test('read_doc gives an entry whole: its prompt with newlines, its picture, its source link', async () => {
  const { tools } = rig({ [NANOBANANA_RAW_URL]: readme });
  const r = await tools.web_fetch.execute({ url: NANOBANANA_URL }, ctx);
  const entry = r.outline.find((o: any) => o.heading.startsWith('1.2.'));
  const sec = await tools.read_doc.execute({ doc_id: r.doc_id, section: entry.id }, ctx);
  assert.equal(sec.section.heading, '1.2. 2000s Mirror Selfie');
  assert.equal(sec.next_from, null);
  assert.match(sec.text, /```json\nCreate a 2000s Mirror Selfie of yourself using Gemini Nano Banana\.\n\n\{\n {2}"subject"/);
  assert.match(sec.text, /\n```\n\*Source: \[@kimmonismus\]/);
  assert.deepEqual(sec.images, [{ src: 'https://github.com/user-attachments/assets/b71755dc-ff33-4872-8161-3f5066e0ccb6', alt: 'Image' }]);
  const found = await tools.find_in_doc.execute({ doc_id: r.doc_id, query: 'chalkboard' }, ctx);
  assert.equal(found.matches[0].heading, '1.3. Chalkboard Notes (no picture yet)');
});

test('a raw .md address and a markdown content type are markdown; plain text is one section', async () => {
  const md = 'https://x.example/notes.md';
  const a = rig({ [md]: { type: 'text/plain', body: '# One\ntext\n\n## Two\nmore' }, 'https://x.example/api': { type: 'text/markdown', body: '# A\nx\n## B\ny' }, 'https://x.example/log.txt': { type: 'text/plain', body: 'line 1\nline 2\n' } });
  const r = await a.tools.web_fetch.execute({ url: md }, ctx);
  assert.equal(r.doc_id !== undefined, true, 'several sections → read through an outline even when short');
  assert.deepEqual(r.outline.map((o: any) => o.heading), ['One', 'Two']);
  assert.equal((await a.tools.web_fetch.execute({ url: 'https://x.example/api' }, ctx)).outline.length, 2);
  const txt = await a.tools.web_fetch.execute({ url: 'https://x.example/log.txt' }, ctx);
  assert.equal(txt.text, 'line 1\nline 2\n', 'newlines kept');
  assert.equal(txt.doc_id, undefined);
});

test('a short markdown file with one section keeps the short shape', async () => {
  const { tools } = rig({ 'https://x.example/small.md': { type: 'text/plain', body: '# Only\nJust a note.\n' } });
  const r = await tools.web_fetch.execute({ url: 'https://x.example/small.md' }, ctx);
  assert.equal(r.doc_id, undefined);
  assert.equal(r.title, 'Only');
  assert.match(r.text, /Just a note/);
});

// ── HTML sections ───────────────────────────────────────────────────────────────────────────────────────────────────

test('HTML images carry the section they sit in; a page with no headings is one section', () => {
  const html = `<body><article><p>Lead text.</p><img src="https://i.example/lead.jpg">
    <h2>First</h2><p>Alpha.</p><img src="https://i.example/a.jpg"><img src="/logo.png" class="logo">
    <h2>Second</h2><p>Beta.</p><h3>Deep</h3><img src="https://i.example/d.jpg" alt="deep one"><p>Gamma.</p></article></body>`;
  const x = extractPageFull(html, 'https://news.example/p');
  assert.deepEqual(x.sections.map((s) => [s.heading, s.level, s.images.map((i) => i.src)]), [
    ['', 1, ['https://i.example/lead.jpg']],
    ['First', 2, ['https://i.example/a.jpg']],
    ['Second', 2, []],
    ['Deep', 3, ['https://i.example/d.jpg']],
  ]);
  assert.equal(x.sections[3].images[0].alt, 'deep one');
  assert.equal(x.fullText, 'Lead text.\nFirst\nAlpha.\nSecond\nBeta.\nDeep\nGamma.');
  for (const s of x.sections) assert.ok(x.fullText.slice(s.start, s.end).length > 0);
  assert.equal(x.fullText.slice(x.sections[1].start, x.sections[1].end), 'First\nAlpha.\n');
  assert.equal(x.page.text, x.fullText, 'extractPage is unchanged for a short page');

  const flat = extractPageFull('<head><title>T</title></head><body><p>Just text here.</p><img src="https://i.example/z.jpg"></body>', 'https://n.example/');
  assert.equal(flat.sections.length, 1);
  assert.deepEqual(flat.sections[0].images.map((i) => i.src), ['https://i.example/z.jpg']);
});
