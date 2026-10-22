import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alreadyUsedBlock, historyOf, monotonyFindings, MONOTONY_WINDOW, openingPatterns, phrasesOf, sameTopic } from './monotony';
import { recentPostsFromRows } from './recent-posts';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';
import { executorUserPrompt } from '../../roles/prompts';
import type { AuditPost } from '../integrity/types';
import { analogyOpenerCheck } from '../integrity/checks/variety';
import type { EditorCard } from '../../card';
import type { EditorSlot } from '../../repo/editor-plans.repository';

const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'testing', 'channel-logs-2026-10.json'), 'utf8')) as { posts: AuditPost[] };
const byId = (id: string) => fixture.posts.find((p) => p.id === id)!;
/** The channel's posts before `id`, newest first (what checkPublishGuards passes as `previous`). */
const before = (id: string) => {
  const p = byId(id);
  return fixture.posts.filter((x) => x.channel === p.channel && Date.parse(x.publishedAt) < Date.parse(p.publishedAt))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
};
const codes = (id: string) => monotonyFindings(byId(id), before(id)).map((f) => f.code);
const at = (iso: string, text: string, o: Partial<AuditPost> = {}): AuditPost => ({
  id: `t:${iso}`, channel: 'c', publishedAt: iso, timezone: 'Europe/Kyiv', text, links: [], buttons: [], hashtags: [], media: null, ...o,
});

test('T9 openings: «5 X» needs a list of that many items; «Що X:» subheadings; a Cyrillic first word', () => {
  assert.deepEqual(openingPatterns(byId('ai-tekhnolohii:1035')).map((p) => p.key), ['count_list']);
  assert.deepEqual(openingPatterns(byId('ai-tekhnolohii:1043')).map((p) => p.key), ['count_list', 'first_word:почати']);
  // «Три новини дня» is a digest of three paragraphs, not a list: no «5 X».
  assert.deepEqual(openingPatterns(byId('ai-tekhnolohii:1034')).map((p) => p.key), ['first_word:три']);
  assert.deepEqual(openingPatterns(byId('ai-shukaie-novyny-dev:1114')).map((p) => p.label), ['підзаголовок «Що сталося:»']);
  // Names in Latin open news by nature («Epic роздає», «Google…»): not a first-word pattern.
  assert.deepEqual(openingPatterns(byId('birzha-ihor-dev:852')), []);
});

test('T9 golden: the third «5 X» in 3 days and the third «назавжди в бібліотеці» warn; the first two do not', () => {
  assert.deepEqual(codes('ai-tekhnolohii:1035'), []);
  assert.deepEqual(codes('ai-tekhnolohii:1041'), []);
  const third = monotonyFindings(byId('ai-tekhnolohii:1043'), before('ai-tekhnolohii:1043'));
  assert.deepEqual(third.map((f) => [f.code, f.level]), [['monotony_opening', 'warning']]);
  assert.match(third[0].message, /«пʼять безкоштовних…» зі списком із 5 пунктів — 3-й раз за 3 дні/);

  assert.deepEqual(codes('birzha-ihor-dev:844'), []);
  assert.deepEqual(codes('birzha-ihor-dev:847'), []);
  const phrase = monotonyFindings(byId('birzha-ihor-dev:862'), before('birzha-ihor-dev:862'));
  assert.deepEqual(phrase.map((f) => f.code), ['monotony_phrase']);
  assert.equal(phrase[0].excerpt, 'в бібліотеці назавжди');
  // Word order does not matter: «назавжди в бібліотеці» (844) and «в бібліотеці назавжди» (847, 862) are one phrase.
  assert.ok(phrasesOf(byId('birzha-ihor-dev:844')).has('бібліотеці в назавжди'));
  assert.ok(phrasesOf(byId('birzha-ihor-dev:847')).has('бібліотеці в назавжди'));
});

test('T9 negatives: different formats and topics give no monotony warnings', () => {
  // A news post, a deals list, a game announcement, a glossary, an MCP explainer: no repeats in their windows.
  for (const id of ['ai-tekhnolohii:1042', 'ai-tekhnolohii:1046', 'ai-tekhnolohii:1047', 'birzha-ihor-dev:853', 'birzha-ihor-dev:857', 'birzha-ihor-dev:858', 'birzha-ihor-dev:863', 'ai-shukaie-novyny-dev:1131']) {
    assert.deepEqual(codes(id), [], id);
  }
  // «Що X:» three times but spread over 5 days (1023 07.10, 1032 09.10, 1042 12.10): outside the 3-day window.
  assert.ok(openingPatterns(byId('ai-tekhnolohii:1042')).some((p) => p.kind === 'cho_heading'));
  // Without history nothing is found.
  assert.deepEqual(monotonyFindings(byId('ai-tekhnolohii:1043'), []), []);
});

