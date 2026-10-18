import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canPreview, feedsOf, liveLine, upcomingName, upcomingTitle, plannedAtLine, plannedEveningBefore, planScheduleNote, previewCostHint, previewFootnote, previewRunning,
  runLabel, siteList, siteName, skipReason, type SlotPreviewView,
} from './slot-plan';

const KYIV = 'Europe/Kyiv';
// 2030-05-06 is in Kyiv summer time (UTC+3): 11:00Z = 14:00 Kyiv.
const AT = '2030-05-06T11:00:00Z';
const live = { sources: ['https://www.pravda.com.ua/rss/', 'feed1', 'api:nasa_apod'], brief: 'top story', max_age_hours: 6, origin: 'planner' as const };

test('site names: a feed URL is its host, a card source id resolves to its feed, api:x is "x API"', () => {
  assert.equal(siteName('https://www.pravda.com.ua/rss/'), 'pravda.com.ua');
  assert.equal(siteName('feed1', { feed1: 'https://rbc.ua/static/rss/all.rus.rss.xml' }), 'rbc.ua');
  assert.equal(siteName('feed:feed1', { feed1: 'https://rbc.ua/rss' }), 'rbc.ua');
  assert.equal(siteName('feed1'), 'feed1');
  assert.equal(siteName('api:nasa_apod'), 'nasa_apod API');
  assert.equal(siteList(['https://a.example/rss', 'https://www.a.example/other', 'feed2'], { feed2: 'https://b.example/f' }), 'a.example, b.example');
  assert.equal(siteList([]), 'its feeds');
});

test('a live slot reads as its scheduled tool call, in the resource zone', () => {
  const s = { at: AT, format: 'photo', liveSpec: live };
  assert.equal(liveLine(s, KYIV, { feed1: 'https://rbc.ua/rss' }), 'At 14:00: fetch pravda.com.ua, rbc.ua, nasa_apod API → pick the freshest item (≤ 6 h) → write photo');
  assert.equal(liveLine(s, 'America/New_York'), 'At 07:00: fetch pravda.com.ua, feed1, nasa_apod API → pick the freshest item (≤ 6 h) → write photo');
  assert.equal(liveLine({ at: AT, format: 'text', liveSpec: null }, KYIV), '');
});

test('skip reasons: no_fresh_item, critic reject / failure, replaced, owner, agent; anything else is a plain note', () => {
  assert.deepEqual(skipReason('no_fresh_item: no item <= 6 h in pravda.com.ua (4 old)'), { code: 'no_fresh_item', label: 'Nothing fresh in the sources', detail: 'no item <= 6 h in pravda.com.ua (4 old)' });
  assert.equal(skipReason('critic_rejected: reject (sense 1): off topic')!.label, 'Rejected by the critic');
  assert.equal(skipReason('critic_rejected: reject (sense 1): off topic')!.detail, 'reject (sense 1): off topic');
  assert.equal(skipReason('critic_failed: timeout')!.code, 'critic_failed');
  assert.equal(skipReason('superseded by a new plan')!.code, 'superseded');
  assert.equal(skipReason('skipped by owner: duplicate')!.detail, 'duplicate');
  assert.equal(skipReason('skipped by agent: no verified source')!.code, 'agent');
  // Spec 049 FR-002: a slot skipped because its resource's connection is broken.
  assert.deepEqual(skipReason('resource_unavailable: token_invalid — token expired on 2026-08-17'),
    { code: 'unavailable', label: 'Connection broken', detail: 'token_invalid — token expired on 2026-08-17' });
  assert.deepEqual(skipReason('retry after max_steps'), { code: 'other', label: 'Note', detail: 'retry after max_steps' });
  assert.equal(skipReason(null), null);
});

