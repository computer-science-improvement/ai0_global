import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { ExtractError, extractValue, linePattern, splitEntries } from './list-extract';
import { buildPlan, ImportListInput, payloadOf, PlanError, previewOf } from './import-list';
import { buildImportListTools } from './import-list-tools';
import { PDR_HTML, PDR_MAPPING, PDR_SECTION_LINE, PDR_SPLIT_ON, PDR_URL } from './testing/pdr-fixture';
import type { StoredDoc } from './doc-types';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const get = (body: string, type = 'text/html; charset=utf-8') => async () => ({ status: 200, headers: { 'content-type': type }, data: body });

async function pdrDoc(): Promise<StoredDoc> {
  const r: any = await fetchDocument(PDR_URL, { docs: new DocStore(), http: { lookup, get: get(PDR_HTML) } });
  return r.doc;
}

const contexts = new Map([[PDR_SECTION_LINE, linePattern(PDR_SECTION_LINE, 'context')]]);
const records = async (opts: Parameters<typeof splitEntries>[2] = { contexts }) => splitEntries(await pdrDoc(), linePattern(PDR_SPLIT_ON, 'split_on'), opts);
const byKey = (entries: Awaited<ReturnType<typeof records>>['entries'], key: string) => entries.filter((e) => e.split?.key === key);

test('the fixture is one long section plus two footer sections, as the real page is', async () => {
  const doc = await pdrDoc();
  assert.deepEqual(doc.sections.map((s) => [s.heading, s.level]), [['', 1], ['Документи та файли', 2], ['Публікації документа', 2]]);
});

test('split_on cuts the page into clauses: keys, headings, dropped preamble, sections end a record', async () => {
  const { entries, capped } = await records();
  assert.equal(capped, false);
  assert.deepEqual(entries.map((e) => e.split!.key), ['1.1', '1.2', '1.6', '1.10', '8.7.3', '14.1', '14.6', '1.1']);
  assert.deepEqual(entries.map((e) => e.heading).slice(0, 3), [
    '1.1. Ці Правила встановлюють єдиний порядок дорожнього руху на всій території держави.',
    '1.2. Правила поширюються на всіх учасників дорожнього руху.',
    '1.6. Учасники дорожнього руху зобов\'язані:',
  ]);
  assert.ok(entries.every((e) => e.level === 0));
  assert.ok(!entries.some((e) => /Затвердити|Установити/.test(e.text)), 'text before the first match is dropped');
});

test('a record stops before a section title and before the footer sections', async () => {
  const { entries } = await records();
  const last = entries.at(-1)!;
  assert.equal(last.text.trim(), '1.1. Небезпечний поворот. Встановлюють перед закругленням дороги.', 'the last record stops before the footer sections');
  assert.ok(!entries.some((e) => /Документи та файли|Офіційний вісник/.test(e.text)));
  const clause = byKey(entries, '1.10')[0];
  assert.ok(!/8\. РЕГУЛЮВАННЯ/.test(clause.text), 'a section title is not swallowed by the clause above it (context_line ends a record)');
  assert.ok(clause.text.trimEnd().endsWith('місце перетину доріг на одному рівні.'));
  assert.ok(!/14\. ОБГІН/.test(byKey(entries, '8.7.3')[0].text));
});

test('without the context pattern a section title joins the clause above it', async () => {
  const { entries } = await records({});
  assert.match(byKey(entries, '1.10')[0].text, /8\. РЕГУЛЮВАННЯ ДОРОЖНЬОГО РУХУ/);
});

test('a sign line without a trailing dot stays inside the clause above it', async () => {
  const { entries } = await records();
  const clause = byKey(entries, '8.7.3')[0];
  assert.match(clause.text, /Червоний сигнал[\s\S]+\n1\.1 «Небезпечний поворот»/);
  assert.equal(byKey(entries, '1.1').length, 2, 'the dotted item of the signs section repeats the key of clause 1.1');
});

