import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { entriesOf, entryLevel, ExtractError, extractValue, filterEntries } from './list-extract';
import { buildPlan, licenseHint, payloadOf, PlanError, previewOf, summaryOf, ImportListInput, IMPORT_LIST_KIND } from './import-list';
import { buildImportListTools } from './import-list-tools';
import { buildDocTools } from './doc-tools';
import { NANOBANANA_RAW_URL, NANOBANANA_README, NANOBANANA_URL } from './testing/nanobanana-fixture';
import type { StoredDoc } from './doc-types';
import type { ToolContext } from '../harness/tool';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const get = (body = NANOBANANA_README) => async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, data: body });

async function fixtureDoc(docs = new DocStore(), body = NANOBANANA_README): Promise<StoredDoc> {
  const r: any = await fetchDocument(NANOBANANA_URL, { docs, http: { lookup, get: get(body) } });
  return r.doc;
}

/** The mapping the agent would write for the nanobanana list. */
const MAPPING = {
  title: 'heading', prompt_text: 'first_code_block', media_url: 'last_image', author: 'link_text_after:Source', source_url: 'last_link_after:Source',
};

const entry = (doc: StoredDoc, start: string) => entriesOf(doc, 3).find((e) => e.heading.startsWith(start))!;

test('the entry level is found from where the code blocks are', async () => {
  const doc = await fixtureDoc();
  assert.equal(entryLevel(doc), 3);
  const entries = entriesOf(doc, 3);
  assert.deepEqual(entries.map((e) => e.heading), [
    'Sponsor1', 'Sponsor2', '1.1. Hyper-Realistic Crowd Composition', '1.2. 2000s Mirror Selfie', '1.3. Chalkboard Notes (no picture yet)',
    '2.1. Ironing Out Wrinkles', '2.2. Prompt With Hash Lines',
  ]);
  const top = entriesOf(doc, 2).find((e) => e.heading.startsWith('1.'))!;
  assert.ok(top.text.includes('2000s Mirror Selfie'), 'an entry holds the deeper sections under it');
});

test('extractors read heading, whole prompt, pictures, paragraph and the Source line', async () => {
  const doc = await fixtureDoc();
  const crowd = entry(doc, '1.1');
  assert.equal(extractValue('heading', crowd), 'Hyper-Realistic Crowd Composition', 'outline numbers are not part of the name');
  assert.equal(extractValue('heading_raw', crowd), '1.1. Hyper-Realistic Crowd Composition');
  const prompt = extractValue('first_code_block', crowd)!;
  assert.match(prompt, /^Create a hyper-realistic[\s\S]+\n\nGENERAL STYLE & MOOD:[\s\S]+\n\nTHE ENVIRONMENT: A luxurious/, 'full prompt, paragraphs kept');
  assert.ok(prompt.endsWith('modern city skyline.'));
  assert.equal(extractValue('first_paragraph', crowd), 'Handling complex compositions with multiple famous faces and specific lighting.');
  assert.equal(extractValue('first_image', crowd), 'https://github.com/user-attachments/assets/3a056a8d-904e-4b3e-b0d2-b5122758b7f5');
  assert.equal(extractValue('link_after:Source', crowd), 'https://x.com/SebJefferies/status/1991531687147360728');
  assert.equal(extractValue('link_text_after:Source', crowd), '@SebJefferies');

  const json = entry(doc, '1.2');
  assert.match(extractValue('first_code_block', json)!, /^Create a 2000s Mirror Selfie[\s\S]+"flash": true[\s\S]+\}$/);
  assert.equal(extractValue('regex:"flash":\\s*(\\w+)', json), 'true');

  const wrinkles = entry(doc, '2.1');
  assert.equal(extractValue('first_image', wrinkles), 'https://github.com/user-attachments/assets/e41db56f-d928-400c-b21b-f8a0d53ba91b');
  assert.equal(extractValue('last_image', wrinkles), 'https://github.com/user-attachments/assets/793ad242-7867-4709-bdc6-55021f5eb78f');
  assert.equal(extractValue('image:2', wrinkles), extractValue('last_image', wrinkles));
  assert.equal(extractValue('image:3', wrinkles), null);
  assert.equal(extractValue('link_after:Source', wrinkles), 'https://x.com/emollick', 'the first link of the Source line: the author');
  assert.equal(extractValue('last_link_after:Source', wrinkles), 'https://x.com/emollick/status/1995720976068137048?s=20', 'the last: the post');
  assert.equal(extractValue('line_after:Source', wrinkles), 'Ethan Mollick (@emollick) - Post');
  assert.equal(extractValue('link_after:Nothing', wrinkles), null);

  const hashes = entry(doc, '2.2');
  assert.equal(extractValue('first_paragraph', hashes), 'A prompt that has lines starting with # inside its code block.', 'table rows and the code block are not prose');
  assert.equal(extractValue('first_code_block', hashes), '# Scene\nA quiet street at dawn.\n\n## Lighting\nSoft pink light from the left.');
  assert.equal(extractValue('link_text_after:Source', hashes), 'Replicate');

  assert.equal(extractValue('const:CC BY 4.0', crowd), 'CC BY 4.0');
  assert.equal(extractValue('first_image', entry(doc, '1.3')), null, 'no picture');
  assert.equal(extractValue('code_block:2', crowd), null);
});

