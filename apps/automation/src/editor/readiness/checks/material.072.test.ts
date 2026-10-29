import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource } from '../../card';
import { makeFacts, mkDataset, mkPlaybook, mkSeries, promptSeries } from '../testing/facts-fixture';
import { LOW_FILL, materialCheck, requiresBody, seriesOnDataset } from './material';

/** Spec 072 FR-003.2, A4, A21, L7: the six material codes. */

const run = (init: Parameters<typeof makeFacts>[0]) => materialCheck.run(makeFacts(init));
const codes = (init: Parameters<typeof makeFacts>[0]) => run(init).map((f) => f.check);
const lib = (ref: string): CardSource => ({ id: `lib-${ref}`, kind: 'library', ref } as CardSource);
const rss: CardSource = { id: 'feed1', kind: 'rss', ref: 'https://example.com/feed.xml' } as CardSource;
const seriesOn = (table: string, over: Record<string, unknown> = {}) => mkSeries({ name: `S ${table}`, source: { kind: 'library', table }, ...over });

// ── dataset_without_series ──────────────────────────────────────────────────────────────────────────────────────────

test('a card library source that no series reads is an error when it is the only material', () => {
  const [x, ...rest] = run({ card: { sources: [lib('prompts')] }, datasets: [mkDataset({ key: 'prompts' })] });
  assert.equal(rest.length, 0, 'bound by the card, healthy dataset: nothing else');
  assert.equal(x.check, 'dataset_without_series');
  assert.equal(x.severity, 'error');
  assert.deepEqual(x.subject, { type: 'channel', id: 'prompts', label: 'prompts', agent: 'fx072', channel: '@fx072' });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=schedule', 'the fix is a series, made on the agent\'s schedule tab');
  assert.equal((x.evidence as any).only_material, true);
});

test('it is a warning when the channel has other material: a feed, a url, an api or a series on another dataset', () => {
  const ds = [mkDataset({ key: 'prompts' })];
  assert.equal(run({ card: { sources: [lib('prompts'), rss] }, datasets: ds })[0].severity, 'warn');
  assert.equal(run({ card: { sources: [lib('prompts'), { id: 'u', kind: 'url', ref: 'https://example.com/a' } as CardSource] }, datasets: ds })[0].severity, 'warn');
  assert.equal(run({ card: { sources: [lib('prompts'), { id: 'a', kind: 'api', ref: 'nasa_apod' } as CardSource] }, datasets: ds })[0].severity, 'warn');
  const other = run({ card: { sources: [lib('prompts')] }, playbook: mkPlaybook([seriesOn('tips')]), datasets: ds }).find((f) => f.check === 'dataset_without_series')!;
  assert.equal(other.severity, 'warn');
  const feedSeries = run({ card: { sources: [lib('prompts')] }, playbook: mkPlaybook([mkSeries({ source: { kind: 'feed', ref: 'feed1' } })]), datasets: ds }).find((f) => f.check === 'dataset_without_series')!;
  assert.equal(feedSeries.severity, 'warn');
});

test('an active series on the dataset, in any letter case, answers the card source; an inactive one does not', () => {
  const ds = [mkDataset({ key: 'prompts' })];
  assert.ok(!codes({ card: { sources: [lib('Prompts')] }, playbook: mkPlaybook([seriesOn('prompts')]), datasets: ds }).includes('dataset_without_series'));
  assert.ok(codes({ card: { sources: [lib('prompts')] }, playbook: mkPlaybook([seriesOn('prompts', { active: false })]), datasets: ds }).includes('dataset_without_series'));
});

test('the subject is the dataset key as stored; a card ref with no dataset keeps its own name; a repeated ref is one finding', () => {
  const x = run({ card: { sources: [lib('PROMPTS'), lib('prompts')] }, datasets: [mkDataset({ key: 'prompts' })] }).filter((f) => f.check === 'dataset_without_series');
  assert.equal(x.length, 1);
  assert.equal(x[0].subject.id, 'prompts');
  const missing = run({ card: { sources: [lib('ghost')] } }).filter((f) => f.check === 'dataset_without_series');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].subject.id, 'ghost');
});

