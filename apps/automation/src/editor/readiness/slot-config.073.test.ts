/**
 * Spec 073 FR-009 (T12): `checkSlotConfig` and `repairSlotConfig` are pure. The series is found by name and resource, then by
 * name (A17); a null series list skips the series checks and `[]` with a name is a gone series (A16); a breaker pause is not a
 * problem (A4); the two repairable problems have a repair; `preflight_no_material` is material, not config (L4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSlotConfig, CONFIG_FAILURE_CODES, isConfigCode, isRepairable, repairSlotConfig, resolveSeries, SOURCE_READ_TOOLS,
  type SlotConfigCtx, type SlotConfigSlot,
} from './slot-config';
import { SeriesSchema, type Series } from '../network/playbook';
import { seriesSourceErrors, type SeriesSourceCatalog } from '../network/series';
import { DEFAULT_EXECUTOR_TOOLS, ONBOARDING_CATALOG, pdrCase, promptsCase } from './fixtures/onboarding-1027';

const REF = 'telegram:@chan';
const series = (over: Record<string, unknown> = {}): Series => SeriesSchema.parse({
  name: 'Prompt', cadence: 'daily@19:00', resource_ref: REF, format: 'photo', brief: 'A prompt with its picture each evening',
  source: { kind: 'library', table: 'prompts' }, source_mode: 'required', ...over,
});
const slot = (over: Partial<SlotConfigSlot> = {}): SlotConfigSlot => ({
  channelKey: '@chan', resourceRef: REF, format: 'photo', seriesName: 'Prompt', sourceHints: ['series:Prompt', 'data://prompts/12'], ...over,
});
const ctx = (over: Partial<SlotConfigCtx> = {}): SlotConfigCtx => ({
  series: [series()], catalog: { tables: ['prompts'], feeds: [], entities: { prompts: 'prompt' } }, tools: DEFAULT_EXECUTOR_TOOLS, nextRow: 'data://prompts/13', material: 'ok', ...over,
});
const codes = (s: SlotConfigSlot, c: SlotConfigCtx) => checkSlotConfig(s, c).map((p) => p.code);

// ── nothing to check ─────────────────────────────────────────────────────────────────────────

test('a clean series slot has no problem; the check is pure (the inputs are not touched)', () => {
  const s = slot();
  const c = ctx();
  const before = JSON.stringify([s, c]);
  assert.deepEqual(checkSlotConfig(s, c), []);
  assert.equal(JSON.stringify([s, c]), before);
});

test('A16 a slot that names no series, and an unknown series list, give no series problem; [] with a name is a gone series', () => {
  assert.deepEqual(checkSlotConfig(slot({ seriesName: null }), ctx()), [], 'an improvised slot');
  assert.deepEqual(checkSlotConfig(slot({ seriesName: null, scheduleRuleId: 'rule-1' }), ctx()), [], 'a pin without a series');
  assert.deepEqual(checkSlotConfig(slot({ format: 'text', sourceHints: ['https://x.example/a'] }), ctx({ series: null })), [], 'series === null skips every series check');
  assert.deepEqual(codes(slot(), ctx({ series: [] })), ['config_series_gone']);
});

test('A4 a series switched off, or missing from the playbook, is config_series_gone and nothing else is reported', () => {
  const off = checkSlotConfig(slot({ format: 'text', sourceHints: ['https://x.example/a'] }), ctx({ series: [series({ active: false })], material: 'empty' }));
  assert.deepEqual(off, [{ code: 'config_series_gone', detail: 'series "Prompt" is switched off', series: 'Prompt' }]);
  const missing = checkSlotConfig(slot({ seriesName: 'Removed' }), ctx());
  assert.deepEqual(missing, [{ code: 'config_series_gone', detail: 'series "Removed" is not in the playbook', series: 'Removed' }]);
});

test('A4 a breaker pause is not a problem: the series stays active in the playbook, the pause lives in series_pauses', () => {
  // The context carries no pause at all; an active series (the pause's own state) gives none of the config codes.
  assert.deepEqual(checkSlotConfig(slot(), ctx({ series: [series({ active: true })] })), []);
});

test('A17 the series is found by name and resource first, then by name alone', () => {
  const a = series({ resource_ref: REF, format: 'photo' });
  const b = series({ resource_ref: 'threads:th1', format: 'th_text' });
  const both = ctx({ series: [a, b] });
  assert.equal(resolveSeries(slot(), both)?.format, 'photo');
  assert.equal(resolveSeries(slot({ resourceRef: 'threads:th1' }), both)?.format, 'th_text');
  assert.equal(resolveSeries(slot({ resourceRef: 'instagram:other' }), both)?.format, 'photo', 'no series on that resource: the first of that name');
  assert.equal(resolveSeries(slot({ resourceRef: null }), both)?.format, 'photo', 'a null resource is the channel itself');
  assert.deepEqual(codes(slot({ resourceRef: 'threads:th1', format: 'th_text', sourceHints: ['series:Prompt'] }), both), [], 'checked against the threads series, not the telegram one');
});

// ── the individual checks ────────────────────────────────────────────────────────────────────

test('config_format_mismatch: the slot format differs from the series format; the detail is one English line', () => {
  const p = checkSlotConfig(slot({ format: 'text' }), ctx());
  assert.deepEqual(p.map((x) => x.code), ['config_format_mismatch']);
  assert.equal(p[0].series, 'Prompt');
  assert.match(p[0].detail, /^slot format text differs from series "Prompt" format photo$/);
  assert.ok(!/[Ѐ-ӿ\n]/.test(p[0].detail));
});

test('config_source_mismatch: a required library series whose hints name a URL, a row of another dataset or library:<other>', () => {
  for (const hints of [['https://prompthero.com/prompt/1'], ['data://nanobanana_prompts/5'], ['library:nanobanana_prompts'], ['series:Prompt', 'data://prompts/3', 'HTTP://x.example/p']]) {
    assert.deepEqual(codes(slot({ sourceHints: hints }), ctx()), ['config_source_mismatch'], JSON.stringify(hints));
  }
  const p = checkSlotConfig(slot({ sourceHints: ['https://prompthero.com/prompt/1'] }), ctx());
  assert.match(p[0].detail, /^series "Prompt" requires library:prompts; the slot hints name https:\/\/prompthero\.com\/prompt\/1$/);
});

test('config_source_mismatch is not raised for the right dataset, labels, library://, an empty list, a suggested source or a non-library source', () => {
  for (const hints of [[], ['series:Prompt'], ['data://prompts/12'], ['library:prompts'], ['library:prompts/Landscape'], ['library://prompts_legacy/9'], ['api:nasa_apod', 'feed:x']]) {
    assert.deepEqual(codes(slot({ sourceHints: hints }), ctx()), [], JSON.stringify(hints));
  }
  assert.deepEqual(codes(slot({ sourceHints: ['https://x.example/a'] }), ctx({ series: [series({ source_mode: 'suggested' })] })), [], 'suggested');
  assert.deepEqual(codes(slot({ sourceHints: ['https://x.example/a'] }), ctx({ series: [series({ source: { kind: 'feed', ref: 'feed1' } })], catalog: { tables: [], feeds: ['feed1'] } })), [], 'feed source');
});

test('config_source_missing: the dataset does not exist, is posted in another format, the feed is not in the card, the API is unknown', () => {
  const missing = checkSlotConfig(slot(), ctx({ catalog: { tables: ['other'], feeds: [] } }));
  assert.deepEqual(missing.map((p) => p.code), ['config_source_missing']);
  assert.equal(missing[0].detail, 'series "Prompt": dataset prompts does not exist in the library');
  const format = checkSlotConfig(slot(), ctx({ catalog: { tables: ['prompts'], feeds: [], entities: { prompts: 'quiz_question' } } }));
  assert.equal(format[0].detail, 'series "Prompt": dataset prompts (quiz_question) is posted as quiz, not photo');
  const feed = series({ source: { kind: 'feed', ref: 'feed9' }, source_mode: 'suggested' });
  assert.equal(checkSlotConfig(slot({ sourceHints: [] }), ctx({ series: [feed], catalog: { tables: [], feeds: ['feed1'] } }))[0].detail, 'series "Prompt": feed feed9 is not in the channel card');
  const api = series({ source: { kind: 'api', source: 'no_such_api' }, source_mode: 'suggested' });
  assert.equal(checkSlotConfig(slot({ sourceHints: [] }), ctx({ series: [api], catalog: null }))[0].detail, 'series "Prompt": API no_such_api does not exist');
  assert.deepEqual(codes(slot(), ctx({ catalog: null })), [], 'no catalog: the dataset cannot be judged');
});

test('config_source_missing agrees with seriesSourceErrors (the save-time rule) on every case', () => {
  const cats: Array<SeriesSourceCatalog | null> = [null, { tables: [], feeds: [] }, { tables: ['prompts'], feeds: ['feed1'], entities: { prompts: 'prompt' } }, { tables: ['prompts'], feeds: [], entities: { prompts: 'quiz_question' } }];
  const sources = [undefined, { kind: 'library', table: 'prompts' }, { kind: 'library', table: 'gone' }, { kind: 'feed', ref: 'feed1' }, { kind: 'feed', ref: 'feed2' }, { kind: 'api', source: 'nasa_apod' }, { kind: 'api', source: 'zzz' }, { kind: 'free' }, { kind: 'network_highlights', scope: 'network' }];
  for (const cat of cats) for (const src of sources) for (const format of ['photo', 'quiz']) {
    const s = series({ source: src, format, source_mode: 'suggested' });
    const here = checkSlotConfig(slot({ format, sourceHints: [] }), ctx({ series: [s], catalog: cat, tools: null })).some((p) => p.code === 'config_source_missing');
    assert.equal(here, seriesSourceErrors(s.name, s.source, cat, s.format).length > 0, JSON.stringify([src, format, cat]));
  }
});

test('A50 config_tools_missing: a tool set null skips the check; one tool of the kind is enough; none is a problem; free needs nothing', () => {
  const only = (...names: string[]) => new Set(names);
  assert.deepEqual(codes(slot(), ctx({ tools: null })), []);
  assert.deepEqual(codes(slot(), ctx({ tools: only('query_data', 'publish_post') })), []);
  assert.deepEqual(codes(slot(), ctx({ tools: only('search_library') })), []);
  assert.deepEqual(codes(slot(), ctx({ tools: only('publish_post', 'fetch_feed') })), ['config_tools_missing']);
  const p = checkSlotConfig(slot(), ctx({ tools: only('publish_post') }));
  assert.equal(p[0].detail, 'series "Prompt" reads library; the executor has none of query_data, search_library');
  const feed = series({ source: { kind: 'feed', ref: 'feed1' }, source_mode: 'suggested' });
  const fc = (tools: string[]) => codes(slot({ sourceHints: [] }), ctx({ series: [feed], catalog: { tables: [], feeds: ['feed1'] }, tools: new Set(tools) }));
  assert.deepEqual(fc(['fetch_feed']), []);
  assert.deepEqual(fc(['web_fetch']), []);
  assert.deepEqual(fc(['query_data']), ['config_tools_missing']);
  const api = series({ source: { kind: 'api', source: 'nasa_apod' }, source_mode: 'suggested' });
  assert.deepEqual(codes(slot({ sourceHints: [] }), ctx({ series: [api], tools: only('fetch_api') })), []);
  assert.deepEqual(codes(slot({ sourceHints: [] }), ctx({ series: [api], tools: only('query_data') })), ['config_tools_missing']);
  const hl = series({ source: { kind: 'network_highlights', scope: 'network' }, source_mode: 'suggested' });
  assert.deepEqual(codes(slot({ sourceHints: [] }), ctx({ series: [hl], tools: only('get_network_highlights') })), []);
  assert.deepEqual(codes(slot({ sourceHints: [] }), ctx({ series: [hl], tools: only() })), ['config_tools_missing']);
  const free = series({ source: { kind: 'free' }, source_mode: 'suggested' });
  assert.deepEqual(codes(slot({ sourceHints: [] }), ctx({ series: [free], tools: only() })), [], 'a free series reads nothing');
  assert.deepEqual(codes(slot({ sourceHints: [] }), ctx({ series: [series({ source: undefined, source_mode: 'suggested' })], tools: only() })), [], 'no source at all');
});

test('I13 SOURCE_READ_TOOLS names the tools the default executor really has, for every source kind', () => {
  for (const [kind, tools] of Object.entries(SOURCE_READ_TOOLS)) {
    assert.ok(tools.some((t) => DEFAULT_EXECUTOR_TOOLS.has(t)), kind);
  }
});

test('L4 an empty required source is preflight_no_material, which is material and not a config code', () => {
  const p = checkSlotConfig(slot(), ctx({ material: 'empty' }));
  assert.deepEqual(p.map((x) => x.code), ['preflight_no_material']);
  assert.equal(p[0].detail, 'series "Prompt": required source library:prompts has nothing left on telegram:@chan');
  assert.equal(isConfigCode('preflight_no_material'), false);
  assert.ok(!(CONFIG_FAILURE_CODES as readonly string[]).includes('preflight_no_material'));
  assert.equal(isRepairable('preflight_no_material'), false);
  // 'ok' and unknown material are no problem; a suggested or non-library source is never «empty».
  assert.deepEqual(codes(slot(), ctx({ material: 'ok' })), []);
  assert.deepEqual(codes(slot(), ctx({ material: null })), []);
  assert.deepEqual(codes(slot(), ctx({ material: 'empty', series: [series({ source_mode: 'suggested' })] })), []);
});

test('the problems come in the documented order, all together', () => {
  const all = codes(slot({ format: 'text', sourceHints: ['https://x.example/a'] }), ctx({
    catalog: { tables: [], feeds: [] }, tools: new Set(['publish_post']), material: 'empty',
  }));
  assert.deepEqual(all, ['config_format_mismatch', 'config_source_mismatch', 'config_source_missing', 'config_tools_missing', 'preflight_no_material']);
  for (const c of all) assert.ok(isConfigCode(c) || c === 'preflight_no_material', c);
});

// ── repair ───────────────────────────────────────────────────────────────────────────────────

test('isRepairable is true for exactly config_format_mismatch and config_source_mismatch (I5)', () => {
  for (const c of CONFIG_FAILURE_CODES) assert.equal(isRepairable(c), c === 'config_format_mismatch' || c === 'config_source_mismatch', c);
  assert.equal(isRepairable(null), false);
  assert.equal(isRepairable('lint_failed'), false);
});

test('A7 repairSlotConfig: the format becomes the series format, the hints become series:<name> plus the next row; the note starts with the codes', () => {
  const s = slot({ format: 'text', sourceHints: ['https://prompthero.com/prompt/1'] });
  const c = ctx();
  const fix = repairSlotConfig(s, checkSlotConfig(s, c), c);
  assert.deepEqual(fix, {
    format: 'photo', sourceHints: ['series:Prompt', 'data://prompts/13'],
    note: 'config_format_mismatch: text → photo; config_source_mismatch: hints → series:Prompt, data://prompts/13',
  });
  // The repaired row passes the check.
  assert.deepEqual(checkSlotConfig({ ...s, format: fix.format!, sourceHints: fix.sourceHints! }, c), []);
});

test('A18 without a next row the hints become series:<name> plus the series source (with its category), as the series writes them', () => {
  const s = slot({ sourceHints: ['https://x.example/a'] });
  const c = ctx({ nextRow: null, series: [series({ source: { kind: 'library', table: 'prompts', category: 'Landscape' } })] });
  const fix = repairSlotConfig(s, checkSlotConfig(s, c), c);
  assert.deepEqual(fix.sourceHints, ['series:Prompt', 'library:prompts/Landscape']);
  assert.deepEqual(checkSlotConfig({ ...s, sourceHints: fix.sourceHints! }, c), []);
});

test('A7 nothing repairable is { note: "" } with neither field; other problems are left alone', () => {
  const none = repairSlotConfig(slot(), [], ctx());
  assert.deepEqual(none, { note: '' });
  const s = slot({ format: 'text' });
  const onlyOther = repairSlotConfig(s, [{ code: 'config_tools_missing', detail: 'x' }, { code: 'config_source_missing', detail: 'y' }], ctx());
  assert.deepEqual(onlyOther, { note: '' });
  assert.deepEqual(repairSlotConfig(slot({ seriesName: 'Removed' }), [{ code: 'config_format_mismatch', detail: 'z' }], ctx()), { note: '' }, 'a gone series has nothing to repair to');
  // Only the format: the hints are not in the answer.
  const f = repairSlotConfig(s, checkSlotConfig(s, ctx()), ctx());
  assert.deepEqual(f, { format: 'photo', note: 'config_format_mismatch: text → photo' });
});

// ── the replays of 10-27 ─────────────────────────────────────────────────────────────────────

test('replay @pdr: the text slot of a quiz series is repaired to a quiz at $0; an exhausted dataset is material, not config', () => {
  const c = pdrCase();
  const ctxDefault = c.ctx();
  const problems = checkSlotConfig(c.slot, ctxDefault);
  assert.deepEqual(problems.map((p) => p.code), ['config_format_mismatch']);
  const fix = repairSlotConfig(c.slot, problems, ctxDefault);
  assert.equal(fix.format, 'quiz');
  assert.deepEqual(checkSlotConfig({ ...c.slot, format: fix.format! }, ctxDefault), []);
  // All 866 rows used: the series is dead for now, and the breaker should still see it.
  assert.deepEqual(checkSlotConfig({ ...c.slot, format: 'quiz' }, c.ctx({ material: 'empty' })).map((p) => p.code), ['preflight_no_material']);
  // The same series saved as a text series on a quiz dataset is a source problem (F26).
  const bad = c.ctx({ series: [{ ...c.series[0], format: 'text' }] });
  assert.deepEqual(codes(c.slot, bad), ['config_source_missing']);
});

test('replay @prompts: PromptHero links on a nanobanana series are repaired to the next row; a hidden tools allowlist and a removed series are config', () => {
  const c = promptsCase();
  const problems = checkSlotConfig(c.slot, c.ctx());
  assert.deepEqual(problems.map((p) => p.code), ['config_source_mismatch']);
  assert.match(problems[0].detail, /prompthero\.com/);
  const fix = repairSlotConfig(c.slot, problems, c.ctx());
  assert.deepEqual(fix.sourceHints, ['series:Prompt', 'data://nanobanana_prompts/503']);
  assert.deepEqual(checkSlotConfig({ ...c.slot, sourceHints: fix.sourceHints! }, c.ctx()), []);
  // F28: a card allowlist that removed the read tools.
  assert.deepEqual(codes({ ...c.slot, sourceHints: fix.sourceHints! }, c.ctx({ tools: new Set(['publish_post', 'skip_slot']) })), ['config_tools_missing']);
  // The owner removed the series: the slot costs nothing and is not a miss.
  assert.deepEqual(codes(c.slot, c.ctx({ series: [] })), ['config_series_gone']);
  assert.ok(ONBOARDING_CATALOG.tables.includes('nanobanana_prompts'));
});
