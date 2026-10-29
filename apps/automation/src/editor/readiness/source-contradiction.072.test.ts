import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePair, seriesSourceContradictions, seriesSourceFactOf, seriesSourceToken, type Candidate, type FeedUrlOf } from './source-contradiction';
import type { Series } from '../network/playbook';
import { NANOBANANA_SKILL, PROMPTHERO_SKILL } from './fixtures/real-skills-1027';
import { mkSeries, promptSeries } from './testing/facts-fixture';
import { seriesSourceConflict } from '../agents/skill-warnings';

/**
 * Spec 072 FR-003.1, A1, A2, I14: the judgement of a series against a skill, a rule or a steering line. Since the 073 × 072 merge
 * the judge is 073's `seriesSourceConflict` (the one every skill write runs), so a verdict is `other_source`, `rules_out_source`
 * or `original_with_source`.
 */

const skill = (s: { id: string; name: string; description: string; body: string }): Candidate => ({ kind: 'skill', id: s.id, name: s.name, description: s.description, body: s.body });
const text = (kind: 'rule' | 'steering', id: string, body: string): Candidate => ({ kind, id, name: '', body });
/** `judgePair` with one series as the whole set: its verdict, or null. */
const pair = (s: Series, c: Candidate, feedUrl?: FeedUrlOf) => judgePair([s], c, feedUrl)[0] ?? null;
const recipes = () => mkSeries({ name: 'Рецепт дня', brief: 'Один рецепт з бібліотеки щодня', source: { kind: 'library', table: 'recipes' } });

test('the real prompthero skill (provider=prompthero) against the Prompt series on library:prompts names another source', () => {
  const [x, more] = seriesSourceContradictions([promptSeries()], [skill(PROMPTHERO_SKILL)]);
  assert.ok(x, 'one contradiction');
  assert.equal(more, undefined);
  assert.equal(x.path, 'series_source_conflict');
  assert.equal(x.kind, 'other_source');
  assert.ok(x.tokens.includes('prompthero'));
  assert.match(x.sentence ?? '', /provider=prompthero/, 'the first sentence that names the clashing source');
  assert.match(x.reason, /"prompthero"/);
});

test('the real nanobanana skill against the Prompt series names the GitHub collection as its source', () => {
  const [x] = seriesSourceContradictions([promptSeries()], [skill(NANOBANANA_SKILL)]);
  assert.ok(x);
  assert.equal(x.kind, 'other_source');
  assert.ok(x.tokens.includes('github'));
});

test('a text that rules out the series source is rules_out_source', () => {
  const x = pair(recipes(), text('rule', '7', 'Не бери рецепти з library:recipes.'));
  assert.equal(x?.kind, 'rules_out_source');
  assert.deepEqual(x?.tokens, ['recipes']);
  assert.equal(x?.sentence, 'Не бери рецепти з library:recipes.');
  assert.match(x?.reason ?? '', /rules out "recipes"/);
});

test('another source for the same series is other_source; the first conflict is the verdict', () => {
  const soft = pair(recipes(), skill({ id: 's1', name: 'cookpad-recipes', description: 'Рецепти для каналу', body: 'Беру рецепти з https://cookpad.com щодня.' }));
  assert.equal(soft?.kind, 'other_source');
  assert.deepEqual(soft?.tokens, ['cookpad']);
  const both = pair(recipes(), text('rule', '7', 'Рецепти не бери з library:recipes, бери з https://cookpad.com/recipes.'));
  assert.equal(both?.kind, 'other_source', 'other_source comes before rules_out_source');
});

test('origin=original on what a library series reads: a rule is judged; a skill is left to origin_original_with_source', () => {
  const rule = pair(promptSeries(), text('rule', '8', 'Для кожного промпта став origin=original.'));
  assert.equal(rule?.kind, 'original_with_source');
  const s = skill({ id: 's7', name: 'prompt-origin', description: 'Промпти', body: 'Для рядків library став origin=original.' });
  assert.equal(pair(promptSeries(), s), null, 'the doctor says it once, as origin_original_with_source');
});

test('a text that names the series source itself is never a contradiction (keep)', () => {
  const same = skill({ id: 's2', name: 'prompts-library', description: 'Промпти для каналу', body: 'Беру промпти лише з library:prompts.' });
  assert.equal(pair(promptSeries(), same), null);
  const echo = text('rule', '9', 'Промпти беремо з library:prompts, один на пост.');
  assert.equal(pair(promptSeries(), echo), null);
});