// ── dataset_post_requires_missing ──────────────────────────────────────────────────────────────────────────────────

test('a dataset in use with no post_requires is a warning; an unused one is not looked at', () => {
  const used = run({ playbook: mkPlaybook([seriesOn('tips')]), datasets: [mkDataset({ key: 'tips', postRequires: null })] });
  const x = used.find((f) => f.check === 'dataset_post_requires_missing')!;
  assert.equal(x.severity, 'warn');
  assert.equal(x.subject.id, 'tips');
  assert.equal(x.link, '/app/data/tips');
  assert.deepEqual(codes({ datasets: [mkDataset({ key: 'tips', postRequires: null })] }), []);
  assert.ok(!codes({ playbook: mkPlaybook([seriesOn('tips')]), datasets: [mkDataset({ key: 'tips', postRequires: [['text']] })] }).includes('dataset_post_requires_missing'));
});

// ── requiresBody (A4) ──────────────────────────────────────────────────────────────────────────────────────────────

test('requiresBody: a field is guaranteed only when a whole group is made of body fields', () => {
  assert.equal(requiresBody(null, ['prompt_text']), false);
  assert.equal(requiresBody([['prompt_text']], []), false);
  assert.equal(requiresBody([['prompt_text']], ['prompt_text']), true);
  assert.equal(requiresBody(['prompt_text'], ['prompt_text']), true, 'a bare string is a group of one');
  assert.equal(requiresBody([['prompt_text', 'caption']], ['prompt_text', 'caption']), true, 'any of two body fields is a body');
  assert.equal(requiresBody([['prompt_text', 'media_url']], ['prompt_text']), false, 'a group that may pass on the media alone');
  assert.equal(requiresBody([['page_url'], ['prompt_text', 'media_url']], ['prompt_text']), false);
  assert.equal(requiresBody([['prompt_text'], ['media_url']], ['prompt_text']), true);
  assert.equal(requiresBody([[]], ['prompt_text']), false, 'an empty group guarantees nothing');
});

// ── dataset_low_fill (A4) ──────────────────────────────────────────────────────────────────────────────────────────

const fillDs = (over: Record<string, unknown> = {}) => mkDataset({
  key: 'prompts', roles: { title: 'name', body: 'prompt_text', media: 'media_url' }, fillRate: { prompt_text: 0.12, media_url: 0.99 }, postRequires: [['page_url'], ['prompt_text', 'media_url']], ...over,
} as never);

test('the 083 rule makes a 12% body low fill: an error when a required series reads it', () => {
  const x = run({ playbook: mkPlaybook([promptSeries()]), datasets: [fillDs()] }).find((f) => f.check === 'dataset_low_fill')!;
  assert.equal(x.severity, 'error');
  assert.equal(x.subject.id, 'prompts');
  assert.equal(x.link, '/app/data/prompts');
  assert.match(x.detail, /Only 12% of the rows of prompts/);
  assert.deepEqual(x.evidence, { dataset: 'prompts', body_fields: ['prompt_text'], fill: 0.12, post_requires: [['page_url'], ['prompt_text', 'media_url']], required_series: true });
});

test('it is a warning when the series only suggests the source, or when only the card reads the dataset', () => {
  assert.equal(run({ playbook: mkPlaybook([promptSeries({ source_mode: 'suggested' })]), datasets: [fillDs()] }).find((f) => f.check === 'dataset_low_fill')!.severity, 'warn');
  assert.equal(run({ card: { sources: [lib('prompts')] }, datasets: [fillDs()] }).find((f) => f.check === 'dataset_low_fill')!.severity, 'warn');
});

test('the 095 rule asks for the body, so the same fill is no finding', () => {
  const out = run({ playbook: mkPlaybook([promptSeries()]), datasets: [fillDs({ postRequires: [['prompt_text'], ['media_url']] })] });
  assert.ok(!out.some((f) => f.check === 'dataset_low_fill'));
});

