import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDefaultCard } from '../chat/default-card';
import type { EditorCard } from '../card';
import { PlanSlotInput, SubmitPlanInput, validatePlan } from '../roles/plan-rules';
import { NetworkSlotInput, SubmitNetworkPlanInput, validateNetworkPlan } from '../network/network-plan';
import { executorUserPrompt, plannerUserPrompt } from '../roles/prompts';
import { freshnessDeadline, isTimeSensitive, NEWS_LEAD_MS, writeAt, FRESHNESS_GRACE_MS } from '../approval/approval-timing';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { liveSlotLines, liveTopicLabel, noFreshReason, resolveSlotTopic, sourceName, type LiveSpec } from './live-slot';

// Fixed clock (no time-of-day dependence): 2030-05-06 06:00 Kyiv (UTC+3), planning the same day.
const NOW = new Date('2030-05-06T03:00:00Z');
const DATE = '2030-05-06';

function newsCard(over: Partial<EditorCard> = {}): EditorCard {
  return {
    ...makeDefaultCard('@live_unit', 'Енергетика: новини'), mode: 'live', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 7,
    postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, formats: { text: 1, photo: 1 }, brief: 'Новини енергетики України',
    sources: [{ id: 'feed1', kind: 'rss', ref: 'https://energy.example/rss' }, { id: 'lib', kind: 'library', ref: 'recipes' }],
    ...over,
  };
}

test('resolveSlotTopic: fixed needs a topic; no topic → live from the card feeds; a feed series defaults to live', () => {
  assert.deepEqual(resolveSlotTopic({ topic: 'abc' }, { label: 'слот 1' }), { ok: false, error: 'слот 1: потрібна конкретна тема (topic, ≥ 5 символів) або topic_mode "live" з джерелом' });
  const fixed = resolveSlotTopic({ topic: 'Закон про енергоринок' }, { label: 's' });
  assert.deepEqual(fixed, { ok: true, topic: 'Закон про енергоринок', topicMode: 'fixed', live: null });

  const live = resolveSlotTopic({}, { label: 's', cardFeeds: ['feed1'] });
  assert.ok(live.ok && live.topicMode === 'live');
  assert.equal(live.ok && live.topic, 'Свіжа новина з feed1');
  assert.deepEqual(live.ok && live.live, { sources: ['feed1'], brief: 'Найважливіший свіжий матеріал джерела для аудиторії ресурсу', max_age_hours: 6, origin: 'planner' });

  const series = resolveSlotTopic({ topic: 'Головне за ранок' }, { label: 's', seriesSource: { kind: 'feed', ref: 'feed1' }, cardFeeds: ['other'] });
  assert.ok(series.ok && series.topicMode === 'live', 'a feed series is live by default');
  assert.deepEqual(series.ok && series.live?.sources, ['feed:feed1']);
  assert.equal(series.ok && series.live?.brief, 'Головне за ранок', 'the planner topic becomes the brief');

  const explicitFixed = resolveSlotTopic({ topic: 'Головне за ранок', topic_mode: 'fixed' }, { label: 's', seriesSource: { kind: 'feed', ref: 'feed1' } });
  assert.ok(explicitFixed.ok && explicitFixed.topicMode === 'fixed');

  const none = resolveSlotTopic({ topic_mode: 'live' }, { label: 's', cardFeeds: [] });
  assert.equal(none.ok, false);
  const lib = resolveSlotTopic({ topic_mode: 'live', source: ['library:recipes'] }, { label: 's' });
  assert.match(!lib.ok ? lib.error : '', /не з бібліотеки/);
  const api = resolveSlotTopic({ source: ['api:spaceflight_news'], brief: 'Запуски тижня', max_age_hours: 12 }, { label: 's' });
  assert.deepEqual(api.ok && api.live, { sources: ['api:spaceflight_news'], brief: 'Запуски тижня', max_age_hours: 12, origin: 'planner' });
});