test('a hit with no source token (a url hit such as «через API») never contradicts', () => {
  const c = skill({ id: 's3', name: 'prompt-api', description: 'Промпти для каналу', body: 'Беру пости з API щодня.' });
  assert.equal(pair(promptSeries(), c), null);
});

test('which series a text is about: the only required one, else a shared topic word (as the write path chooses)', () => {
  const weather = skill({ id: 's4', name: 'weather-post', description: 'Погода для каналу', body: 'Беру прогноз з https://openweathermap.org щодня.' });
  assert.equal(seriesSourceContradictions([promptSeries()], [weather]).length, 1, 'the only required series: every text is about it');
  assert.deepEqual(seriesSourceContradictions([promptSeries(), promptSeries({ name: 'Prompt 2' })], [weather]), [], 'two required series and no shared word');
  assert.deepEqual(seriesSourceContradictions([promptSeries({ source_mode: 'suggested' })], [weather]), [], 'a suggested series needs a shared word');
  const hero = skill(PROMPTHERO_SKILL);
  assert.equal(seriesSourceContradictions([promptSeries({ source_mode: 'suggested' })], [hero]).length, 1, 'the prompthero skill shares «промпт»');
});

test('a rule or a steering line uses its body for the topic; «з X, а не з бази» names X', () => {
  const x = pair(promptSeries(), text('steering', 'set1/0', 'Беру промпти для постів з https://prompthero.com, а не з бази.'));
  assert.equal(x?.candidate.kind, 'steering');
  assert.equal(x?.kind, 'other_source');
  assert.deepEqual(x?.tokens, ['prompthero']);
});

test('a free, network_highlights or absent source, and an inactive series, get nothing (A29)', () => {
  const c = [skill(PROMPTHERO_SKILL)];
  assert.deepEqual(seriesSourceContradictions([promptSeries({ source: { kind: 'free' } })], c), []);
  assert.deepEqual(seriesSourceContradictions([promptSeries({ source: { kind: 'network_highlights' } })], c), []);
  assert.deepEqual(seriesSourceContradictions([promptSeries({ source: undefined })], c), []);
  assert.deepEqual(seriesSourceContradictions([promptSeries({ active: false })], c), []);
});

test('source tokens: the library table, the host label of a feed, the api name; an unresolved feed id has none', () => {
  assert.equal(seriesSourceToken(promptSeries()), 'prompts');
  assert.equal(seriesSourceToken(mkSeries({ source: { kind: 'api', source: 'Nasa_Apod' } })), 'nasa_apod');
  const feed = mkSeries({ source: { kind: 'feed', ref: 'feed1' } });
  assert.equal(seriesSourceToken(feed), null);
  assert.equal(seriesSourceToken(feed, () => 'https://www.marktechpost.com/feed/'), 'marktechpost');
  assert.equal(seriesSourceToken(mkSeries({ source: { kind: 'free' } })), null);
  assert.equal(seriesSourceToken(mkSeries()), null);
});

test('the fact handed to 073: a feed by its address, a sourceless or free series none', () => {
  assert.deepEqual(seriesSourceFactOf(promptSeries()), { series: 'Prompt', kind: 'library', ref: 'prompts', format: 'photo', brief: promptSeries().brief });
  const feed = mkSeries({ source: { kind: 'feed', ref: 'feed1' } });
  assert.equal(seriesSourceFactOf(feed, () => 'https://www.marktechpost.com/feed/')?.ref, 'https://www.marktechpost.com/feed/');
  assert.equal(seriesSourceFactOf(feed), null, 'an unresolved card source id has no host: nothing to judge');
  assert.equal(seriesSourceFactOf(mkSeries({ source: { kind: 'free' } })), null);
  assert.equal(seriesSourceFactOf(mkSeries()), null);
});

test('a feed series is judged by the host of the feed it reads', () => {
  const series = mkSeries({ name: 'Новини дня', brief: 'Щоденні новини ШІ з фіду', source: { kind: 'feed', ref: 'feed1' } });
  const feedUrl = () => 'https://www.marktechpost.com/feed/';
  const other = skill({ id: 's5', name: 'ai-news-style', description: 'Новини ШІ для каналу', body: 'Беру новини з https://openai.com/blog щодня.' });
  assert.equal(pair(series, other, feedUrl)?.kind, 'other_source');
  const same = skill({ id: 's6', name: 'ai-news-mtp', description: 'Новини ШІ для каналу', body: 'Беру новини з https://www.marktechpost.com щодня.' });
  assert.equal(pair(series, same, feedUrl), null);
});