test('a bad extractor or pattern says what is valid', async () => {
  const doc = await fixtureDoc();
  const e = entry(doc, '1.1');
  assert.throws(() => extractValue('first_pic', e), (err: any) => err instanceof ExtractError && /unknown extractor/.test(err.message) && /first_code_block/.test(err.message));
  assert.throws(() => extractValue('link_after', e), /needs an argument/);
  assert.throws(() => extractValue('regex:(', e), (err: any) => err.code === 'bad_pattern');
  assert.throws(() => extractValue('image:0', e), /position from 1/);
});

test('the filter drops by heading, by code block, by picture, by a word', async () => {
  const doc = await fixtureDoc();
  const all = entriesOf(doc, 3);
  const names = (f: any) => filterEntries(all, f).kept.map((e) => e.heading.split(' ')[0]);
  assert.deepEqual(names({ has_code_block: true }), ['1.1.', '1.2.', '1.3.', '2.1.', '2.2.']);
  assert.deepEqual(names({ has_image: true }), ['Sponsor1', 'Sponsor2', '1.1.', '1.2.', '2.1.', '2.2.'], 'sponsor banners are pictures too');
  assert.deepEqual(names({ heading_excludes: '^Sponsor' }), ['1.1.', '1.2.', '1.3.', '2.1.', '2.2.']);
  assert.deepEqual(names({ heading_matches: 'selfie|wrinkles' }), ['1.2.', '2.1.']);
  assert.deepEqual(names({ not_containing: 'sponsor' }).length, 5, 'the sponsor blocks mention «sponsoring»');
  assert.deepEqual(filterEntries(all, { has_code_block: true }).dropped, 2);
  assert.throws(() => filterEntries(all, { heading_matches: '(' }), (err: any) => err.code === 'bad_pattern');
});

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('nanobanana: the plan has four postable rows with the exact fields; the entry without a picture is not importable', async () => {
  const doc = await fixtureDoc();
  const plan = buildPlan(doc, { dataset: 'nanobanana_prompts', mapping: MAPPING, license: 'CC BY 4.0', filter: { has_code_block: true } }, null);
  assert.equal(plan.level, 3);
  assert.equal(plan.entries, 7);
  assert.equal(plan.filtered, 2, 'the sponsor blocks have no prompt');
  assert.deepEqual(plan.incomplete, [{ heading: '1.3. Chalkboard Notes (no picture yet)', missing: ['media_url'] }]);
  assert.deepEqual(plan.rows.map((r) => r.title), ['Hyper-Realistic Crowd Composition', '2000s Mirror Selfie', 'Ironing Out Wrinkles', 'Prompt With Hash Lines']);

  const [crowd, json, wrinkles, hashes] = plan.rows;
  assert.deepEqual(crowd, {
    title: 'Hyper-Realistic Crowd Composition', prompt_text: crowd.prompt_text,
    media_url: 'https://github.com/user-attachments/assets/3a056a8d-904e-4b3e-b0d2-b5122758b7f5',
    author: '@SebJefferies', source_url: 'https://x.com/SebJefferies/status/1991531687147360728', license: 'CC BY 4.0',
    list_ref: 'https://github.com/zerolu/awesome-nanobanana-pro#hyper-realistic crowd composition'.replace('zerolu', 'ZeroLu'), list_url: NANOBANANA_URL,
  });
  assert.match(String(crowd.prompt_text), /\n\nGENERAL STYLE & MOOD:/, 'newlines kept');
  assert.match(String(json.prompt_text), /^Create a 2000s Mirror Selfie of yourself using Gemini Nano Banana\.\n\n\{/);
  assert.equal(wrinkles.media_url, 'https://github.com/user-attachments/assets/793ad242-7867-4709-bdc6-55021f5eb78f', 'the result, not the input');
  assert.equal(wrinkles.author, '@emollick');
  assert.equal(wrinkles.source_url, 'https://x.com/emollick/status/1995720976068137048?s=20');
  assert.equal(hashes.media_url, 'https://replicate.delivery/pbxt/abc/out.webp');
  assert.equal(hashes.author, 'Replicate');
  assert.equal(hashes.source_url, 'https://replicate.com/');

  assert.deepEqual(plan.fill, { title: 100, prompt_text: 100, media_url: 80, author: 100, source_url: 100, license: 100 });
  assert.equal(plan.license_hint, 'CC BY 4.0');
});

test('without a filter the sponsor blocks are still not postable: they have no prompt', async () => {
  const doc = await fixtureDoc();
  const plan = buildPlan(doc, { dataset: 'nanobanana_prompts', mapping: MAPPING }, null);
  assert.equal(plan.rows.length, 4);
  assert.deepEqual(plan.incomplete.map((i) => i.heading), ['Sponsor1', 'Sponsor2', '1.3. Chalkboard Notes (no picture yet)']);
  assert.deepEqual(plan.incomplete[0].missing, ['prompt_text']);
});

test('the dataset to create: fields by their names, roles, post_requires, stable dedup key, licence', async () => {
  const doc = await fixtureDoc();
  const plan = buildPlan(doc, { dataset: 'nanobanana_prompts', mapping: MAPPING, license: 'CC BY 4.0', title: 'Nano Banana prompts', filter: { has_code_block: true } }, null);
  const s = plan.newSchema!;
  assert.equal(s.key, 'nanobanana_prompts');
  assert.equal(s.title, 'Nano Banana prompts');
  assert.deepEqual(s.fields.map((f) => [f.name, f.type]), [
    ['title', 'text'], ['prompt_text', 'long_text'], ['media_url', 'image_url'], ['author', 'text'], ['source_url', 'url'], ['license', 'text'],
    ['list_ref', 'text'], ['list_url', 'url'],
  ]);
  assert.deepEqual(s.post_requires, [['title'], ['prompt_text'], ['media_url']], 'content fields are required; author and source are not');
  assert.deepEqual(s.roles, { title: 'title', body: 'prompt_text', image: 'media_url', url: 'source_url', source_name: 'author', license: 'license' });
  assert.deepEqual(s.dedup_key, ['list_ref']);
  assert.equal(s.default_license, 'CC BY 4.0');
  assert.deepEqual(s.reuse_policy, { kind: 'never' });
  assert.deepEqual(plan.required, ['title', 'prompt_text', 'media_url']);
  const explicit = buildPlan(doc, { dataset: 'nb', mapping: MAPPING, required: ['prompt_text'] }, null);
  assert.deepEqual(explicit.newSchema!.post_requires, [['prompt_text']]);
});

test('the same heading twice gets its own ref; an existing dataset must have a way to dedupe', async () => {
  const body = NANOBANANA_README.replace('2.2. Prompt With Hash Lines', '2.1. Ironing Out Wrinkles');
  const doc = await fixtureDoc(new DocStore(), body);
  const plan = buildPlan(doc, { dataset: 'nb', mapping: MAPPING, filter: { has_code_block: true } }, null);
  const refs = plan.rows.map((r) => r.list_ref);
  assert.equal(new Set(refs).size, refs.length);
  assert.ok(refs.some((r) => String(r).endsWith('#ironing out wrinkles (2)')));

  const fields = (names: string[]) => names.map((name) => ({ name, type: 'text', description: '' }));
  const existing = (extra: any) => ({ key: 'nb', status: 'active', version: 1, fields: fields(['title', 'prompt_text', 'media_url']), dedup_key: [], post_requires: [['prompt_text']], ...extra }) as any;
  assert.throws(() => buildPlan(doc, { dataset: 'nb', mapping: { title: 'heading', prompt_text: 'first_code_block' } }, existing({})), (e: any) => e instanceof PlanError && e.code === 'no_dedup');
  assert.throws(() => buildPlan(doc, { dataset: 'nb', mapping: { title: 'heading', nope: 'heading' } }, existing({ dedup_key: ['title'] })), (e: any) => e.code === 'unknown_field' && /its fields: title, prompt_text, media_url/.test(e.message));
  const ok = buildPlan(doc, { dataset: 'nb', mapping: { title: 'heading', prompt_text: 'first_code_block' } }, existing({ dedup_key: ['title'] }));
  assert.equal(ok.newSchema, null);
  assert.ok(ok.rows.every((r) => !('list_ref' in r)), 'no list_ref column to fill');
  assert.deepEqual(ok.requires, [['prompt_text']], 'the dataset\'s own rule');
  assert.throws(() => buildPlan(doc, { dataset: 'nb', mapping: MAPPING, level: 5 }, null), (e: any) => e.code === 'no_entries');
});

test('the licence is read from the badge when the agent does not give one; the preview clips long text', async () => {
  const doc = await fixtureDoc();
  assert.equal(licenseHint(doc), 'CC BY 4.0');
  assert.equal(licenseHint({ ...doc, text: 'License: MIT' }), 'MIT');
  assert.equal(licenseHint({ ...doc, text: 'nothing here' }), null);
  const plan = buildPlan(doc, { dataset: 'nb', mapping: MAPPING }, null);
  assert.ok(plan.notes.some((n) => /licensed CC BY 4\.0/.test(n)));
  assert.ok(plan.notes.some((n) => /1 entries? lack/.test(n)) || plan.notes.some((n) => /entries lack/.test(n)));
  const p = previewOf(plan, 2, false, 'nb');
  assert.equal(p.importable, 4);
  assert.equal(p.not_postable, 3);
  assert.equal(p.samples.length, 2);
  assert.ok(String((p.samples[0] as any).prompt_text).length <= 301);
  assert.deepEqual(p.post_requires, ['title', 'prompt_text', 'media_url']);
});

// ── the tool and the card ───────────────────────────────────────────────────────────────────────────────────────────

const ctx = (extras: any = {}): ToolContext => ({ runId: 'r', role: 'composer', channelKey: null, extras });

function toolRig(o: { schema?: any; pending?: boolean } = {}) {
  const proposed: any[] = [];
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (/FROM data_schemas WHERE key/.test(sql)) return { rows: o.schema ? [o.schema] : [] };
      if (/FROM pending_actions/.test(sql)) return { rows: o.pending ? [{ id: 'pa-old' }] : [] };
      return { rows: [] };
    },
  } as any;
  const docs = new DocStore();
  const actions = { propose: async (a: any) => { proposed.push(a); return { id: `pa-${proposed.length}`, ...a }; } };
  const tools = Object.fromEntries([...buildImportListTools({ pool, docs, actions: actions as any }), ...buildDocTools({ docs })].map((t) => [t.name, t])) as Record<string, any>;
  return { docs, proposed, queries, tools };
}