test('extractors: split_key, text, text_without, context_line, url_anchor', async () => {
  const { entries } = await records();
  const e = byKey(entries, '14.6')[0];
  assert.equal(extractValue('split_key', e), '14.6');
  assert.equal(extractValue('heading', e), 'Обгін заборонено:', 'the outline number is not part of the title');
  assert.equal(extractValue('text', e), '14.6. Обгін заборонено:\n{Пункт 14.6 в редакції Постанови КМ N 444 від 05.06.2020}\nа) на регульованих перехрестях;\nб) на пішохідних переходах;\nв) на залізничних переїздах.');
  assert.equal(extractValue('text_without:^\\{', e), '14.6. Обгін заборонено:\nа) на регульованих перехрестях;\nб) на пішохідних переходах;\nв) на залізничних переїздах.');
  assert.equal(extractValue(`context_line:${PDR_SECTION_LINE}`, e), '14. ОБГІН');
  assert.equal(extractValue(`context_line:${PDR_SECTION_LINE}`, byKey(entries, '1.6')[0]), '1. ЗАГАЛЬНІ ПОЛОЖЕННЯ');
  assert.equal(extractValue(`context_line:${PDR_SECTION_LINE}`, byKey(entries, '1.1')[1]), '33. ДОРОЖНІ ЗНАКИ');
  assert.equal(extractValue('url_anchor:п.', e), 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF/print#п.14.6', 'percent-encoded path, raw fragment');
  assert.equal(extractValue('url_anchor:', e), 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF/print#14.6');
  assert.equal(extractValue('text_without:^[0-9]', byKey(entries, '1.2')[0]), null, 'a record with nothing left has no value');
});

test('the dash list of clause 1.10 keeps its lines and the editorial note goes with text_without', async () => {
  const { entries } = await records();
  const e = byKey(entries, '1.10')[0];
  const text = extractValue('text_without:^\\{', e)!;
  assert.match(text, /^1\.10\. У цих Правилах терміни[^\n]+:\n- автомагістраль[^\n]+\n- водій[^\n]+\n- перехрестя/);
  assert.ok(!/Пункт 1\.10/.test(text));
});

test('the url_anchor spelling matches the ledger anchors: path as stored, fragment decodes to п.14.6', async () => {
  const { anchorOf } = await import('../../data/ledger-anchor');
  const { entries } = await records();
  const url = extractValue('url_anchor:п.', byKey(entries, '14.6')[0])!;
  assert.equal(anchorOf({ url }), 'п.14.6');
});

test('split_key, url_anchor and context_line need split_on; split extractors are refused on JSON', async () => {
  const doc = await pdrDoc();
  const { entriesOf } = await import('./list-extract');
  const e = entriesOf(doc, 1)[0];
  for (const spec of ['split_key', 'url_anchor:п.', 'context_line:^[0-9]']) {
    assert.throws(() => extractValue(spec, e), (err: any) => err instanceof ExtractError && err.code === 'wrong_extractor' && /needs split_on/.test(err.message), spec);
  }
  const json = { id: 'r1', heading: 'x', level: 1, start: 0, text: '{}', images: [], links: [], blocks: [], record: {} };
  for (const spec of ['split_key', 'url_anchor:п.', 'text', 'text_without:^a', 'context_line:^a']) {
    assert.throws(() => extractValue(spec, json), (err: any) => err.code === 'wrong_extractor' && /JSON/.test(err.message), spec);
  }
});

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ARGS = { dataset: 'pdr_rules', mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, title: 'ПДР', license: undefined };

test('the plan: eight records, refs by clause key (repeats get a number), the mapping per row, required [[text]]', async () => {
  const doc = await pdrDoc();
  const plan = buildPlan(doc, ARGS, null);
  assert.equal(plan.level, 0);
  assert.equal(plan.entries, 8);
  assert.equal(plan.rows.length, 8);
  assert.deepEqual(plan.rows.map((r) => r.list_ref), [
    `${PDR_URL}#1.1`, `${PDR_URL}#1.2`, `${PDR_URL}#1.6`, `${PDR_URL}#1.10`, `${PDR_URL}#8.7.3`, `${PDR_URL}#14.1`, `${PDR_URL}#14.6`, `${PDR_URL}#1.1 (2)`,
  ]);
  const row = plan.rows.find((r) => r.clause === '14.6')!;
  assert.deepEqual(row, {
    clause: '14.6', title: 'Обгін заборонено:', text: '14.6. Обгін заборонено:\nа) на регульованих перехрестях;\nб) на пішохідних переходах;\nв) на залізничних переїздах.',
    category: '14. ОБГІН', source_url: `${PDR_URL}#п.14.6`, license: 'public domain', list_ref: `${PDR_URL}#14.6`, list_url: PDR_URL,
  });
  assert.deepEqual(plan.required, ['text'], 'the heading does not count as content with split_on: every record has one');
  assert.deepEqual(plan.newSchema!.post_requires, [['text']]);
  assert.deepEqual(plan.newSchema!.dedup_key, ['list_ref']);
  const fields = Object.fromEntries(plan.newSchema!.fields.map((f) => [f.name, f]));
  assert.equal(fields.text.type, 'long_text');
  assert.equal(fields.text.searchable, true);
  assert.equal(fields.title.searchable, true);
  assert.equal(fields.source_url.type, 'url');
  assert.equal(fields.category.filterable, true);
  assert.equal(plan.newSchema!.roles.body, 'text');
  assert.equal(plan.newSchema!.roles.url, 'source_url');
  assert.equal(plan.newSchema!.roles.title, 'title');
  assert.equal(plan.split_on, PDR_SPLIT_ON);
});

test('the preview says how many records, the longest one and which keys repeat', async () => {
  const doc = await pdrDoc();
  const plan = buildPlan(doc, { ...ARGS, level: 3 }, null);
  const view: any = previewOf(plan, 2, false, 'pdr_rules');
  assert.equal(view.records, 8);
  assert.deepEqual(view.repeated_keys, ['1.1 ×2']);
  const longest = Math.max(...plan.rows.map((r) => String(r.text).length));
  assert.ok(view.longest_record_chars >= longest && view.longest_record_chars < longest + 200, `longest ${view.longest_record_chars}`);
  assert.ok(plan.notes.some((n) => /keys repeat \(1\.1 ×2\)/.test(n)));
  assert.ok(plan.notes.includes('level is ignored with split_on'));
  assert.equal(view.level, 0);
});

test('with split_on the default required is only the text / text_without fields: a picture, a code block or the heading is not enough (A3)', async () => {
  const doc = await pdrDoc();
  const base = { dataset: 'pdr_pics', split_on: PDR_SPLIT_ON };
  const withImage = buildPlan(doc, { ...base, mapping: { text: 'text', pic: 'first_image', title: 'heading', code: 'first_code_block' } }, null);
  assert.deepEqual(withImage.required, ['text'], 'first_image / first_code_block / heading do not count with split_on');
  assert.deepEqual(buildPlan(doc, { ...base, mapping: { body: 'text_without:^\\{', pic: 'first_image' } }, null).required, ['body']);
  assert.deepEqual(buildPlan(doc, { ...base, mapping: { title: 'heading', pic: 'first_image', clause: 'split_key' } }, null).required, [], 'no text field: nothing is required by default');
  // The same mapping without split_on keeps the old default (the heading, a picture and a code block are content).
  const plain = buildPlan(await pdrDoc(), { ...base, split_on: undefined, level: 2, mapping: { title: 'heading', pic: 'first_image' } } as any, null);
  assert.deepEqual(plain.required, ['title', 'pic']);
  // An explicit required still wins.
  assert.deepEqual(buildPlan(doc, { ...base, mapping: { text: 'text', pic: 'first_image' }, required: [['pic']] }, null).required, [['pic']]);
});

test('without a group in the pattern a record has no key: its ref comes from the heading as before', async () => {
  const doc = await pdrDoc();
  const plan = buildPlan(doc, { dataset: 'pdr_nokey', mapping: { title: 'heading', text: 'text', k: 'split_key' }, split_on: '^[0-9]{1,2}[.][0-9]{1,2}[.] ' }, null);
  assert.ok(plan.rows.length > 0);
  assert.ok(plan.rows.every((r) => !('k' in r)), 'split_key is empty without a group');
  assert.ok(plan.rows.every((r) => String(r.list_ref).includes('#')));
});

test('a JSON document refuses split_on; a bad or silent pattern says so', async () => {
  const json: any = await fetchDocument('https://example.com/api/items', { docs: new DocStore(), http: { lookup, get: get(JSON.stringify([{ id: 1, name: 'a' }]), 'application/json') } });
  assert.throws(() => buildPlan(json.doc, { dataset: 'x_items', mapping: { name: 'field:name' }, split_on: '^a' }, null), (err: any) => err instanceof PlanError && err.code === 'wrong_args' && /JSON/.test(err.message));
  const doc = await pdrDoc();
  assert.throws(() => buildPlan(doc, { ...ARGS, split_on: '(' }, null), (err: any) => err instanceof PlanError && err.code === 'bad_pattern' && /split_on/.test(err.message));
  assert.throws(() => buildPlan(doc, { ...ARGS, split_on: 'a'.repeat(201) }, null), (err: any) => err.code === 'bad_pattern');
  assert.throws(() => buildPlan(doc, { ...ARGS, split_on: '^ZZZ' }, null), (err: any) => err instanceof PlanError && err.code === 'no_entries' && /matches no line/.test(err.message));
  assert.throws(() => buildPlan(doc, { ...ARGS, mapping: { ...PDR_MAPPING, category: 'context_line:(' } }, null), (err: any) => err.code === 'bad_pattern');
  assert.equal(ImportListInput.safeParse({ doc_id: 'doc_1', dataset: 'pdr_rules', mapping: { t: 'text' }, split_on: 'a'.repeat(201) }).success, false, 'the input caps the pattern at 200 characters');
});

test('records are capped at the row limit, with a note', async () => {
  const doc = await pdrDoc();
  const plan = buildPlan(doc, ARGS, null, { maxRows: 3 });
  assert.equal(plan.entries, 3);
  assert.equal(plan.rows.length, 3);
  assert.deepEqual(plan.rows.map((r) => r.clause), ['1.1', '1.2', '1.6']);
  assert.ok(plan.notes.some((n) => /IMPORT_MAX_ROWS = 3.+only the first 3/.test(n)));
  const all = buildPlan(doc, ARGS, null, { maxRows: 8 });
  assert.equal(all.entries, 8);
  assert.ok(!all.notes.some((n) => /IMPORT_MAX_ROWS/.test(n)), 'exactly at the limit is not a cut');
});

test('a pattern is tested on the first 300 characters of a line only', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `${(i % 90) + 1}.${(i % 40) + 1}. ${'слово '.repeat(15)}`);
  lines.push(`${'a'.repeat(400)} 9.9. past the first 300 characters`);
  lines.push(`x${'1'.repeat(250_000)}`);
  const text = lines.join('\n');
  const doc = { id: 'd', url: 'https://example.com/law', fetched_url: null, final_url: 'https://example.com/law', kind: 'text', title: null, description: null, image: null, images: [], published_at: null,
    text, sections: [{ id: 's1', heading: '', level: 1, start: 0, end: text.length, images: [], links: [], code_blocks: [] }], fetched_at: 0 } as StoredDoc;
  const t0 = Date.now();
  const { entries } = splitEntries(doc, linePattern('([0-9]+[.][0-9]+)[.] ', 'split_on'));
  assert.equal(entries.length, 3000, 'a number after the 300th character of a line does not start a record');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(entries.at(-1)!.text.length > 250_000, 'the long lines belong to the last record');
});