test('one result per (series, candidate) pair, in series order', () => {
  const a = promptSeries();
  const b = promptSeries({ name: 'Prompt 2' });
  const out = seriesSourceContradictions([a, b], [skill(PROMPTHERO_SKILL), skill(NANOBANANA_SKILL)]);
  assert.deepEqual(out.map((x) => `${x.series.name}|${x.candidate.id.slice(0, 8)}`), ['Prompt|7a054c4f', 'Prompt|d3ef5edb', 'Prompt 2|7a054c4f', 'Prompt 2|d3ef5edb']);
});

// ── W1 integration review: one judgement per text, as the write path makes it ────────────────────────────────────────

test('two required series with different sources: a skill that names each one\'s own source contradicts neither (as the write path accepts it)', () => {
  const news = mkSeries({ name: 'AI news', format: 'text', brief: 'AI news digest', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' }, source_mode: 'required' });
  const prompt = mkSeries({ name: 'Prompt of the day', format: 'text', brief: 'one prompt', source: { kind: 'library', table: 'prompts' }, source_mode: 'required' });
  const both = skill({ id: 's1', name: 'news-and-prompts', description: 'AI news and prompt of the day posts', body: 'Для новин бери матеріал з marktechpost.com. Промпт дня бери з data://prompts/.' });
  const facts = [news, prompt].map((s) => seriesSourceFactOf(s)!);
  assert.deepEqual(seriesSourceConflict(both.body, facts, { name: both.name, description: both.description }), [], 'the write path accepts it');
  assert.deepEqual(seriesSourceContradictions([news, prompt], [both]), [], 'so the doctor finds nothing');
  // A third source is still another source for both series the skill is about.
  const third = skill({ id: 's2', name: both.name, description: both.description ?? '', body: `${both.body} Для новин також бери з https://openai.com/blog.` });
  const out = seriesSourceContradictions([news, prompt], [third]);
  assert.deepEqual(out.map((x) => [x.series.name, x.kind, x.tokens]), [['AI news', 'other_source', ['openai']], ['Prompt of the day', 'other_source', ['openai']]]);
  assert.equal(seriesSourceConflict(third.body, facts, { name: third.name, description: third.description })[0]?.reason, 'other_source', 'the write path refuses it too');
});

test('ruling out one series\' source is said of that series only', () => {
  const news = mkSeries({ name: 'AI news', format: 'text', brief: 'AI news digest', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' }, source_mode: 'required' });
  const prompt = mkSeries({ name: 'Prompt of the day', format: 'text', brief: 'one prompt', source: { kind: 'library', table: 'prompts' }, source_mode: 'required' });
  const c = text('rule', '3', 'Новини й промпти пишемо самі. Не бери новини з marktechpost.com.');
  const out = seriesSourceContradictions([news, prompt], [c]);
  assert.deepEqual(out.map((x) => [x.series.name, x.kind, x.tokens]), [['AI news', 'rules_out_source', ['marktechpost']]]);
});

test('a suggested series is judged with the sources of the required series the text is about counted as its own', () => {
  const prompt = promptSeries();
  const evening = promptSeries({ name: 'Prompt evening', source_mode: 'suggested', source: { kind: 'library', table: 'evening_prompts' } });
  const own = skill({ id: 's10', name: 'prompts-day', description: 'Промпти для каналу', body: 'Промпти бери з data://prompts/.' });
  assert.deepEqual(seriesSourceContradictions([prompt, evening], [own]), [], 'the required source is the text\'s own for the suggested series too');
  // The required series is judged exactly as the write path judges the skill (it knows only the required series), the
  // suggested one with both sources as the text's own.
  const both = skill({ id: 's9', name: 'prompts-both', description: 'Промпти для каналу', body: 'Промпти бери з data://prompts/ і з data://evening_prompts/.' });
  assert.deepEqual(seriesSourceContradictions([prompt, evening], [both]).map((x) => [x.series.name, x.kind, x.tokens]), [['Prompt', 'other_source', ['evening_prompts']]]);
  assert.equal(seriesSourceConflict(both.body, [seriesSourceFactOf(prompt)!], { name: both.name, description: both.description })[0]?.reason, 'other_source');
});