test('no finding at half the rows or more, with no stats, or with no body role', () => {
  const at = (rate: number) => codes({ playbook: mkPlaybook([promptSeries()]), datasets: [fillDs({ fillRate: { prompt_text: rate, media_url: 1 } })] });
  assert.ok(!at(LOW_FILL).includes('dataset_low_fill'), 'exactly half is not low');
  assert.ok(at(LOW_FILL - 0.01).includes('dataset_low_fill'));
  assert.ok(!codes({ playbook: mkPlaybook([promptSeries()]), datasets: [fillDs({ fillRate: null })] }).includes('dataset_low_fill'));
  assert.ok(!codes({ playbook: mkPlaybook([promptSeries()]), datasets: [fillDs({ roles: { title: 'name' } })] }).includes('dataset_low_fill'));
  assert.ok(at(0).includes('dataset_low_fill'));
});

test('with several body fields the best fill counts; a field with no stat counts as empty', () => {
  const two = (fill: Record<string, number>) => codes({ playbook: mkPlaybook([promptSeries()]), datasets: [fillDs({ roles: { body: ['prompt_text', 'caption'] }, fillRate: fill, postRequires: [['page_url']] })] });
  assert.ok(!two({ prompt_text: 0.1, caption: 0.9 }).includes('dataset_low_fill'));
  assert.ok(two({ prompt_text: 0.1 }).includes('dataset_low_fill'));
});

// ── material_exhausted / material_low (L7, A21) ────────────────────────────────────────────────────────────────────

const used = (d: Record<string, unknown>) => run({ playbook: mkPlaybook([seriesOn('tips')]), datasets: [mkDataset({ key: 'tips', ...d } as never)] });

test('a dataset with no unused postable row is an error, and nothing else is said about its pace', () => {
  const out = used({ rows: 40, notPostable: 5, unusedPostable: 0, used28: 28 });
  assert.deepEqual(out.map((f) => f.check), ['material_exhausted']);
  assert.equal(out[0].severity, 'error');
  assert.equal(out[0].link, '/app/data/tips');
  assert.deepEqual(out[0].evidence, { dataset: 'tips', rows: 40, not_postable: 5, unused_postable: 0, reuse: { kind: 'never' } });
  assert.match(out[0].detail, /Every postable row of tips has been used/);
});

test('a dataset with rows left but under 14 days of them is a warning with the days', () => {
  const x = used({ rows: 100, notPostable: 0, unusedPostable: 5, used28: 0 }).find((f) => f.check === 'material_low')!;
  assert.equal(x.severity, 'warn');
  assert.equal((x.evidence as any).runway_days, 5, 'one instance a day');
  assert.match(x.detail, /About 5 days of tips/);
  assert.ok(!used({ rows: 100, notPostable: 0, unusedPostable: 14, used28: 0 }).some((f) => f.check === 'material_low'), '14 days is enough');
  assert.ok(used({ rows: 100, notPostable: 0, unusedPostable: 13, used28: 0 }).some((f) => f.check === 'material_low'));
});

test('the pace is the larger of the schedule and the last 28 days; with neither there is no runway', () => {
  // Two instances a day from the schedule beat a use of 28 rows in 28 days.
  const fast = run({ playbook: mkPlaybook([seriesOn('tips', { cadence: 'daily@10:00,20:00' })]), datasets: [mkDataset({ key: 'tips', unusedPostable: 20, used28: 28 })] });
  assert.equal((fast.find((f) => f.check === 'material_low')!.evidence as any).runway_days, 10);
  // Used 56 in 28 days is 2 a day, more than the one a day of the schedule.
  const history = used({ unusedPostable: 20, used28: 56 });
  assert.equal((history.find((f) => f.check === 'material_low')!.evidence as any).runway_days, 10);
  const none = run({ card: { sources: [lib('tips')] }, datasets: [mkDataset({ key: 'tips', unusedPostable: 2, used28: 0 })] });
  assert.ok(!none.some((f) => f.check === 'material_low' || f.check === 'material_exhausted'));
});