test('images, links and code blocks belong to the record they sit in', () => {
  const text = 'intro\n1.1. First\nsee ![a](https://e.com/a.png) and [b](https://e.com/b)\n1.2. Second\n```\ncode\n```\nplain';
  const at = (s: string) => text.indexOf(s);
  const doc = { id: 'd', url: 'https://example.com/md', fetched_url: null, final_url: '', kind: 'markdown', title: null, description: null, image: null, images: [], published_at: null, text,
    sections: [{ id: 's1', heading: '', level: 0, start: 0, end: text.length, images: [{ src: 'https://e.com/a.png', alt: 'a', at: at('![a]') }], links: [{ text: 'b', url: 'https://e.com/b', at: at('[b]') }],
      code_blocks: [{ lang: '', text: 'code', start: at('```'), end: at('plain') - 1 }] }], fetched_at: 0 } as StoredDoc;
  const { entries } = splitEntries(doc, linePattern('^([0-9.]+)\\. ', 'split_on'));
  assert.deepEqual(entries.map((e) => [e.split!.key, e.images.length, e.links.length, e.blocks.length]), [['1.1', 1, 1, 0], ['1.2', 0, 0, 1]]);
  assert.equal(extractValue('first_image', entries[0]), 'https://e.com/a.png');
  assert.equal(extractValue('first_code_block', entries[1]), 'code');
});