test('planned at / by and when the agent plans (approval: the evening before)', () => {
  assert.equal(plannedAtLine('2030-05-06T03:02:00Z', KYIV), 'Planned at 06:02 Kyiv');
  assert.equal(plannedAtLine(null, KYIV), null);
  assert.equal(runLabel('planner'), 'planner run');
  assert.equal(runLabel('idea_reviewer'), 'idea reviewer run');
  assert.equal(runLabel(null), 'agent run');
  assert.match(planScheduleNote({ planHour: 6, timezone: KYIV, approval: false }), /^Planned daily at 06:00 Kyiv/);
  assert.match(planScheduleNote({ planHour: 6, timezone: KYIV, approval: true, batchHour: 20 }), /^In approval: each day is planned the evening before at 20:00 Kyiv/);
  // 2030-05-05 20:00 Kyiv = 17:00Z: the evening batch of 2030-05-06.
  assert.equal(plannedEveningBefore('2030-05-05T17:00:00Z', '2030-05-06', KYIV), true);
  assert.equal(plannedEveningBefore('2030-05-06T03:00:00Z', '2030-05-06', KYIV), false);
  // 22:30Z on 05-05 is already 05-06 in Kyiv: same day, not the evening before.
  assert.equal(plannedEveningBefore('2030-05-05T22:30:00Z', '2030-05-06', KYIV), false);
});

const preview = (o: Partial<SlotPreviewView> = {}): SlotPreviewView => ({
  status: 'ready', platform: 'telegram', preview: '<b>Post</b>', spec: null, critic: null, reason: null, warnings: [], runId: 'r',
  costUsd: 0.0061, startedAt: '2030-05-06T06:14:00Z', finishedAt: '2030-05-06T06:15:00Z', ...o,
});

test('the Preview button: only fixed planned content slots; a running preview is stale after 10 min; the cost hint', () => {
  const base = { at: AT, format: 'text', topic: 'Topic', status: 'planned' };
  assert.equal(canPreview(base), true);
  assert.equal(canPreview({ ...base, status: 'shadowed' }), false);
  assert.equal(canPreview({ ...base, kind: 'reserved' }), false);
  assert.equal(canPreview({ ...base, topicMode: 'live', liveSpec: live }), false);
  assert.equal(canPreview({ ...base, treatment: 'adapt' }), false);
  assert.equal(canPreview({ ...base, treatment: 'unique' }), true);
  const started = Date.parse('2030-05-06T06:14:00Z');
  assert.equal(previewRunning(preview({ status: 'running' }), started + 60_000), true);
  assert.equal(previewRunning(preview({ status: 'running' }), started + 11 * 60_000), false);
  assert.equal(previewRunning(preview(), started), false);
  assert.equal(previewRunning(null), false);
  assert.equal(previewCostHint(0.0061), '≈ $0.0061');
  assert.equal(previewCostHint(0.024), '≈ $0.024');
  assert.equal(previewCostHint(0.0004), '≈ $0.0004');
  assert.equal(previewCostHint(null), 'about one executor run');
  assert.match(previewFootnote(preview(), KYIV), /^Dry run at 09:15 Kyiv · \$0\.0061 · nothing was published/);
});

test('feeds of a card and the Overview Upcoming rows: a live slot reads as its fetch-and-write, a news-watch slot as its item', () => {
  assert.deepEqual(feedsOf({ sources: [{ id: 'f1', kind: 'rss', ref: 'https://a.example/rss' }, { id: 'l1', kind: 'library', ref: 'recipes' }] }), { f1: 'https://a.example/rss' });
  assert.deepEqual(feedsOf(null), {});
  const base = { kind: 'slot' as const, name: 'Fresh story from pravda.com.ua', format: 'photo', resourceRef: 'telegram:@news', agent: 'news', owner: false };
  assert.equal(upcomingName({ ...base, topicMode: 'live', live }), 'Live: fetch pravda.com.ua, feed1, nasa_apod API → freshest → photo');
  assert.equal(upcomingName({ ...base, topicMode: 'live', live: { ...live, origin: 'news_watch', item: { url: 'https://x.example/a', title: 'Comet passes Earth' } } }), 'Live: Comet passes Earth');
  assert.equal(upcomingName({ ...base, name: 'How to read a bill', topicMode: 'fixed' }), 'How to read a bill');
  assert.match(upcomingTitle({ ...base, topicMode: 'live', live }), /^Live slot · telegram:@news · @news · fetch pravda\.com\.ua.* \(≤ 6 h\) → write photo$/);
  assert.equal(upcomingTitle({ ...base, kind: 'pin', owner: true }), 'Pinned post · telegram:@news · @news · set by you');
  assert.equal(upcomingTitle({ ...base, topicMode: 'fixed' }), 'Planned slot · telegram:@news · @news');
});