test('a cycle dataset rolls its round: used-up rows are not exhaustion, but rows that can never be posted are', () => {
  const rolling = used({ reusePolicy: { kind: 'cycle', order: 'sequential' }, rows: 10, notPostable: 0, unusedPostable: 0 });
  assert.ok(!rolling.some((f) => f.check === 'material_exhausted'), 'the next round starts by itself');
  assert.equal((rolling.find((f) => f.check === 'material_low')!.evidence as any).runway_days, 10, 'the round is the postable rows');
  const dead = used({ reusePolicy: { kind: 'cycle', order: 'sequential' }, rows: 10, notPostable: 10, unusedPostable: 0 });
  const x = dead.find((f) => f.check === 'material_exhausted')!;
  assert.equal(x.severity, 'error');
  assert.match(x.detail, /repeats in rounds, but none of its 10 rows can be posted/);
  assert.deepEqual(dead.map((f) => f.check), ['material_exhausted']);
  const big = used({ reusePolicy: { kind: 'cycle', order: 'random' }, rows: 400, notPostable: 0, unusedPostable: 0 });
  assert.ok(!big.some((f) => f.check === 'material_low' || f.check === 'material_exhausted'));
});

test('after_days is judged on the rows unused again, like never', () => {
  assert.ok(used({ reusePolicy: { kind: 'after_days', days: 30 }, rows: 50, notPostable: 0, unusedPostable: 0 }).some((f) => f.check === 'material_exhausted'));
});

// ── dataset_order_random ───────────────────────────────────────────────────────────────────────────────────────────

test('a series that wants an order on a dataset that has none is info, on never, after_days and a random cycle', () => {
  const ticket = (reusePolicy: unknown, name = 'Білет дня') => run({ playbook: mkPlaybook([seriesOn('pdr', { name })]), datasets: [mkDataset({ key: 'pdr', reusePolicy } as never)] }).filter((f) => f.check === 'dataset_order_random');
  const never = ticket({ kind: 'never' });
  assert.equal(never.length, 1);
  assert.equal(never[0].severity, 'info');
  assert.deepEqual(never[0].subject, { type: 'channel', id: 'pdr|Білет дня', label: 'pdr / Білет дня', agent: 'fx072', channel: '@fx072' });
  assert.equal(never[0].link, '/app/data/pdr');
  assert.equal(ticket({ kind: 'after_days', days: 90 }).length, 1);
  const random = ticket({ kind: 'cycle', order: 'random' });
  assert.equal(random.length, 1);
  assert.match(random[0].detail, /in random order/);
  assert.equal(ticket({ kind: 'cycle' }).length, 1, 'a cycle written by SQL without an order is random');
  assert.deepEqual(ticket({ kind: 'cycle', order: 'sequential' }), []);
  assert.deepEqual(ticket({ kind: 'never' }, 'Daily tip'), []);
});

test('the brief counts as well as the name, in English too', () => {
  const brief = (b: string) => run({ playbook: mkPlaybook([seriesOn('pdr', { name: 'Quiz', brief: b })]), datasets: [mkDataset({ key: 'pdr' })] }).some((f) => f.check === 'dataset_order_random');
  assert.equal(brief('One lesson a day, in order'), true);
  assert.equal(brief('Chapter by chapter'), true);
  assert.equal(brief('Random facts about cats'), false);
  assert.equal(brief('Розділ за розділом'), true);
});

test('an inactive series, or a series of another dataset, does not ask for an order', () => {
  const off = run({ playbook: mkPlaybook([seriesOn('pdr', { name: 'Білет дня', active: false })]), card: { sources: [lib('pdr')] }, datasets: [mkDataset({ key: 'pdr' })] });
  assert.ok(!off.some((f) => f.check === 'dataset_order_random'));
});

test('seriesOnDataset reads only active library series of the dataset, ignoring case', () => {
  const f = makeFacts({ playbook: mkPlaybook([seriesOn('Tips'), seriesOn('tips', { name: 'Off', active: false }), seriesOn('other'), mkSeries({ name: 'Feed', source: { kind: 'feed', ref: 'feed1' } })]) });
  assert.deepEqual(seriesOnDataset(f, 'tips').map((s) => s.name), ['S Tips']);
});

test('the same code on two datasets gives two keys', () => {
  const out = run({ playbook: mkPlaybook([seriesOn('aa'), seriesOn('bb')]), datasets: [mkDataset({ key: 'aa', unusedPostable: 0 }), mkDataset({ id: 'ds2', key: 'bb', unusedPostable: 0 })] });
  assert.equal(out.length, 2);
  assert.notEqual(out[0].key, out[1].key);
});
