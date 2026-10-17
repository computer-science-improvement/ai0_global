import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditPost, AuditStory } from '../post/integrity/types';
import { assessStory, CROSS_CHANNEL_HOURS, isEvergreenPost } from './story-match';
import { evergreenKind } from './evergreen-kind';
import { sameTopic, topicKey } from './topic-key';
import { isEvergreenTopic, planTopicErrors, recentTopicHit, recentTopicsBlock, recentTopicsOf } from './recent-topics';
import { StoryContextService } from './story-service';

/** Spec 041 FR-004 (T4): evergreen by code, the topic key, topic_repeat, 72 h siblings, recent topics for ideas and plans. */

function post(id: string, at: string, lead: string, body: string, o: { story?: AuditStory; channel?: string; source?: string } = {}): AuditPost {
  return {
    id, channel: o.channel ?? '@ai', publishedAt: at, timezone: 'Europe/Kyiv', lead,
    text: `${lead}\n\n${body}${o.source ? `\n\n→ Джерело` : ''}`,
    links: [], buttons: [], hashtags: [], media: null, story: o.story ?? {},
    ...(o.source ? { sourceUrl: o.source } : {}),
  };
}

test('evergreen kind: explainer, how-to, glossary, listicle by the title / lead; a sourceless spec post; news is not', () => {
  assert.equal(evergreenKind({ title: 'Що таке токенізація', hasSource: true }), 'glossary');
  assert.equal(evergreenKind({ lead: 'Токенізація — це спосіб розбити текст на шматки', hasSource: true }), 'glossary');
  assert.equal(evergreenKind({ lead: '5 порад, як писати промпти', hasSource: true }), 'listicle');
  assert.equal(evergreenKind({ lead: 'Як моделі бачать текст', hasSource: true }), 'howto');
  assert.equal(evergreenKind({ lead: 'Пояснюємо: контекстне вікно', hasSource: true }), 'explainer');
  assert.equal(evergreenKind({ lead: 'OpenAI випустила GPT-5.5', hasSource: false }), 'explainer', 'no source: nothing dates it');
  assert.equal(evergreenKind({ lead: 'OpenAI випустила GPT-5.5', hasSource: true }), null);
  assert.equal(evergreenKind({ lead: 'OpenAI випустила GPT-5.5', hasSource: true, declared: 'evergreen' }), 'explainer');
  // An export (no story) is judged by its wording only.
  const exp = { ...post('x', '2026-10-01T10:00:00+03:00', 'OpenAI випустила GPT-5.5', 'Текст'), story: undefined };
  assert.equal(isEvergreenPost(exp), false);
  assert.equal(isEvergreenPost(post('y', '2026-10-01T10:00:00+03:00', 'OpenAI випустила GPT-5.5', 'Текст')), true, 'a spec post without a source');
});

test('topic key: stems of title and lead without the evergreen wording; same topic at ≥ 0.6 with ≥ 2 shared (or a one-word Cyrillic topic)', () => {
  const a = topicKey({ title: 'Що таке токенізація і чому моделі рахують токени' });
  const b = topicKey({ title: 'Токенізація простими словами: як моделі рахують токени' });
  assert.ok(a.includes('токені') && a.includes('моделі'), a.join(','));
  assert.ok(!b.includes('простим') && !b.includes('словам'), b.join(','));
  assert.ok(sameTopic(a, b));
  assert.equal(sameTopic(a, topicKey({ title: 'Як працює контекстне вікно у великих моделях' })), null);
  assert.deepEqual(sameTopic(['токені'], ['токені', 'моделі']), ['токені'], 'a one-word Cyrillic topic matches by its stem');
  assert.equal(sameTopic(['gemini'], ['gemini', 'моделі']), null, 'a lone brand is not a topic');
  assert.equal(sameTopic(['токені', 'моделі'], ['токені', 'вікно']), null, 'one shared stem of two is not a topic');
});