test('import_list: a preview and an Apply card whose payload re-runs the same import; nothing is written', async () => {
  const { docs, proposed, tools, queries } = toolRig();
  const doc = await fixtureDoc(docs);
  const seen: any[] = [];
  const r = await tools.import_list.execute(
    ImportListInput.parse({ doc_id: doc.id, dataset: 'nanobanana_prompts', mapping: MAPPING, license: 'CC BY 4.0', filter: { has_code_block: true } }),
    ctx({ chat: { chatId: 'chat-1' }, agent: { id: 'agent-1' }, onAction: (a: any) => seen.push(a.id) }));
  assert.equal(r.ok, true);
  assert.equal(r.pending_action, 'pa-1');
  assert.equal(r.preview.importable, 4);
  assert.equal(r.preview.not_postable, 1);
  assert.equal(r.preview.dataset_exists, false);
  assert.equal(r.preview.samples.length, 3, 'three sample rows by default');
  assert.deepEqual(seen, ['pa-1'], 'the chat shows the card');
  assert.ok(queries.every((q) => !/INSERT|UPDATE|DELETE/.test(q)), 'the preview writes nothing');

  const a = proposed[0];
  assert.equal(a.kind, IMPORT_LIST_KIND);
  assert.equal(a.chatId, 'chat-1');
  assert.equal(a.agentId, 'agent-1');
  assert.match(a.summary, /^Import 4 entries from https:\/\/github\.com\/ZeroLu\/awesome-nanobanana-pro into a new dataset “nanobanana_prompts”\. 1 not postable and skipped \(title, prompt_text, media_url missing\)\. 2 dropped by the filter/);
  assert.equal(a.payload.url, NANOBANANA_URL);
  assert.equal(a.payload.dataset, 'nanobanana_prompts');
  assert.equal(a.payload.level, 3);
  assert.equal(a.payload.expected, 4);
  assert.deepEqual(a.payload.mapping, { ...MAPPING, license: 'const:CC BY 4.0' });
  assert.deepEqual(a.payload.filter, { has_code_block: true });
  assert.deepEqual(a.payload.required, ['title', 'prompt_text', 'media_url']);
  assert.equal(a.payload.new_schema.key, 'nanobanana_prompts');
  assert.deepEqual(a.payload.new_schema.post_requires, [['title'], ['prompt_text'], ['media_url']]);
  assert.ok(a.summary.length < 2000);
  // The payload alone rebuilds the same rows.
  const again = buildPlan(doc, { dataset: a.payload.dataset, mapping: a.payload.mapping, level: a.payload.level, filter: a.payload.filter, required: a.payload.required, license: 'CC BY 4.0' }, null);
  assert.equal(again.rows.length, 4);
  assert.equal(summaryOf(again, 'nanobanana_prompts', false), a.summary);
  assert.deepEqual(payloadOf(again, 'nanobanana_prompts'), a.payload);
});

