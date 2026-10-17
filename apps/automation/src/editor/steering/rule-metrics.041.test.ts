import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleMetricContradiction } from './rule-metrics';
import { checkSteering, ruleTextProblemsEn, steeringUserPrompt } from './steering-analysis';
import { briefMediaMissing, briefMediaNeed } from '../post/brief-media';
import { lintPost } from '../post/lint-post';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { computeMetrics } from '../setup/setup-metrics';

/** Spec 041 FR-008 (T8): steering rules against the metrics; the brief's picture requirement. */

const ref = (n: number, text: string) => ({ key: `r${n}`, msgId: n, postedAt: '2026-10-10T10:00:00Z', text, mediaType: null, views: 100, reactions: 1, forwards: 0, comments: 0 });
const PLAIN = [
  ref(1, 'Короткий пост без емодзі про нову модель. Деталі в джерелі нижче.'),
  ref(2, 'Ще один пост: що змінилось у версії 2.0 і навіщо оновлюватись.'),
  ref(3, 'Третій пост, теж без жодного смайла, про ціни на підписку.'),
  ref(4, ''),
  ref(5, ''),
];

test('steering: a count the reference does not show is rule_contradicts_metrics with the observed range', () => {
  const c = ruleMetricContradiction('Додавай 2–3 емодзі в кожен пост', PLAIN);
  assert.deepEqual(c && { metric: c.metric, rule: c.rule, observed: c.observed }, { metric: 'emoji', rule: { min: 2, max: 3 }, observed: { min: 0, max: 0, median: 0, posts: 3 } });
  assert.equal(ruleMetricContradiction('Без емодзі, максимум 1 на пост', PLAIN), null, 'fits: 0–1 meets 0');
  assert.equal(ruleMetricContradiction('Пиши коротко: до 300 символів', PLAIN), null);
  assert.equal(ruleMetricContradiction('Довгі пости від 1000 символів', PLAIN)?.metric, 'chars');
  assert.equal(ruleMetricContradiction('Став 3 хештеги в кінці', PLAIN)?.metric, 'hashtags');
  assert.equal(ruleMetricContradiction('Починай з головного факту', PLAIN), null, 'no count, nothing to check');
  assert.equal(ruleMetricContradiction('2–3 емодзі', PLAIN.slice(0, 2)), null, 'too few posts with text to judge');
  // The analysis checklist and the owner's edit both get it.
  const errs = checkSteering({ summary: 'Референс пише коротко й без прикрас, з фактом на початку.', rules: [
    { kind: 'formatting', text: 'Додавай 2–3 емодзі в кожен пост', evidence: { post_ids: ['r1', 'r2'], note: 'емодзі' } },
    { kind: 'hook', text: 'Починай з головного факту, без вступу', evidence: { post_ids: ['r1', 'r2'], note: 'факт першим' } },
    { kind: 'length', text: 'Пиши коротко: до 300 символів', evidence: { post_ids: ['r1', 'r2'], note: 'короткі' } },
  ] } as any, PLAIN as any);
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.match(errs[0], /rules\[0\].*rule_contradicts_metrics: правило каже 2–3 емодзі, а в 3 постах референсу з текстом 0–0/);
  assert.match(ruleTextProblemsEn('Додавай 2–3 емодзі в кожен пост', PLAIN as any)[0], /asks for 2–3 emoji.*3 posts with text have 0–0/);
});

test('steering prompt: posts without text are named, the metrics count only text posts', () => {
  const posts = PLAIN.map((p) => ({ ...p, postedAt: new Date(p.postedAt) }));
  const metrics = computeMetrics(posts.map((p) => ({ ...p, id: p.key, hasMedia: !p.text, reactionsTotal: 1 })) as any, 'Europe/Kyiv');
  const prompt = steeringUserPrompt({
    sourceRef: 'telegram:@ref', title: 'Ref', about: null, subscribers: null, posts: PLAIN as any, metrics,
    target: { ref: 'telegram:@mine', title: null, brief: null, profile: null, ownerRules: [], playbook: null, formatPrefs: null, locks: [] },
  } as any);
  assert.match(prompt, /2 з 5 постів без тексту/);
  assert.match(prompt, /Постів із текстом: 3 з 5/);
});

test('brief media: «опитування з картинкою», «кожен пост — фото»; negations and other formats ask nothing', () => {
  assert.deepEqual([...(briefMediaNeed('Канал про ШІ. Двічі на тиждень — у форматі опитувань із картинкою.') as Set<string>)], ['poll']);
  assert.equal(briefMediaNeed('Кожен пост — одне фото з джерела.'), 'all');
  assert.equal(briefMediaNeed('Пишемо коротко, без картинок.'), null);
  assert.equal(briefMediaNeed('Фото робимо самі, але не щодня.'), null, 'mentions a photo, asks for nothing');
  assert.equal(briefMediaNeed(''), null);
  assert.match(briefMediaMissing('poll', false, 'Опитування завжди з картинкою.')!, /картинку у форматі poll/);
  assert.equal(briefMediaMissing('text', false, 'Опитування завжди з картинкою.'), null);
  assert.equal(briefMediaMissing('poll', true, 'Опитування завжди з картинкою.'), null);
  assert.equal(briefMediaMissing('video', false, 'Кожен пост — фото.'), null, 'a media format carries its own');
});

test('lint: brief_media_missing blocks a bare poll when the brief asks for a picture', () => {
  const brief = 'Канал про ШІ для новачків. Раз на день — у форматі опитувань із картинкою.';
  const poll = makeSpec({ format: 'poll', poll: { question: 'Яку модель ви пробували?', options: ['GPT', 'Claude', 'Gemini'] }, hashtags: [], media: [] } as any);
  const bare = lintPost(poll, makeCard({ brief, formats: { poll: 1, text: 1 } }));
  assert.ok(bare.errors.some((e) => e.code === 'brief_media_missing'), JSON.stringify(bare.errors));
  const pic = lintPost({ ...poll, media: [{ url: 'https://example.com/a.jpg' }] } as any, makeCard({ brief, formats: { poll: 1, text: 1 } }));
  assert.ok(!pic.errors.some((e) => e.code === 'brief_media_missing'));
  assert.ok(!lintPost(poll, makeCard({ brief: 'Канал про ШІ.', formats: { poll: 1 } })).errors.some((e) => e.code === 'brief_media_missing'));
});