test('labels: a source name is the feed site; a news-watch slot is named by its item', () => {
  assert.equal(sourceName('https://www.pravda.com.ua/rss/'), 'pravda.com.ua');
  assert.equal(sourceName('api:nasa_apod'), 'nasa_apod');
  assert.equal(liveTopicLabel(['https://a.example/rss', 'feed:b']), 'Свіжа новина з a.example (+1)');
  assert.equal(liveTopicLabel(['x'], { url: 'https://a/1', title: 'Уряд ухвалив закон' }), 'Свіжа новина: Уряд ухвалив закон');
});

test('validatePlan accepts a live slot without a topic and stores its spec; a fixed slot without a topic is an error', () => {
  const card = newsCard();
  const plan = SubmitPlanInput.parse({
    rationale: 'Ранковий фіксований пост і дві новини наживо.',
    slots: [
      { time: '09:00', format: 'text', topic: 'Як читати рахунок за світло' },
      { time: '14:00', format: 'text', topic_mode: 'live', source: ['feed1'], brief: 'Головна новина енергетики за день' },
      { time: '18:00', format: 'photo' },
    ],
  });
  const v = validatePlan(plan, card, DATE, NOW);
  assert.ok(v.ok, JSON.stringify(v));
  const [fixed, live, implicit] = v.ok ? v.slots : [];
  assert.equal(fixed.topicMode, undefined);
  assert.equal(live.topicMode, 'live');
  assert.equal(live.topic, 'Свіжа новина з feed1');
  assert.deepEqual(live.live, { sources: ['feed1'], brief: 'Головна новина енергетики за день', max_age_hours: 6, origin: 'planner' });
  assert.equal(implicit.topicMode, 'live', 'no topic → live from the card feeds');

  const bad = validatePlan(SubmitPlanInput.parse({ rationale: 'Без теми і без джерела.', slots: [{ time: '10:00', format: 'text', topic_mode: 'fixed' }] }), card, DATE, NOW);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.errors.join('\n') : '', /потрібна конкретна тема/);
  const noFeeds = validatePlan(SubmitPlanInput.parse({ rationale: 'Live без жодного джерела.', slots: [{ time: '10:00', format: 'text' }] }), newsCard({ sources: [] }), DATE, NOW);
  assert.match(!noFeeds.ok ? noFeeds.errors.join('\n') : '', /live-слот без джерела/);
  // The schema itself: topic is optional now, still ≥ 5 chars when given.
  assert.equal(PlanSlotInput.safeParse({ time: '10:00', format: 'text', topic: 'abc' }).success, false);
});

test('validateNetworkPlan accepts a live slot without an idea or series; live is unique only and realises no idea', () => {
  const card = newsCard({ channelKey: '@live_net' });
  const net: any = {
    mode: 'independent', anchorKey: '@live_net', groupName: 'g', groupId: 'g1', orchestrator: { id: 'o' },
    resources: [{ ref: 'telegram:@live_net', platform: 'telegram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 7 } }],
    playbook: { platforms: [{ resource_ref: 'telegram:@live_net', role: 'core', formats: { text: 1 }, per_day: { min: 0, max: 4 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } }], series: [] },
  };
  const o = { net, card, planDate: DATE, weekday: 1, now: NOW, ideas: new Map(), reservedAt: [] as Date[] };
  const ok = validateNetworkPlan(SubmitNetworkPlanInput.parse({
    rationale: 'Новини дня — наживо.', slots: [{ resource_ref: 'telegram:@live_net', time: '12:00', format: 'text', topic_mode: 'live', brief: 'Головне в енергетиці' }],
  }), o);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.ok && ok.slots[0].topicMode, 'live');
  assert.deepEqual(ok.ok && ok.slots[0].live?.sources, ['feed1']);

  const bad = validateNetworkPlan(SubmitNetworkPlanInput.parse({
    rationale: 'Неправильні live-слоти.',
    slots: [
      { resource_ref: 'telegram:@live_net', time: '12:00', format: 'text', topic_mode: 'live', idea_id: '00000000-0000-4000-8000-000000000001', reason: 'test reason' },
      { resource_ref: 'telegram:@live_net', time: '13:30', format: 'text', topic: 'Фіксована тема' },
    ],
  }), o);
  const errs = !bad.ok ? bad.errors.join('\n') : '';
  assert.match(errs, /live-слот не реалізує ідею/);
  assert.match(errs, /потрібен idea_id .* або topic_mode "live"/);
  assert.equal(NetworkSlotInput.safeParse({ resource_ref: 'telegram:@x', time: '10:00', format: 'text' }).success, true, 'topic is optional');
});

const liveSpec: LiveSpec = { sources: ['feed1'], brief: 'Головна новина енергетики', max_age_hours: 6, origin: 'planner' };
const slot = (over: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p', channelKey: '@live_unit', scheduledAt: new Date('2030-05-06T11:00:00Z'), kind: 'content', format: 'text',
  topic: 'Свіжа новина з feed1', angle: null, sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null,
  publishedPostId: null, postSpec: null, renderedPreview: null, error: null, topicMode: 'live', liveSpec, ...over,
});

