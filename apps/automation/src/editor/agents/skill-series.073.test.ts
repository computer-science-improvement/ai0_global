/**
 * Spec 073 FR-012 / I14: `seriesSourceConflict` is the pure judge of a skill body against the required series of its agent, and
 * `skillWriteProblems` puts it beside the checks the chat tools always ran. The old Prompt skill of @ai0_prompts_dev («origin=original»,
 * PromptHero) passed `sourceRefusal` and `originRefusal`; only the series knows it is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  originRefusal, seriesSourceConflict, seriesSourceTokens, skillWriteProblems, sourceRefusal, type SeriesSourceFact,
} from './skill-warnings';
import { seriesSourceFacts } from './series-sources';
import { SeriesSchema } from '../network/playbook';

const PROMPT: SeriesSourceFact = { series: 'Prompt', kind: 'library', ref: 'nanobanana_prompts', format: 'photo', brief: 'Промпт для генерації зображень' };
const NEWS: SeriesSourceFact = { series: 'Новини ШІ', kind: 'feed', ref: 'https://www.marktechpost.com/feed/', format: 'text', brief: 'Головні новини про ШІ за день' };

/** The old skill: no read-source word in the sentence, so `originRefusal` lets it through. */
const OLD_PROMPT_SKILL = '# Промпти\nДля кожного промпта став origin=original, джерело PromptHero.';

test('the old Prompt skill passes the two chat-tool checks and is caught by the series', () => {
  assert.equal(sourceRefusal(OLD_PROMPT_SKILL), null);
  assert.equal(originRefusal(OLD_PROMPT_SKILL), null);
  const found = seriesSourceConflict(OLD_PROMPT_SKILL, [PROMPT], { name: 'prompt-origin' });
  assert.deepEqual(found.map((c) => [c.code, c.reason, c.series]), [['series_source_conflict', 'original_with_source', 'Prompt']]);
  assert.match(found[0].detail, /origin=original/);
  assert.match(found[0].detail, /library:nanobanana_prompts/);
});

test('a skill that names the dataset the series reads is fine; another dataset is another_source', () => {
  assert.deepEqual(seriesSourceConflict('Рядок data://nanobanana_prompts/503 бери і публікуй дослівно.', [PROMPT]), []);
  assert.deepEqual(seriesSourceConflict('Рядок library:nanobanana_prompts бери і став origin=library.', [PROMPT]), []);
  const other = seriesSourceConflict('Рядок data://prompts_chat/12 бери і публікуй дослівно.', [PROMPT]);
  assert.deepEqual(other.map((c) => [c.reason, c.tokens]), [['other_source', ['prompts_chat']]]);
  assert.match(other[0].detail, /prompts_chat/);
  assert.match(other[0].detail, /library:nanobanana_prompts/);
});

test('a skill that rules out the source a series reads is rules_out_source', () => {
  const r = seriesSourceConflict('Не бери nanobanana — він застарів.', [PROMPT]);
  assert.deepEqual(r.map((c) => [c.reason, c.tokens]), [['rules_out_source', ['nanobanana_prompts']]]);
});

test('origin=original is fine for own text, with a negation or beside another origin, and without a library or feed series', () => {
  assert.deepEqual(seriesSourceConflict('Для власних дописів став origin=original.', [PROMPT]), []);
  assert.deepEqual(seriesSourceConflict('Ніколи не став origin=original на промпт із джерела.', [PROMPT]), []);
  assert.deepEqual(seriesSourceConflict('Рядок бібліотеки: origin=library та library_ref; текст сам — origin=original.', [PROMPT]), []);
  assert.deepEqual(seriesSourceConflict('Став origin=original.', [{ ...PROMPT, kind: 'api', ref: 'nasa_apod' }]), []);
});

test('a feed series: its own host is fine, another host is another_source, a link shown in the post is not a source', () => {
  assert.deepEqual(seriesSourceConflict('Новини беремо з https://www.marktechpost.com/feed/ — коротко.', [NEWS]), []);
  assert.deepEqual(seriesSourceConflict('Бери новини з https://reuters.com/world', [NEWS]).map((c) => [c.reason, c.tokens]), [['other_source', ['reuters']]]);
  assert.deepEqual(seriesSourceConflict('Підпис: автор і посилання https://t.me/channel_x наприкінці.', [NEWS]), []);
  assert.deepEqual(seriesSourceTokens(NEWS), ['marktechpost']);
  assert.deepEqual(seriesSourceTokens(PROMPT), ['nanobanana_prompts']);
  assert.deepEqual(seriesSourceTokens({ kind: 'api', ref: 'NASA_APOD' }), ['nasa_apod']);
});