// ── the tool ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('import_list previews a split page and proposes one card that carries split_on', async () => {
  const docs = new DocStore();
  const r: any = await fetchDocument(PDR_URL, { docs, http: { lookup, get: get(PDR_HTML) } });
  const proposed: any[] = [];
  const pool = { query: async (sql: string) => (/pending_actions/.test(sql) ? { rows: [] } : { rows: [] }) } as any;
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs, actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa-split', ...a }; } } as any,
  }).map((t) => [t.name, t])) as Record<string, any>;
  const store = await import('../../data/data-store');
  const orig = store.DataStore.prototype.getSchema;
  store.DataStore.prototype.getSchema = async () => null;
  try {
    const out = await tools.import_list.execute({ doc_id: r.doc.id, dataset: 'pdr_rules', mapping: PDR_MAPPING, split_on: PDR_SPLIT_ON, sample: 2 }, { runId: 'r', role: 'composer', channelKey: null, extras: {} });
    assert.equal(out.ok, true);
    assert.equal(out.preview.importable, 8);
    assert.equal(out.preview.records, 8);
    assert.deepEqual(out.preview.repeated_keys, ['1.1 ×2']);
    assert.deepEqual(out.preview.post_requires, ['text']);
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].payload.split_on, PDR_SPLIT_ON);
    assert.equal(proposed[0].payload.level, 0);
    assert.deepEqual(proposed[0].payload.required, ['text']);
    assert.deepEqual(payloadOf(buildPlan(r.doc, ARGS, null), 'pdr_rules').split_on, PDR_SPLIT_ON);
    assert.match(tools.import_list.description, /split_on/);
    assert.match(tools.import_list.description, /context_line/);
  } finally {
    store.DataStore.prototype.getSchema = orig;
  }
});
