import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePair, seriesSourceContradictions, seriesSourceToken, type Candidate } from './source-contradiction';
import { NANOBANANA_SKILL, PROMPTHERO_SKILL } from './fixtures/real-skills-1027';
import { mkSeries, promptSeries } from './testing/facts-fixture';

/** Spec 072 FR-003.1, A1, A2, I14: the judgement of a series against a skill, a rule or a steering line. */

const skill = (s: { id: string; name: string; description: string; body: string }): Candidate => ({ kind: 'skill', id: s.id, name: s.name, description: s.description, body: s.body });
const text = (kind: 'rule' | 'steering', id: string, body: string): Candidate => ({ kind, id, name: '', body });

test('path 2: the real prompthero skill (provider=prompthero) against the Prompt series on library:prompts', () => {
  const [x] = seriesSourceContradictions([promptSeries()], [skill(PROMPTHERO_SKILL)]);
  assert.ok(x, 'one contradiction');
  assert.equal(x.path, 'source_in_text', 'skillConflicts finds nothing here (A2); only sourceInSkill hits it');
  assert.equal(x.kind, 'source');
  assert.deepEqual(x.tokens, ['prompthero']);
  assert.match(x.sentence ?? '', /provider=prompthero/);
  assert.match(x.reason, /"prompthero"/);
});

test('path 1: the real nanobanana skill against the Prompt series is a soft conflict through skillConflicts', () => {
  const [x] = seriesSourceContradictions([promptSeries()], [skill(NANOBANANA_SKILL)]);
  assert.ok(x);
  assert.equal(x.path, 'skill_conflicts');
  assert.equal(x.kind, 'soft');
  assert.ok(x.tokens.length > 0, 'the shared series words');
});

test('path 1 hard: a text that rules out the series source', () => {
  const series = mkSeries({ name: 'Рецепт дня', brief: 'Один рецепт з бібліотеки щодня', source: { kind: 'library', table: 'recipes' } });
  const x = judgePair(series, text('rule', '7', 'Рецепти не бери з library:recipes, бери з https://cookpad.com/recipes.'));
  assert.equal(x?.path, 'skill_conflicts');
  assert.equal(x?.kind, 'hard');
});

test('path 1 soft: another source for the same topic', () => {
  const series = mkSeries({ name: 'Рецепт дня', brief: 'Один рецепт з бібліотеки щодня', source: { kind: 'library', table: 'recipes' } });
  const x = judgePair(series, skill({ id: 's1', name: 'cookpad-recipes', description: 'Рецепти для каналу', body: 'Беру рецепти з https://cookpad.com щодня.' }));
  assert.equal(x?.path, 'skill_conflicts');
  assert.equal(x?.kind, 'soft');
});

test('a text that names the series source itself is never a contradiction (keep)', () => {
  const same = skill({ id: 's2', name: 'prompts-library', description: 'Промпти для каналу', body: 'Беру промпти лише з library:prompts.' });
  assert.equal(judgePair(promptSeries(), same), null);
  const echo = text('rule', '9', 'Промпти беремо з library:prompts, один на пост.');
  assert.equal(judgePair(promptSeries(), echo), null);
});

test('a hit with no source token (a url hit such as «через API») never contradicts', () => {
  const c = skill({ id: 's3', name: 'prompt-api', description: 'Промпти для каналу', body: 'Беру пости з API щодня.' });
  assert.equal(judgePair(promptSeries(), c), null);
});

test('path 2 needs a shared topic word: a skill about another subject is left alone', () => {
  const c = skill({ id: 's4', name: 'weather-post', description: 'Погода для каналу', body: 'Беру прогноз з https://openweathermap.org щодня.' });
  assert.equal(judgePair(promptSeries(), c), null);
});

test('a rule or a steering line uses its body for the topic (their names carry none)', () => {
  const x = judgePair(promptSeries(), text('steering', 'set1/0', 'Беру промпти для постів з https://prompthero.com, а не з бази.'));
  assert.equal(x?.candidate.kind, 'steering');
  assert.ok(x);
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

test('a feed series is judged by the host of the feed it reads', () => {
  const series = mkSeries({ name: 'Новини дня', brief: 'Щоденні новини ШІ з фіду', source: { kind: 'feed', ref: 'feed1' } });
  const feedUrl = () => 'https://www.marktechpost.com/feed/';
  const other = skill({ id: 's5', name: 'ai-news-style', description: 'Новини ШІ для каналу', body: 'Беру новини з https://openai.com/blog щодня.' });
  assert.ok(judgePair(series, other, feedUrl));
  const same = skill({ id: 's6', name: 'ai-news-mtp', description: 'Новини ШІ для каналу', body: 'Беру новини з https://www.marktechpost.com щодня.' });
  assert.equal(judgePair(series, same, feedUrl), null);
});

test('one result per (series, candidate) pair, in series order', () => {
  const a = promptSeries();
  const b = promptSeries({ name: 'Prompt 2' });
  const out = seriesSourceContradictions([a, b], [skill(PROMPTHERO_SKILL), skill(NANOBANANA_SKILL)]);
  assert.deepEqual(out.map((x) => `${x.series.name}|${x.candidate.id.slice(0, 8)}`), ['Prompt|7a054c4f', 'Prompt|d3ef5edb', 'Prompt 2|7a054c4f', 'Prompt 2|d3ef5edb']);
});