test('import_list refuses what cannot work: an expired doc, a bad mapping, nothing postable, a card already waiting', async () => {
  const rig = toolRig();
  const doc = await fixtureDoc(rig.docs);
  const base = { dataset: 'nb', sample: 3 };
  assert.equal((await rig.tools.import_list.execute({ ...base, doc_id: 'doc_gone', mapping: MAPPING }, ctx())).error, 'doc_expired');
  const bad = await rig.tools.import_list.execute({ ...base, doc_id: doc.id, mapping: { title: 'headline' } }, ctx());
  assert.equal(bad.error, 'bad_extractor');
  assert.match(bad.details, /first_code_block/);
  const none = await rig.tools.import_list.execute({ ...base, doc_id: doc.id, mapping: MAPPING, filter: { heading_matches: 'nothing like this' } }, ctx());
  assert.equal(none.error, 'nothing_to_import');
  assert.equal(rig.proposed.length, 0);
  const waiting = toolRig({ pending: true });
  const d2 = await fixtureDoc(waiting.docs);
  const w = await waiting.tools.import_list.execute({ ...base, doc_id: d2.id, mapping: MAPPING }, ctx());
  assert.equal(w.error, 'already_pending');
  assert.equal(w.preview.importable, 4);
  assert.equal(waiting.proposed.length, 0);
});