test('with several series a skill is judged against the ones it is about; with none it is judged against nothing', () => {
  const both = [PROMPT, NEWS];
  // about the prompts: the library series is the one it is judged against
  assert.deepEqual(seriesSourceConflict('Став origin=original.', both, { name: 'prompt-style' }).map((c) => c.series), ['Prompt']);
  // about the news: the feed series
  assert.deepEqual(seriesSourceConflict('Став origin=original.', both, { name: 'news-style' }).map((c) => c.series), ['Новини ШІ']);
  // about recipes: neither series is about it
  assert.deepEqual(seriesSourceConflict('Став origin=original.', both, { name: 'recipe-style', description: 'Рецепти' }), []);
  // no series at all
  assert.deepEqual(seriesSourceConflict(OLD_PROMPT_SKILL, []), []);
});

test('a skill that is clean gets no problem', () => {
  assert.deepEqual(skillWriteProblems('# Стиль\nПиши коротко. Підпис — одне речення.', [PROMPT]), []);
  assert.deepEqual(skillWriteProblems('# Стиль\nПиши коротко.'), []);
});

test('skillWriteProblems: the chat-tool refusals keep their shape; the series one has the same shape and an English warning', () => {
  const BAD_ORIGIN = 'Бери промпт з бібліотеки датасету і публікуй його з origin=original, вказуючи автора.';
  const [o] = skillWriteProblems(BAD_ORIGIN);
  assert.equal(o.code, 'origin_original_with_source');
  assert.deepEqual(o.refusal, originRefusal(BAD_ORIGIN));
  assert.match(o.warning, /origin_mismatch/);
  assert.deepEqual(skillWriteProblems(BAD_ORIGIN, [PROMPT], { name: 'prompt-origin' }).map((p) => p.code), ['origin_original_with_source'], 'the same finding is not said twice');

  const BAD_SOURCE = 'Бери промпти з https://prompthero.com/ щодня.';
  const [s] = skillWriteProblems(BAD_SOURCE);
  assert.equal(s.code, 'source_belongs_in_import');
  assert.deepEqual(s.refusal, sourceRefusal(BAD_SOURCE));

  const [c] = skillWriteProblems(OLD_PROMPT_SKILL, [PROMPT], { name: 'prompt-origin' });
  assert.equal(c.code, 'series_source_conflict');
  assert.equal(c.refusal.error, 'series_source_conflict');
  assert.equal(typeof c.refusal.details, 'string');
  assert.equal(typeof c.refusal.hint, 'string');
  assert.match(c.warning, /^The skill contradicts a series: /);
});

test('seriesSourceFacts keeps the active required series that read a library, a feed or an api, and nothing else', () => {
  const s = (over: Record<string, unknown>) => SeriesSchema.parse({ name: 'Серія тест', cadence: 'daily@10:00', resource_ref: 'telegram:@x', format: 'text', brief: 'Опис серії для тесту', ...over });
  const facts = seriesSourceFacts([
    s({ name: 'Бібліотека', source: { kind: 'library', table: 'pdr_questions_2025' }, source_mode: 'required', format: 'quiz' }),
    s({ name: 'Фід', source: { kind: 'feed', ref: 'https://example.org/rss' }, source_mode: 'required' }),
    s({ name: 'Апі', source: { kind: 'api', source: 'nasa_apod', params: {} }, source_mode: 'required' }),
    s({ name: 'Лише порада', source: { kind: 'library', table: 'recipes' }, source_mode: 'suggested' }),
    s({ name: 'Вимкнена', source: { kind: 'library', table: 'recipes' }, source_mode: 'required', active: false }),
    s({ name: 'Вільна', source: { kind: 'free' }, source_mode: 'required' }),
    s({ name: 'Без джерела', source_mode: 'required' }),
    s({ name: 'Хайлайти', source: { kind: 'network_highlights', scope: 'network' }, source_mode: 'required' }),
  ]);
  assert.deepEqual(facts.map((f) => [f.series, f.kind, f.ref, f.format]), [
    ['Бібліотека', 'library', 'pdr_questions_2025', 'quiz'],
    ['Фід', 'feed', 'https://example.org/rss', 'text'],
    ['Апі', 'api', 'nasa_apod', 'text'],
  ]);
});