test('T9 history: the last 20 earlier posts, newest first; the post itself and later posts are not history', () => {
  const posts = Array.from({ length: 25 }, (_, i) => at(`2026-10-${String(1 + Math.floor(i / 2)).padStart(2, '0')}T${i % 2 ? '18' : '09'}:00:00+03:00`, `пост ${i}`, { id: `p${i}` }));
  const me = posts[24];
  const h = historyOf(me, [...posts, at('2026-10-20T09:00:00+03:00', 'пізніший', { id: 'later' })]);
  assert.equal(h.length, MONOTONY_WINDOW);
  assert.equal(h[0].id, 'p23');
  assert.ok(!h.some((p) => p.id === 'p24' || p.id === 'later'));
});

test('T9 format + topic: the same format and planner topic twice in one local day warns; another day, format or topic does not', () => {
  const first = at('2026-10-08T09:18:00+03:00', 'Перша роздача.', { format: 'photo', topic: 'Безкоштовні ігри в Epic Games Store' });
  const second = at('2026-10-08T19:00:00+03:00', 'Друга роздача.', { format: 'photo', topic: 'Безкоштовна гра в Epic Games Store сьогодні' });
  const f = monotonyFindings(second, [first]);
  assert.deepEqual(f.map((x) => x.code), ['monotony_format_topic']);
  assert.match(f[0].message, /^photo на цю ж тему вже виходив сьогодні/);
  assert.deepEqual(monotonyFindings({ ...second, format: 'text' }, [first]), []);
  assert.deepEqual(monotonyFindings({ ...second, topic: 'Знижки тижня в Steam' }, [first]), []);
  assert.deepEqual(monotonyFindings({ ...second, publishedAt: '2026-10-09T09:00:00+03:00' }, [first]), []);
  // 23:30 and 00:30 Kyiv are different days even within one UTC day.
  assert.deepEqual(monotonyFindings({ ...second, publishedAt: '2026-10-09T00:30:00+03:00' }, [{ ...first, publishedAt: '2026-10-08T23:30:00+03:00' }]), []);
  // No topic (an export, a live slot): not compared.
  assert.deepEqual(monotonyFindings({ ...second, topic: undefined }, [first]), []);
  assert.ok(sameTopic('Роздача Epic: Out of Sight', 'Epic роздача Out of Sight і TerraScape'));
  assert.ok(!sameTopic('Роздача Epic', 'Знижки Steam'));
});

test('T9 lintPost: history and the slot topic reach the checks; monotony is a warning, never a blocked post', () => {
  const card = makeCard();
  const spec = makeSpec({ format: 'text', media: [] });
  const prev = recentPostsFromRows([
    { id: 'a', scheduled_at: '2026-10-08T06:00:00Z', topic: 'Огляд нових моделей', topic_mode: 'fixed', post_spec: makeSpec({ format: 'text', media: [] }) },
    { id: 'b', scheduled_at: '2026-10-08T07:00:00Z', topic: 'Новини', topic_mode: 'live', post_spec: makeSpec({ format: 'text', media: [] }) },
    { id: 'c', scheduled_at: '2026-10-08T07:30:00Z', topic: 'x', post_spec: { not: 'a spec' } },
  ], { channelKey: '@c', timezone: 'Europe/Kyiv' });
  assert.deepEqual(prev.map((p) => [p.id, p.format, p.topic]), [['a', 'text', 'Огляд нових моделей'], ['b', 'text', undefined]]);
  const r = lintPost(spec, card, { id: 's', channel: '@c', publishedAt: '2026-10-08T12:00:00Z', timezone: 'Europe/Kyiv', ctx: { previous: prev }, topic: 'Огляд нових моделей тижня' });
  assert.ok(r.warnings.some((w) => w.code === 'monotony_format_topic'), JSON.stringify(r.warnings));
  assert.ok(!r.errors.some((e) => e.code.startsWith('monotony')));
});

// ── the writer's «Уже було» block ────────────────────────────────────────────

