/** Spec 067 FR-001 (T1): the critic and lint read what the author read — the reader regression, over the real doc tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTools } from '../tools/read-tools';
import { buildDocTools } from '../docs/doc-tools';
import { SkillLibrary } from '../skills/skill-library';
import { DocStore } from '../docs/doc-store';
import type { ToolContext } from '../harness/tool';
import { groundNumbers } from '../post/grounding';
import { CriticGate, type CriticGateDeps } from './critic-gate';
import { criticUserPrompt, type CriticRequest } from './critic.service';
import { criticPassageLines } from './critic-passages';
import { libraryRowText, LIBRARY_ROW_CAP } from './critic-source';
import { FULL_PAGE_MAX, lowerCoverage, mergeSpans } from './read-capture';

const ctx: ToolContext = { runId: 'r', role: 'executor', channelKey: '@chan' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** The real web_fetch / read_doc / find_in_doc over a fake http, wrapped by a gate whose critic is a recorder. */
function rig(pages: Record<string, string>, o: { docs?: DocStore; gateDocs?: CriticGateDeps['docs']; libraryText?: CriticGateDeps['libraryText'] } = {}) {
  const docs = o.docs ?? new DocStore();
  const get = async (url: string) => {
    const body = pages[url];
    if (body === undefined) return { status: 404, headers: { 'content-type': 'text/html' }, data: 'nope' };
    return { status: 200, headers: { 'content-type': 'text/plain' }, data: body };
  };
  const pool = { query: async () => ({ rows: [] }) } as any;
  const list = [
    ...buildReadTools({ pool, readonly: {} as any, skills: new SkillLibrary('/nonexistent'), http: { lookup, get }, docs }),
    ...buildDocTools({ docs }),
  ];
  const seen: CriticRequest[] = [];
  const gate = new CriticGate(
    {
      critic: { review: async (r: CriticRequest) => { seen.push(r); return { ok: false as const, error: 'x', runIds: [], costUsd: 0 }; } },
      plans: { updateSlot: async () => null as any },
      docs: o.gateDocs ?? docs,
      ...(o.libraryText ? { libraryText: o.libraryText } : {}),
    },
    { slotId: 's1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  const tools = Object.fromEntries(gate.wrapTools(list).map((t) => [t.name, t])) as Record<string, any>;
  const check = (text: string, spec: unknown) => gate.check({ text, spec, format: 'text', warnings: [] });
  return { docs, gate, seen, tools, check };
}

const FILLER = 'Загальні положення розділу без жодних номерів. ';
const fill = (n: number) => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);
const CLAUSE = '14.6. Обгін заборонено на пішохідних переходах і ближче ніж за 100 метрів до залізничного переїзду. ';
const FAR = '99.9. Штраф за порушення — 1700 грн. ';
const AT = 114_445;
const FAR_AT = 200_000;
/** A 270k text file of one section with a clause at 114,445 and another at 200,000 (a stand-in for the traffic code of review 4). */
const CODE = fill(AT) + CLAUSE + fill(FAR_AT - AT - CLAUSE.length) + FAR + fill(270_000 - FAR_AT - FAR.length);
const CODE_URL = 'https://code.example/pdr.txt';

test('reader regression: web_fetch → find_in_doc → read_doc — the critic gets the clause with offsets (coverage read), lint grounds on it', async () => {
  const { gate, seen, tools, check } = rig({ [CODE_URL]: CODE });
  const first = await tools.web_fetch.execute({ url: CODE_URL }, ctx);
  assert.equal(first.size_chars, CODE.length);
  assert.ok(first.doc_id);
  const found = await tools.find_in_doc.execute({ doc_id: first.doc_id, query: '14.6', limit: 3 }, ctx);
  assert.equal(found.matches[0].offset, AT);
  const page = await tools.read_doc.execute({ doc_id: first.doc_id, from: AT - 200, max_chars: 2_000 }, ctx);
  assert.equal(page.from, AT - 200);

  const spec = { source: { url: CODE_URL } };
  await check('За п. 14.6 правил обгін заборонено на пішохідних переходах.', spec);
  const src = seen[0].source!;
  assert.equal(src.coverage, 'read');
  assert.equal(src.read!.size, CODE.length);
  // The first chunk, and one merged part: the find_in_doc snippet and the read_doc page overlap.
  assert.deepEqual(src.read!.spans!.map((s) => [s.from, s.to]), [[0, first.text.length], [AT - 300, AT - 200 + page.text.length]]);
  assert.ok(src.read!.spans![1].text.includes('14.6. Обгін заборонено'));
  assert.ok(src.read!.chars < 10_000, 'only what was read, never the 270k');
  const prompt = criticUserPrompt(seen[0]);
  assert.match(prompt, /Що автор прочитав у документі \(\d+ з 270000 знаків\)/);
  assert.ok(prompt.includes(`[знаки ${AT - 300}–${AT - 200 + page.text.length}]`));
  assert.match(prompt, /14\.6\. Обгін заборонено на пішохідних переходах/);
  assert.match(prompt, /не доказ, що факту немає в джерелі: став grounding 3 з приміткою, не ≤ 2/);
  assert.ok(!prompt.includes('1700 грн'), 'the clause at 200,000 was not read, so it is not shown');

  // Lint and the critic's code check read the same text: the clause is there, the unread one is not.
  const sources = await gate.groundingSources({});
  const text = sources.find((s) => s.url === CODE_URL)!.text!;
  assert.ok(text.includes('14.6. Обгін заборонено'));
  assert.ok(text.length < 15_000);
  assert.deepEqual(groundNumbers('Згідно з п. 14.6 обгін заборонено.', sources).missing, []);
  assert.deepEqual(groundNumbers('Штраф 1700 грн.', sources).missing.map((n) => n.text), ['1700 грн'], 'a number the author never read is not grounded just because the doc has it');
  assert.deepEqual(src.grounding?.missing ?? [], []);
});

test('the parts of a document come in order with a gap marker, so numbers at two edges never fuse', async () => {
  const { gate, tools } = rig({ [CODE_URL]: CODE });
  const first = await tools.web_fetch.execute({ url: CODE_URL }, ctx);
  await tools.find_in_doc.execute({ doc_id: first.doc_id, query: '99.9', limit: 1 }, ctx);
  await tools.find_in_doc.execute({ doc_id: first.doc_id, query: '14.6', limit: 1 }, ctx);
  const text = (await gate.groundingSources({ })).find((s) => s.url === CODE_URL)!.text!;
  assert.ok(text.indexOf('14.6.') < text.indexOf('99.9.'), 'document order, not reading order');
  assert.equal(text.split('\n…\n').length, 3);
});

test('a short page (a902605d: 1,713 chars) comes whole — coverage full, no passages; «5 з 10» is grounded by "5/10"', async () => {
  const url = 'https://news.example/teardown';
  const text = ('The teardown scored the phone 5/10 for repairability, the lowest of the year. '
    + 'The battery is glued and the hinge cannot be replaced alone. '.repeat(5)).padEnd(1_713, ' Related stories follow.').slice(0, 1_713);
  assert.equal(text.length, 1_713);
  const { gate, seen, tools, check } = rig({ [url]: text });
  const r = await tools.web_fetch.execute({ url }, ctx);
  assert.equal(r.doc_id, undefined, 'a short page has no doc_id');
  await check('Ремонтопридатність — 5 з 10. Акумулятор приклеєно.', { source: { url } });
  const src = seen[0].source!;
  assert.equal(src.coverage, 'full');
  assert.equal(src.page, text);
  assert.deepEqual(src.passages, []);
  assert.equal(src.excerpt, null);
  assert.deepEqual(src.grounding?.missing ?? [], [], '5 з 10 = 5/10');
  assert.match(criticUserPrompt(seen[0]), /Це весь текст сторінки: чого тут немає — немає в джерелі\.\nThe teardown scored/);
  assert.equal((await gate.groundingSources({})).find((s) => s.url === url)!.text, text);
});

test('a 6–12k document in the store is given whole, also the part the author did not scroll to', async () => {
  const url = 'https://docs.example/guide.txt';
  const body = fill(7_500) + 'Ліміт запитів — 4321 на хвилину. ' + fill(1_500);
  const { gate, seen, tools, check } = rig({ [url]: body });
  const r = await tools.web_fetch.execute({ url }, ctx);
  assert.ok(r.doc_id && r.text.length <= 3_000, 'web_fetch gave only the first chunk');
  const spec = { source: { url } };
  await check('Ліміт — 4321 запит на хвилину.', spec);
  const src = seen[0].source!;
  assert.equal(src.coverage, 'full');
  assert.ok(src.page!.includes('4321 на хвилину'));
  assert.equal(src.read, undefined);
  assert.deepEqual((await gate.groundingSources({})).find((s) => s.url === url)!.text, body);
  assert.ok(body.length > 6_000 && body.length < FULL_PAGE_MAX);
});

test('a document missing from the store: the critic still reads the span text captured at tool time', async () => {
  const other = 'https://code.example/other.txt';
  const { gate, seen, tools, check } = rig({ [CODE_URL]: CODE, [other]: CODE.replace('14.6.', '15.7.') }, { docs: new DocStore({ max: 1 }) });
  const first = await tools.web_fetch.execute({ url: CODE_URL }, ctx);
  await tools.find_in_doc.execute({ doc_id: first.doc_id, query: '14.6', limit: 1 }, ctx);
  await tools.web_fetch.execute({ url: other }, ctx);                       // pushes the first document out of the store
  assert.equal((await tools.read_doc.execute({ doc_id: first.doc_id }, ctx)).error, 'doc_expired');
  const spec = { source: { url: CODE_URL } };
  await check('Обгін заборонено згідно з п. 14.6.', spec);
  const src = seen[0].source!;
  assert.equal(src.coverage, 'read');
  assert.ok(src.read!.spans!.some((s) => s.text.includes('14.6. Обгін заборонено')));
  assert.ok((await gate.groundingSources({})).find((s) => s.url === CODE_URL)!.text!.includes('14.6. Обгін заборонено'));
});

test('a newer copy under the same doc_id is never sliced with the captured offsets (spec 070): the captured span text is what the critic reads', async () => {
  const store = new DocStore();
  const newer: Record<string, NonNullable<ReturnType<DocStore['get']>>> = {};
  const view = { get: (id: string) => newer[id] ?? store.get(id), urlOf: (id: string) => store.urlOf(id) };
  const small = 'https://docs.example/guide.txt';
  const body = fill(7_500) + 'Ліміт запитів — 4321 на хвилину. ' + fill(1_500);
  const { gate, seen, tools, check } = rig({ [CODE_URL]: CODE, [small]: body }, { docs: store, gateDocs: view });
  const big = await tools.web_fetch.execute({ url: CODE_URL }, ctx);
  await tools.find_in_doc.execute({ doc_id: big.doc_id, query: '14.6', limit: 1 }, ctx);
  const little = await tools.web_fetch.execute({ url: small }, ctx);
  // Another run refetched both documents: the same ids, other texts, a later copy.
  const renew = (id: string, text: string) => { const kept = store.get(id)!; return { ...kept, text, fetched_at: kept.fetched_at + 1 }; };
  newer[big.doc_id] = renew(big.doc_id, 'x'.repeat(270_000));
  newer[little.doc_id] = renew(little.doc_id, 'y'.repeat(9_000));
  await check('Обгін заборонено згідно з п. 14.6.', { source: { url: CODE_URL } });
  const src = seen[0].source!;
  assert.equal(src.coverage, 'read');
  assert.ok(src.read!.spans!.some((s) => s.text.includes('14.6. Обгін заборонено')), 'the text read, not the newer copy at the same offsets');
  assert.ok(!src.read!.spans!.some((s) => s.text.includes('xxxx')));
  await check('Ліміт — 4321 на хвилину.', { source: { url: small } });
  const s2 = seen[1].source!;
  assert.equal(s2.coverage, 'read', 'the whole page only from the copy that was fetched, not a newer one');
  assert.ok(!(s2.read!.spans ?? []).some((s) => s.text.includes('yyyy')));
  assert.ok(!(await gate.groundingSources({})).some((s) => s.text?.includes('yyyy') || s.text?.includes('xxxx')));
});

test('read_doc on a doc_id with no web_fetch in this run: the address comes from the store and the document counts as read', async () => {
  const docs = new DocStore();
  const earlier = rig({ [CODE_URL]: CODE }, { docs });
  const first = await earlier.tools.web_fetch.execute({ url: CODE_URL }, ctx);           // another run fetched it
  const { gate, seen, tools, check } = rig({}, { docs });
  const page = await tools.read_doc.execute({ doc_id: first.doc_id, from: AT - 100, max_chars: 1_000 }, ctx);
  assert.ok(page.text.includes('14.6.'));
  assert.deepEqual(gate.sources().map((s) => s.url), [CODE_URL]);
  await check('Обгін заборонено згідно з п. 14.6.', { source: { url: CODE_URL } });
  assert.equal(seen[0].source!.coverage, 'read');
  assert.ok(seen[0].source!.read!.spans![0].text.includes('14.6.'));
  assert.ok((await gate.groundingSources({})).find((s) => s.url === CODE_URL)!.text!.includes('14.6.'));
});

test('a JSON answer has a doc_id and no text: nothing was read yet', async () => {
  const url = 'https://api.example/items.json';
  const { gate, seen, check } = rig({});
  const [fetch] = gate.wrapTools([{ name: 'web_fetch', execute: async () => ({ url, title: null, description: null, doc_id: 'doc_json', size_chars: 5_000, records: 12, outline: [] }) }] as any);
  await fetch.execute({ url }, ctx);
  await check('Є 12 записів.', { source: { url } });
  assert.equal(seen[0].source!.coverage, 'none');
  assert.equal((await gate.groundingSources({})).find((s) => s.url === url)!.text, undefined);
});

test('a feed item is a snippet; a page read in full wins over it', async () => {
  const link = 'https://news.example/a1';
  const { gate, seen, check } = rig({});
  const [feed] = gate.wrapTools([{ name: 'fetch_feed', execute: async () => ({ items: [{ link, title: 'Новина', date: '2026-10-20', snippet: 'Продано 4500 копій.' }] }) }] as any);
  await feed.execute({}, ctx);
  await check('Продано 4500 копій.', { source: { url: link } });
  assert.equal(seen[0].source!.coverage, 'snippet');
  assert.match(seen[0].source!.passages![0].text, /4500 копій/);
});

test('library rows: the whole row is full, a clipped one is read; the lowest coverage of the cited sources is reported', async () => {
  const url = 'https://news.example/short';
  const row = 'description: Борщ\ningredients: ["500 г буряка"]';
  const { seen, tools, check } = rig({ [url]: 'Коротка сторінка про борщ, 1 казан.' }, { libraryText: async (ref) => (ref === 'data://recipes/1' ? row : ref === 'data://recipes/2' ? 'x'.repeat(LIBRARY_ROW_CAP) : null) });
  await check('Борщ.', { library_ref: 'data://recipes/1' });
  assert.equal(seen[0].source!.coverage, 'full');
  assert.match(criticUserPrompt(seen[0]), /Це весь рядок бібліотеки \(усі поля\): чого тут немає — немає в джерелі\.\ndescription: Борщ/);
  await check('Борщ 2.', { library_ref: 'data://recipes/2' });
  assert.equal(seen[1].source!.coverage, 'read');
  assert.match(criticUserPrompt(seen[1]), /Фрагмент, який читав автор:/);
  await tools.web_fetch.execute({ url }, ctx);
  await check('Борщ 3.', { source: { url }, library_ref: 'data://recipes/2' });
  assert.equal(seen[2].source!.coverage, 'read', 'a full page and a clipped row: read');
  await check('Борщ 4.', { source: { url } });
  assert.equal(seen[3].source!.coverage, 'full');
  await check('Борщ 5.', { source: { url: 'https://never.example/read' } });
  assert.equal(seen[4].source!.coverage, 'none');
});

test('067 review R2: the block follows what is present, not the lowered coverage — a whole page next to a clipped library row shows the page and the row\'s passages', async () => {
  const url = 'https://news.example/short';
  const page = 'Коротка сторінка про борщ, 1 казан.';
  const filler = 'Опис страви без чисел. '.repeat(600);
  const clipped = (filler.slice(0, 6_000) + ' Порція коштує 1700 грн. ' + filler).slice(0, LIBRARY_ROW_CAP);
  assert.equal(clipped.length, LIBRARY_ROW_CAP);
  const short = 'description: Борщ\ningredients: ["500 г буряка"]';
  const { seen, tools, check } = rig({ [url]: page }, { libraryText: async (ref) => (ref === 'data://recipes/2' ? clipped : ref === 'data://recipes/1' ? short : null) });
  await tools.web_fetch.execute({ url }, ctx);

  await check('Борщ, порція коштує 1700 грн.', { source: { url }, library_ref: 'data://recipes/2' });
  const src = seen[0].source!;
  assert.equal(src.coverage, 'read', 'the stored coverage is the lowest (decideVerdict reads it)');
  assert.equal(src.page, page);
  assert.equal(src.library?.clipped, true);
  const prompt = criticUserPrompt(seen[0]);
  assert.ok(prompt.includes(`Це весь текст цитованої сторінки: чого тут немає — немає на сторінці (рядок бібліотеки — окреме джерело нижче).\n${page}`), prompt);
  assert.ok(!prompt.includes('Це весь текст сторінки: чого тут немає — немає в джерелі'), 'the page is not claimed to be the only source');
  assert.ok(prompt.includes('Рядок бібліотеки (library_ref) — друге джерело поста; він довгий, тут лише його частина.'));
  assert.match(prompt, /\[р1\] про [^\n]*:\n[\s\S]*Порція коштує 1700 грн/);
  assert.ok(!prompt.includes('Чисел і назв поста на прочитаних сторінках не знайдено'), 'a source is shown');

  // A clipped row with nothing of the post in it: its start.
  await check('Борщ без чисел.', { source: { url }, library_ref: 'data://recipes/2', title: 'Без чисел' });
  assert.match(criticUserPrompt(seen[1]), /Чисел і назв поста у цій частині рядка не знайдено\.\nПочаток рядка:\nОпис страви/);

  // A short row next to a whole page: both are shown, the row whole.
  await check('Борщ 2.', { source: { url }, library_ref: 'data://recipes/1' });
  assert.equal(seen[2].source!.coverage, 'full');
  const both = criticUserPrompt(seen[2]);
  assert.ok(both.includes(page));
  assert.ok(both.includes(`Рядок бібліотеки (library_ref) — друге джерело поста. Це весь рядок (усі поля): чого тут немає — немає в рядку.\n${short}`), both);

  // No library row: the line is the one of spec 067 T1.
  await check('Борщ 3.', { source: { url } });
  assert.ok(criticUserPrompt(seen[3]).includes(`Це весь текст сторінки: чого тут немає — немає в джерелі.\n${page}`));
  assert.ok(!criticUserPrompt(seen[3]).includes('Рядок бібліотеки'));
});

test('067 review R2: criticPassageLines chooses the page / read block by what is there, whatever the coverage says', () => {
  const base = { url: 'https://a.example/x', excerpt: null, title: 'Т', publishedAt: null, passages: [], grounding: null };
  const lines = (s: Parameters<typeof criticPassageLines>[0]) => criticPassageLines(s).join('\n');
  const page = lines({ ...base, coverage: 'read', page: 'ТЕКСТ СТОРІНКИ', library: { clipped: true, head: 'ПОЧАТОК РЯДКА' } });
  assert.ok(page.includes('ТЕКСТ СТОРІНКИ'));
  assert.ok(page.includes('ПОЧАТОК РЯДКА'));
  const read = lines({ ...base, coverage: 'snippet', read: { size: 50_000, chars: 20, spans: [{ from: 10, to: 30, text: 'ПРОЧИТАНА ЧАСТИНА' }] }, library: { text: 'ПОВНИЙ РЯДОК' } });
  assert.ok(read.includes('[знаки 10–30]\nПРОЧИТАНА ЧАСТИНА'), read);
  assert.match(read, /Це весь рядок \(усі поля\)[^\n]*\nПОВНИЙ РЯДОК/);
});

test('libraryRowText: the retold fields first, then every other field (a recipe\'s ingredients too), capped', () => {
  const row = { title: 'Борщ', time_min: 90, ingredients: ['500 г буряка', '2 л води'], instructions_uk: 'Варити.', description: 'Класичний', empty: '', note: null };
  assert.equal(libraryRowText('recipes', row), 'description: Класичний\ninstructions_uk: Варити.\ntitle: Борщ\ntime_min: 90\ningredients: ["500 г буряка","2 л води"]');
  assert.equal(libraryRowText('quotes', { text: 'Слово', author: 'А' }), 'text: Слово\nauthor: А');
  assert.equal(libraryRowText('facts', { content: 'x'.repeat(20_000) }).length, LIBRARY_ROW_CAP);
});

test('mergeSpans and the coverage order', () => {
  assert.deepEqual(mergeSpans([{ from: 10, to: 14, text: 'klmn' }, { from: 0, to: 12, text: 'abcdefghijkl' }, { from: 20, to: 22, text: 'uv' }, { from: 22, to: 24, text: 'wx' }, { from: 3, to: 5, text: 'de' }]),
    [{ from: 0, to: 14, text: 'abcdefghijklmn' }, { from: 20, to: 24, text: 'uvwx' }]);
  assert.equal(lowerCoverage('full', 'read'), 'read');
  assert.equal(lowerCoverage('snippet', 'read'), 'snippet');
  assert.equal(lowerCoverage('none', 'full'), 'none');
});