test('import_list into an existing dataset checks the mapping against its fields and uses its rule', async () => {
  const existing = {
    id: 's1', key: 'nb', status: 'active', version: 1, dedup_key: ['list_ref'], post_requires: [['prompt_text'], ['media_url']],
    fields: ['title', 'prompt_text', 'media_url', 'list_ref', 'list_url'].map((name) => ({ name, type: 'text', description: '' })),
  };
  const { docs, tools, proposed } = toolRig({ schema: existing });
  const doc = await fixtureDoc(docs);
  const r = await tools.import_list.execute({ doc_id: doc.id, dataset: 'nb', sample: 3, mapping: { title: 'heading', prompt_text: 'first_code_block', media_url: 'last_image' }, filter: { has_code_block: true } }, ctx());
  assert.equal(r.preview.dataset_exists, true);
  assert.equal(r.preview.importable, 4);
  assert.deepEqual(r.preview.post_requires, ['prompt_text', 'media_url']);
  assert.equal(proposed[0].payload.new_schema, null);
  assert.match(proposed[0].summary, /into dataset “nb”/);
  const wrong = await tools.import_list.execute({ doc_id: doc.id, dataset: 'nb', sample: 3, mapping: { title: 'heading', author: 'link_text_after:Source' } }, ctx());
  assert.equal(wrong.error, 'unknown_field');
});