const card = { channelKey: '@ai_tech', timezone: 'Europe/Kyiv', mode: 'live' } as EditorCard;
const slot = {
  id: 's1', scheduledAt: new Date('2026-10-12T16:00:00Z'), format: 'text', topic: 'Безкоштовні курси з ШІ', angle: null, sourceHints: [], isExperiment: false,
} as unknown as EditorSlot;

test('T9 «Уже було»: built from the same signals — the patterns and phrases used twice or more; null without repeats', () => {
  const now = new Date('2026-10-12T16:00:00Z');
  const block = alreadyUsedBlock(before('ai-tekhnolohii:1043'), now)!;
  assert.match(block, /^## Уже було \(останні 16 постів\) — не повторюй$/m);
  assert.match(block, /«N X» зі списком \(5 термінів, пʼять шаблонів\) ×2/);
  assert.ok(block.length <= 600);
  assert.equal(alreadyUsedBlock([], now), null);
  assert.equal(alreadyUsedBlock([byId('ai-tekhnolohii:1035')], now), null);
  const giveaways = alreadyUsedBlock(before('birzha-ihor-dev:862'), new Date('2026-10-13T15:00:00Z'))!;
  assert.match(giveaways, /- Фрази: .*«в бібліотеці назавжди» ×2/);
});

test('T9 snapshot: the writer prompt carries the «Уже було» block', () => {
  const block = alreadyUsedBlock(before('ai-tekhnolohii:1043'), new Date('2026-10-12T16:00:00Z'));
  const prompt = executorUserPrompt(card, slot, new Date('2026-10-12T15:50:00Z'), null, { alreadyUsed: block });
  assert.equal(prompt, [
    'Слот на 19:00 (зараз 18:50).',
    'Формат: text.',
    'Тема: Безкоштовні курси з ШІ',
    'Підказок джерел немає — обери сам із джерел картки або бібліотеки.',
    '## Уже було (останні 16 постів) — не повторюй',
    '- Початки й структура за 3 дні: «N X» зі списком (5 термінів, пʼять шаблонів) ×2.',
    '- Фрази: «трлн параметрів у» ×2; «параметрів у архітектурі» ×2; «на кожен токен» ×2.',
    'Підготуй пост і опублікуй його через publish_post (він сам перевіряє lint і повертає errors) або пропусти через skip_slot з причиною.',
  ].join('\n'));
  // Without history the prompt is what it was before T9.
  assert.doesNotMatch(executorUserPrompt(card, slot, new Date('2026-10-12T15:50:00Z')), /Уже було/);
});

// ── spec 063 FR-007: the analogy opener as a template ────────────────────────


test('063 slop_analogy_opener: an analogy opener used by ≥ 2 of the last 5 posts is flagged; one earlier use or a plain opener is not', () => {
  const mk = (id: string, text: string): AuditPost => ({
    id, channel: 'c', publishedAt: '2026-10-10T10:00:00Z', timezone: 'Europe/Kyiv', text, links: [], buttons: [], hashtags: [], media: null,
  });
  const analogy = (n: number) => mk(`a${n}`, `Термін ${n} — це як шухляда для речей.\n\nДалі пояснення.`);
  const plain = (n: number) => mk(`p${n}`, `OpenAI випустила модель ${n}.\n\nДеталі.`);
  const now = mk('now', 'Токен — це як цеглинка тексту.\n\nМодель читає цеглинки.');
  const f = analogyOpenerCheck.run(now, { previous: [plain(1), analogy(2), plain(3), analogy(4), plain(5)] });
  assert.deepEqual(f.map((x) => [x.code, x.level]), [['slop_analogy_opener', 'warning']]);
  assert.match(f[0].message, /2 із 5/);
  assert.deepEqual(analogyOpenerCheck.run(now, { previous: [plain(1), analogy(2), plain(3), plain(4), plain(5)] }), [], 'one earlier use');
  assert.deepEqual(analogyOpenerCheck.run(now, { previous: [plain(1), plain(2), plain(3), plain(4), plain(5), analogy(6), analogy(7)] }), [], 'older than the last five');
  assert.deepEqual(analogyOpenerCheck.run(plain(9), { previous: [analogy(1), analogy(2)] }), [], 'this post opens plainly');
  assert.deepEqual(analogyOpenerCheck.run(now, { previous: [] }), [], 'no history');
});