test('approval mode: a live slot is written 2 h ahead and carries a freshness deadline', () => {
  const card = newsCard();
  const s = slot({ format: 'photo', sourceHints: [], createdAt: new Date('2030-05-05T17:00:00Z') } as any);
  assert.equal(isTimeSensitive(s, { sources: [] }), true, 'live is time-sensitive whatever its format');
  assert.equal(writeAt(s, card).getTime(), s.scheduledAt.getTime() - NEWS_LEAD_MS);
  assert.equal(freshnessDeadline(s, { sources: [] })!.getTime(), s.scheduledAt.getTime() + FRESHNESS_GRACE_MS);
  const fixed = slot({ format: 'photo', topicMode: undefined, liveSpec: undefined, topic: 'Пояснення тарифу', createdAt: new Date('2030-05-05T17:00:00Z') } as any);
  assert.equal(isTimeSensitive(fixed, { sources: [] }), false);
  assert.equal(freshnessDeadline(fixed, { sources: [] }), null);
});

test('executor prompt of a live slot: no fixed topic, the freshness rule, the dedup tool flags, the skip code and the candidates', () => {
  const card = newsCard();
  const scan = { items: [{ title: 'Уряд ухвалив закон', url: 'https://energy.example/1', ageHours: 0.4 }], feedsRead: 1, feedsFailed: 0, otherSources: [], dropped: { old: 2, undated: 0, posted: 1, similar: 0 } };
  const p = executorUserPrompt(card, slot(), new Date('2030-05-06T10:50:00Z'), scan);
  assert.doesNotMatch(p, /^Тема:/m);
  assert.match(p, /live-слот: тема НЕ задана/);
  assert.match(p, /since_hours: 6 і exclude_posted: true/);
  assert.match(p, /skip_slot з code "no_fresh_item"/);
  assert.match(p, /1\. «Уряд ухвалив закон» — https:\/\/energy\.example\/1 \(0\.4 год тому\)/);
  const fixed = executorUserPrompt(card, slot({ topicMode: undefined, liveSpec: undefined, topic: 'Пояснення тарифу' }), NOW);
  assert.match(fixed, /^Тема: Пояснення тарифу$/m);
  const item = liveSlotLines({ ...liveSpec, origin: 'news_watch', item: { url: 'https://energy.example/9', title: 'Новий тариф', published_at: '2030-05-06T11:50:00Z' } }, { tz: 'Europe/Kyiv' });
  assert.ok(item.some((l) => /Код додав цей слот під свіжий матеріал: «Новий тариф» https:\/\/energy\.example\/9 \(опубліковано 14:50\)/.test(l)));
  assert.match(noFreshReason(liveSpec, { ...scan, items: [] }), /^no_fresh_item: no item ≤ 6 h in feed1 .*2 old, 0 undated, 1 posted, 0 similar/);
});

test('planner prompt: the rest of today, kept posts stay, news slots are live on a news resource', () => {
  const p = plannerUserPrompt(newsCard(), new Date('2030-05-06T11:00:00Z'), []);
  assert.match(p, /на решту сьогоднішнього дня/);
  assert.match(p, /залишаються в плані/);
  assert.match(p, /Це новинний ресурс: новинні слоти став live/);
  const plain = plannerUserPrompt(newsCard({ brief: 'Рецепти', title: 'Кухня', sources: [] }), NOW, []);
  assert.doesNotMatch(plain, /новинний ресурс/);
});