test('topic_repeat: an evergreen post on a topic of 30 days is an error; a news post or after 30 days is not', () => {
  const first = post('p1', '2026-10-05T10:00:00+03:00', 'Що таке токенізація', 'Моделі розбивають текст на токени — шматки слів.');
  const again = post('p2', '2026-10-12T10:00:00+03:00', 'Токенізація простими словами', 'Як моделі бачать текст: токени замість літер.');
  const a = assessStory(again, { previous: [first] });
  assert.deepEqual(a.findings.map((f) => [f.code, f.level]), [['topic_repeat', 'error']]);
  assert.match(a.findings[0].message, /30 днів/);
  assert.equal(a.role, 'repeat');
  const late = post('p3', '2026-11-10T10:00:00+03:00', 'Токенізація простими словами', 'Як моделі бачать текст.');
  assert.deepEqual(assessStory(late, { previous: [first] }).findings, []);
  // A sourced news post on the same words is the story guard's business, not a topic repeat.
  const news = post('p4', '2026-10-12T10:00:00+03:00', 'Токенізація моделей Meta стала дешевшою', 'Meta оновила токенізатор.', { source: 'https://ai.meta.com/blog/x' });
  assert.deepEqual(assessStory(news, { previous: [first] }).findings, []);
  // A declared digest is never a topic repeat.
  assert.deepEqual(assessStory({ ...again, story: { kind: 'roundup' } }, { previous: [first] }).findings, []);
});

test('siblings: the same topic on another channel within 72 h is story_cross_channel', () => {
  assert.equal(CROSS_CHANNEL_HOURS, 72);
  const sib = post('s1', '2026-10-05T10:00:00+03:00', 'Що таке токенізація', 'Моделі розбивають текст на токени.', { channel: '@ai_tech' });
  const mine = post('m1', '2026-10-07T09:00:00+03:00', 'Токенізація простими словами', 'Як моделі бачать текст.');
  const a = assessStory(mine, { previous: [], network: [sib] });
  assert.deepEqual(a.findings.map((f) => f.code), ['story_cross_channel']);
  assert.match(a.findings[0].message, /@ai_tech/);
});

test('recent topics: add_idea and the planner refuse an evergreen repeat; news and series pass; the prompt block', () => {
  const recent = recentTopicsOf(['Що таке токенізація\nдовгий текст', 'OpenAI випустила GPT-5.5', 'Що таке токенізація']);
  assert.equal(recent.length, 2, 'duplicates collapse');
  assert.ok(isEvergreenTopic('Токенізація простими словами'));
  assert.ok(!isEvergreenTopic('OpenAI випустила GPT-5.5'));
  assert.equal(recentTopicHit({ title: 'Токенізація простими словами', angle: 'як моделі рахують токенізацію' }, recent)?.title, 'Що таке токенізація');
  const errs = planTopicErrors([
    { time: '10:00', topic: 'Що таке токенізація: пояснюємо на прикладах' },
    { time: '12:00', topic: 'Що таке токенізація: пояснюємо на прикладах', series: 'Глосарій' },
    { time: '14:00', topic: 'OpenAI випустила GPT-5.5 для всіх' },
    { time: '16:00', topic_mode: 'live' },
  ], recent);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^topic_recent: слот 1 \(10:00\)/);
  assert.match(recentTopicsBlock(recent)!, /## Теми за 30 днів[\s\S]*- Що таке токенізація/);
  assert.equal(recentTopicsBlock([]), null);
});

test('planner block: StoryService adds the 30-day topics for the planner only', async () => {
  const svc = new StoryContextService({ activeStories: async () => [], recentTopics: async () => recentTopicsOf(['Що таке токенізація']) } as any);
  const card = { channelKey: '@ai', timezone: 'Europe/Kyiv' };
  assert.match((await svc.activeBlock(card, 'planner', new Date()))!, /Теми за 30 днів/);
  assert.equal(await svc.activeBlock(card, 'executor', new Date()), null);
});
