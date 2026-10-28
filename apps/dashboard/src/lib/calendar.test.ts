// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B4: the window, the rows, the chips and the "Ask the agent" pin of the Calendar page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addLabel, agentChips, askFormat, askHint, askProblems, askRule, askUnavailable, buildRows, calendarAgents, dayLabel, dayParts,
  defaultComposeDay, defaultTime, isDay, parseCalendarSearch, isSoonerThan, kyivInstant, kyivToday, markOfSlot, pauseOf, plainText, postChip, postTitle, rangeLabel, resolveFrom,
  sortChips, splitKyiv, visibleChips, windowDays, type CalAgent, type CalChip, type ScheduleState,
} from './calendar';

const TODAY = '2026-10-29';
const NOW = new Date('2026-10-29T09:00:00Z');   // 11:00 in Kyiv (UTC+2: summer time ended on 25 Oct)

const agent = (over: Partial<CalAgent> = {}): CalAgent => ({
  handle: 'space', name: 'Space', emoji: '🚀', mode: 'live', paused: false, channelKey: '@space', ref: 'telegram:@space', ...over,
});

const slot = (over: Record<string, unknown> = {}): any => ({
  id: 's1', resourceRef: 'telegram:@space', at: '2026-10-29T08:00:00Z', date: TODAY, time: '10:00', kind: 'content', status: 'published',
  format: 'text', topic: 'A topic', seriesName: null, scheduleRuleId: null, promo: false, error: null, ...over,
});

const sched = (items: any[], slots: any[], resources: any[] = [{ ref: 'telegram:@space', platform: 'telegram', timezone: 'Europe/Kyiv', formats: ['text', 'photo'] }]): any => ({
  agent: { id: 'a', handle: 'space' }, anchor: '@space', mode: 'independent', now: NOW.toISOString(), from: TODAY, to: addDays(TODAY, 6),
  days: windowDays(TODAY, 7), resources, series: [], rules: [], items, slots, planning: { timezone: 'Europe/Kyiv', planHour: 6, approval: false },
});

const series = (date: string, time: string, name = 'Daily fact', ref = 'telegram:@space'): any => ({
  kind: 'series', resourceRef: ref, date, time, at: '', name, format: 'text', locked: false, origin: 'agent',
});

const post = (over: Record<string, unknown> = {}): any => ({
  id: 'p1', channelId: 'c1', sender: 'bot', botId: 'b1', text: '<b>Webinar</b> tonight\nsecond line', mediaType: 'none', mediaUrl: null,
  mediaPlacement: 'below', buttons: [], scheduledAt: '2026-10-30T09:30:00.000Z', status: 'pending', messageId: null, error: null,
  createdAt: '', updatedAt: '', ...over,
});

const channel = (id: string, key: string | null, over: Record<string, unknown> = {}): any => ({ id, channelKey: key, title: key, username: null, isMine: true, ...over });

// ── window ──

test('days: validation, arithmetic across month and year ends, the 5-day window', () => {
  assert.equal(isDay('2026-10-29'), true);
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay('29-10-2026'), false);
  assert.equal(isDay(undefined), false);
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(windowDays('2026-10-29'), ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(defaultComposeDay(TODAY), '2026-10-30');
});

test('?from=: a valid day near today is kept; junk and far-off days fall back to today', () => {
  assert.equal(resolveFrom('2026-11-03', TODAY), '2026-11-03');
  assert.equal(resolveFrom('2026-10-01', TODAY), '2026-10-01');
  assert.equal(resolveFrom('nope', TODAY), TODAY);
  assert.equal(resolveFrom(undefined, TODAY), TODAY);
  assert.equal(resolveFrom('2026-02-30', TODAY), TODAY);
  assert.equal(resolveFrom('2031-01-01', TODAY), TODAY);
});

test('today is the Kyiv day, not the UTC day', () => {
  assert.equal(kyivToday(new Date('2026-10-28T22:30:00Z')), '2026-10-29');
  assert.equal(kyivToday(new Date('2026-10-29T21:59:00Z')), '2026-10-29');
  assert.equal(kyivToday(new Date('2026-10-29T22:00:00Z')), '2026-10-30');
  // in summer time the day turns an hour earlier in UTC
  assert.equal(kyivToday(new Date('2026-07-01T21:00:00Z')), '2026-07-02');
});

test('labels in English', () => {
  assert.equal(dayLabel('2026-10-29'), 'Thu, 29 Oct');
  assert.equal(dayLabel('2026-11-01'), 'Sun, 1 Nov');
  assert.deepEqual(dayParts('2026-10-31'), { wd: 'Sat', n: '31' });
  assert.equal(rangeLabel(windowDays('2026-10-29')), '29 Oct – 2 Nov');
  assert.equal(rangeLabel([]), '');
  assert.equal(addLabel({ name: 'AI Global' }, '2026-10-29'), 'Add post to AI Global on Thu, 29 Oct');
});

test('Kyiv instants round-trip, in summer and winter time', () => {
  assert.equal(kyivInstant('2026-10-29', '12:00'), '2026-10-29T10:00:00.000Z');
  assert.equal(kyivInstant('2026-07-01', '12:00'), '2026-07-01T09:00:00.000Z');
  assert.deepEqual(splitKyiv('2026-10-29T10:00:00.000Z'), { day: '2026-10-29', time: '12:00' });
  assert.deepEqual(splitKyiv('2026-10-29T22:30:00.000Z'), { day: '2026-10-30', time: '00:30' });
  assert.deepEqual(splitKyiv('2026-07-01T09:00:00.000Z'), { day: '2026-07-01', time: '12:00' });
  assert.deepEqual(splitKyiv(''), { day: '', time: '' });
  assert.deepEqual(splitKyiv('garbage'), { day: '', time: '' });
});

// ── agents ──

test('rows are the top-level orchestrators of a Telegram resource; others are left out', () => {
  const node = (over: Record<string, unknown>): any => ({ id: 'x', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@a', handle: 'a', name: 'A', emoji: null, mode: 'approve', paused: false, ...over });
  const agents = calendarAgents([
    node({}),
    node({ handle: 'm', kind: 'manager', scope: 'system', scopeId: null }),
    node({ handle: 'ig', scopeId: 'instagram:u1' }),
    node({ handle: 'n', scopeId: 'network:main', scope: 'network' }),
    node({ handle: 'b', scopeId: 'telegram:@b', effectiveMode: 'live', paused: true }),
  ]);
  assert.deepEqual(agents.map((a) => [a.handle, a.channelKey, a.mode, a.paused]), [['a', '@a', 'approve', false], ['b', '@b', 'live', true]]);
  assert.deepEqual(calendarAgents(undefined), []);
});

// ── chips ──

test('a slot gets the mark of its status; a series instance with a slot takes the slot\'s status', () => {
  const sc = sched(
    [series(TODAY, '10:00')],
    [slot({ seriesName: 'Daily fact' }), slot({ id: 's2', time: '13:00', status: 'awaiting_approval', topic: 'Approve me' }), slot({ id: 's3', time: '15:00', status: 'failed', error: 'publish_failed: 429' })],
  );
  const chips = agentChips(sc, agent(), TODAY, TODAY);
  assert.deepEqual(chips.map((c) => [c.time, c.mark, c.status, c.target?.type]), [
    ['10:00', 'published', 'Published', 'slot'],
    ['13:00', 'awaiting_approval', 'Awaiting approval', 'slot'],
    ['15:00', 'failed', 'Failed', 'slot'],
  ]);
  // the series chip keeps the series name, the slot's topic goes to the tooltip
  assert.equal(chips[0].title, 'Daily fact');
  assert.match(chips[0].tip, /A topic/);
});

test('missed: a skipped series slot is a miss, unless the skip was bookkeeping or the owner\'s decision', () => {
  const s = (error: string | null, extra: Record<string, unknown> = {}) => slot({ status: 'skipped', seriesName: 'Daily fact', error, ...extra });
  assert.equal(markOfSlot(s('series_source_empty: no rows')), 'missed');
  assert.equal(markOfSlot(s('series_paused')), 'skipped');
  assert.equal(markOfSlot(s('superseded by a new plan')), 'skipped');
  assert.equal(markOfSlot(s('mode_changed')), 'skipped');
  assert.equal(markOfSlot(s('rejected by owner: no')), 'skipped');
  assert.equal(markOfSlot(s('agent @space is paused')), 'skipped');
  // a one-off slot (no series, no pin) that was skipped is just skipped
  assert.equal(markOfSlot(s('no_fresh_item', { seriesName: null })), 'skipped');
  // a pin that failed is a miss
  assert.equal(markOfSlot(slot({ status: 'failed', scheduleRuleId: 'r1', error: 'publish_failed' })), 'missed');
});

test('an older server sends no error: a skipped series slot is skipped, never an invented miss', () => {
  const noError: any = { status: 'skipped', seriesName: 'Daily fact', scheduleRuleId: null };
  assert.equal(markOfSlot(noError), 'skipped');
  assert.equal(markOfSlot({ ...noError, status: 'failed' }), 'missed');
});

test('a series instance without a slot is "not planned" today and later, hidden on past days', () => {
  const sc = sched([series('2026-10-28', '10:00'), series(TODAY, '10:00'), series('2026-10-30', '10:00')], []);
  assert.deepEqual(agentChips(sc, agent(), '2026-10-28', TODAY), []);
  const today = agentChips(sc, agent(), TODAY, TODAY);
  assert.deepEqual(today.map((c) => [c.mark, c.status, c.muted, c.target]), [['not_planned', 'Series · not planned', false, null]]);
  assert.equal(agentChips(sc, agent(), '2026-10-30', TODAY)[0].mark, 'not_planned');
});

test('a paused series, a paused agent and an agent that is off read as quiet, not as "not planned"', () => {
  const sc = sched([series('2026-10-30', '10:00', 'Daily fact'), series('2026-10-30', '12:00', 'Weekly quiz')], []);
  const open = [{ key: 'series:Daily fact' }];
  const chips = agentChips(sc, agent(), '2026-10-30', TODAY, open);
  assert.deepEqual(chips.map((c) => [c.title, c.mark, c.muted, c.status]), [
    ['Daily fact', 'skipped', true, 'Series · paused'],
    ['Weekly quiz', 'not_planned', false, 'Series · not planned'],
  ]);
  assert.equal(agentChips(sc, agent({ mode: 'off' }), '2026-10-30', TODAY)[0].status, 'Series · agent off');
  assert.equal(agentChips(sc, agent({ paused: true }), '2026-10-30', TODAY)[0].status, 'Series · agent paused');
  // a paused resource stops everything on it
  assert.equal(agentChips(sc, agent(), '2026-10-30', TODAY, [{ key: 'resource:telegram:@space' }])[0].muted, true);
});

test('pauseOf: series by name, pin by rule id, resource by ref', () => {
  const open = [{ key: 'series:Daily fact' }, { key: 'rule:r1' }, { key: 'resource:instagram:u' }];
  assert.equal(pauseOf({ kind: 'series', series: 'Daily fact', title: 'Daily fact' }, 'telegram:@space', open)?.key, 'series:Daily fact');
  assert.equal(pauseOf({ kind: 'pin', ruleId: 'r1', title: 'x' }, 'telegram:@space', open)?.key, 'rule:r1');
  assert.equal(pauseOf({ kind: 'series', series: 'Other', title: 'Other' }, 'instagram:u', open)?.key, 'resource:instagram:u');
  assert.equal(pauseOf({ kind: 'series', series: 'Other', title: 'Other' }, 'telegram:@space', open), null);
});

test('a pin without a slot reads "Pin · not planned"; blackouts and frequency rules are not chips', () => {
  const sc = sched([
    { kind: 'pin', ruleId: 'r1', resourceRef: 'telegram:@space', date: '2026-10-31', time: '12:00', at: '', format: 'text', seriesName: null, brief: 'Asked for a recap' },
    { kind: 'blackout', ruleId: 'b1', resourceRef: 'telegram:@space', date: '2026-10-31', time: '13:00', until: '15:00' },
    { kind: 'frequency', ruleId: 'f1', resourceRef: 'telegram:@space', date: '2026-10-31', min: 1, max: 2 },
  ], []);
  const chips = agentChips(sc, agent(), '2026-10-31', TODAY);
  assert.deepEqual(chips.map((c) => [c.kind, c.title, c.status]), [['pin', 'Asked for a recap', 'Pin · not planned']]);
});

test('other platforms are tagged; a reserved slot says what it is; the zone shows when it is not Kyiv\'s', () => {
  const resources = [
    { ref: 'telegram:@space', platform: 'telegram', timezone: 'Europe/Kyiv', formats: [] },
    { ref: 'instagram:u1', platform: 'instagram', timezone: 'America/New_York', formats: [] },
  ];
  const sc = sched([], [
    slot({ id: 'i1', resourceRef: 'instagram:u1', time: '09:00', status: 'planned', topic: 'Reel' }),
    slot({ id: 'r1', kind: 'reserved', promo: true, status: 'planned', time: '17:00', topic: 'Sponsor' }),
  ], resources);
  const chips = agentChips(sc, agent(), TODAY, TODAY);
  assert.deepEqual(chips.map((c) => [c.title, c.status, c.platform, c.kind]), [
    ['Reel', 'Instagram · planned', 'Instagram', 'slot'],
    ['Sponsor', 'Promo · planned', null, 'reserved'],
  ]);
  assert.match(chips[0].tip, /09:00 \(America\/New_York\)/);
  assert.doesNotMatch(chips[1].tip, /Kyiv/);
});

test('a skipped slot\'s tooltip carries the reason in plain words', () => {
  const sc = sched([], [slot({ status: 'skipped', error: 'no_fresh_item: feed empty', seriesName: null })]);
  const [c] = agentChips(sc, agent(), TODAY, TODAY);
  assert.equal(c.mark, 'skipped');
  assert.match(c.tip, /Nothing fresh in the sources: feed empty/);
});

test('chips sort by time, slot before projection at the same minute, the owner\'s post last', () => {
  const mk = (time: string, kind: CalChip['kind'], title: string): CalChip =>
    ({ key: title, kind, mark: 'planned', muted: false, alert: null, time, title, status: '', platform: null, tip: '', target: null });
  assert.deepEqual(sortChips([mk('12:00', 'yours', 'c'), mk('12:00', 'series', 'b'), mk('12:00', 'slot', 'a'), mk('09:00', 'pin', 'z')]).map((c) => c.title), ['z', 'a', 'b', 'c']);
});

test('"+N more": a crowded cell shows what needs the owner, then what is ahead, then what is done, in clock order', () => {
  const chip = (key: string, time: string, mark: CalChip['mark'], over: Partial<CalChip> = {}): CalChip =>
    ({ key, time, mark, kind: 'slot', muted: false, alert: null, target: null, title: key, ...over }) as CalChip;
  const few = Array.from({ length: 5 }, (_, i) => chip(String(i), `0${i}:00`, 'published'));
  assert.deepEqual(visibleChips(few, false), { shown: few, hidden: 0 });
  const day = [
    chip('a', '08:00', 'published'), chip('b', '09:00', 'published'), chip('c', '10:00', 'missed'), chip('d', '11:00', 'published'),
    chip('e', '12:00', 'skipped'), chip('f', '13:00', 'planned'), chip('g', '14:00', 'awaiting_approval'), chip('h', '15:00', 'not_planned'),
    chip('i', '16:00', 'yours', { kind: 'yours', target: { type: 'post', id: 'p', pending: true } }),
    chip('j', '17:00', 'yours', { kind: 'yours', target: { type: 'post', id: 'q', pending: false } }),
    chip('k', '18:00', 'yours', { kind: 'yours', alert: 'danger', target: { type: 'post', id: 'r', pending: false } }),
  ];
  const { shown, hidden } = visibleChips(day, false);
  // attention first (c, g, k), then what is ahead in clock order (f, h); shown in clock order
  assert.deepEqual(shown.map((c) => c.key), ['c', 'f', 'g', 'h', 'k']);
  assert.equal(hidden, 6);
  assert.deepEqual(visibleChips(day, true), { shown: day, hidden: 0 });
  // two attention chips and nothing ahead: the done ones fill up from the morning
  const past = [chip('a', '08:00', 'published'), chip('b', '09:00', 'published'), chip('c', '10:00', 'failed'), chip('d', '11:00', 'published'), chip('e', '12:00', 'published'), chip('f', '13:00', 'missed'), chip('g', '14:00', 'published')];
  assert.deepEqual(visibleChips(past, false).shown.map((c) => c.key), ['a', 'b', 'c', 'd', 'f']);
});

// ── owner posts ──

test('owner post: first line of text without tags, entities decoded, media-only fallbacks', () => {
  assert.equal(plainText('<b>Tom &amp; Jerry</b><br>next'), 'Tom & Jerry\nnext');
  assert.equal(postTitle({ text: '<b>Webinar</b> tonight\nsecond', mediaType: 'none' }), 'Webinar tonight');
  assert.equal(postTitle({ text: '', mediaType: 'photo' }), 'Photo post');
  assert.equal(postTitle({ text: '  ', mediaType: 'none' }), 'Post without text');
  assert.equal(postTitle({ text: 'x'.repeat(200), mediaType: 'none' }).length, 80);
});

test('owner post chip: Kyiv time, "yours", editable only while pending, failed ones raise an alert', () => {
  const c = postChip(post());
  assert.deepEqual([c.kind, c.mark, c.time, c.status, c.alert], ['yours', 'yours', '11:30', 'Yours · scheduled', null]);
  assert.deepEqual(c.target, { type: 'post', id: 'p1', pending: true });
  assert.deepEqual(postChip(post({ status: 'sent' })).target, { type: 'post', id: 'p1', pending: false });
  assert.equal(postChip(post({ status: 'failed', error: 'Bad Request' })).alert, 'danger');
  assert.match(postChip(post({ status: 'failed', error: 'Bad Request' })).tip, /Bad Request/);
  assert.equal(postChip(post({ status: 'unknown' })).alert, 'warning');
});

// ── rows ──

const days = windowDays(TODAY);
const ready = (data: any): ScheduleState => ({ data });

test('rows: one per orchestrator in order, owner posts land on their channel\'s row, "Other channels" last', () => {
  const agents = [agent(), agent({ handle: 'news', name: 'News', channelKey: '@news', ref: 'telegram:@news' })];
  const channels = [channel('c1', '@space'), channel('c2', '@news'), channel('c3', '@recipes'), channel('c4', '@old', { isMine: false })];
  const rows = buildRows({
    agents, channels, days, today: TODAY,
    schedules: { space: ready(sched([], [slot()])), news: ready(sched([], [])) },
    pauses: {},
    posts: [
      post({ id: 'p1', channelId: 'c1' }),                                                 // 30 Oct 11:30 Kyiv on @space
      post({ id: 'p2', channelId: 'c3', scheduledAt: '2026-10-31T07:00:00.000Z' }),        // 31 Oct on an agent-less channel
      post({ id: 'p3', channelId: 'c1', status: 'canceled' }),                             // canceled: left out
      post({ id: 'p4', channelId: 'c1', scheduledAt: '2026-11-20T07:00:00.000Z' }),        // outside the window
      post({ id: 'p5', channelId: 'zzz', scheduledAt: '2026-10-29T15:00:00.000Z' }),       // unknown channel: other row
    ],
  });
  assert.deepEqual(rows.map((r) => [r.key, r.kind]), [['space', 'agent'], ['news', 'agent'], ['other', 'other']]);
  const keys = (cells: CalChip[][]) => cells.map((c) => c.map((x) => x.key));
  assert.deepEqual(keys(rows[0].cells), [['telegram:@space:slot:s1'], ['post:p1'], [], [], []]);
  assert.deepEqual(keys(rows[1].cells), [[], [], [], [], []]);
  assert.deepEqual(keys(rows[2].cells), [['post:p5'], [], ['post:p2'], [], []]);
  // exactly one of the owner's channels has no agent (@old is not the owner's), so "+ Add" there preselects it
  assert.equal(rows[2].composeKey, '@recipes');
  assert.equal(rows[2].sub, '@recipes');
});

test('rows: no "Other channels" row when every channel has an agent and no post is stray', () => {
  const rows = buildRows({ agents: [agent()], channels: [channel('c1', '@SPACE')], days, today: TODAY, schedules: { space: ready(sched([], [])) }, pauses: {}, posts: [post()] });
  assert.deepEqual(rows.map((r) => r.key), ['space']);
  // the channel key matches case-insensitively, so the post sits on the agent's row
  assert.equal(rows[0].cells[1].length, 1);
});

test('rows: two channels without an agent share the row and nothing is preselected', () => {
  const rows = buildRows({ agents: [], channels: [channel('c1', '@a'), channel('c2', '@b')], days, today: TODAY, schedules: {}, pauses: {}, posts: [] });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].composeKey, rows[0].sub], [null, '2 channels without an agent']);
});

test('rows survive nothing loaded: no agents, no channels, no posts', () => {
  assert.deepEqual(buildRows({ agents: [], channels: [], days, today: TODAY, schedules: {}, pauses: {}, posts: [] }), []);
});

test('row state: loading until the schedule answers, an error keeps the row and its owner posts', () => {
  const base = { agents: [agent()], channels: [channel('c1', '@space')], days, today: TODAY, pauses: {}, posts: [post()] };
  const loading = buildRows({ ...base, schedules: {} })[0];
  assert.deepEqual([loading.state, loading.error], ['loading', null]);
  const failed = buildRows({ ...base, schedules: { space: { error: 'no_channel_card' } } })[0];
  assert.deepEqual([failed.state, failed.error, failed.cells[1].length], ['error', 'no_channel_card', 1]);
  const ok = buildRows({ ...base, schedules: { space: ready(sched([], [])) } })[0];
  assert.equal(ok.state, 'ready');
});

test('rows: series pauses of the agent reach its chips', () => {
  const rows = buildRows({
    agents: [agent()], channels: [], days, today: TODAY, posts: [],
    schedules: { space: ready(sched([series('2026-10-30', '10:00')], [])) },
    pauses: { space: [{ key: 'series:Daily fact' }] },
  });
  assert.deepEqual(rows[0].cells[1].map((c) => c.status), ['Series · paused']);
});

// ── Ask the agent ──

test('the agent can be asked unless there is none, it is paused or off, or it has no schedule', () => {
  assert.equal(askUnavailable(agent()), null);
  assert.match(askUnavailable(null)!, /no agent/);
  assert.match(askUnavailable(agent({ paused: true }))!, /paused/);
  assert.match(askUnavailable(agent({ mode: 'off' }))!, /is off/);
  assert.match(askUnavailable(agent(), 'no_channel_card')!, /no schedule/);
});

test('the pin rule: one day, one time, text when the card allows it', () => {
  assert.equal(askFormat(['photo', 'text']), 'text');
  assert.equal(askFormat(['photo', 'quiz']), 'photo');
  assert.equal(askFormat([]), 'text');
  assert.equal(askFormat(undefined), 'text');
  assert.deepEqual(askRule({ ref: 'telegram:@space', day: '2026-10-30', time: '12:00', format: 'text', brief: '  A recap of the week  ' }), {
    resource_ref: 'telegram:@space', kind: 'pin', days: null, at_local: '12:00', format: 'text', brief: 'A recap of the week',
    valid_from: '2026-10-30', valid_until: '2026-10-30', note: 'Asked for from the Calendar',
  });
});

test('the hint follows the mode the agent runs in', () => {
  const a = { time: '12:00', zone: 'Europe/Kyiv', day: '2026-10-30' };
  assert.equal(askHint({ ...a, mode: 'approve', approval: true }), 'The agent writes it at 12:00 Kyiv on Fri, 30 Oct. The draft lands in Inbox → To approve.');
  assert.match(askHint({ ...a, mode: 'shadow', approval: false }), /nothing is published/);
  assert.match(askHint({ ...a, mode: 'live', approval: false }), /writes and publishes/);
  assert.match(askHint({ ...a, zone: 'America/New_York', mode: 'live', approval: false }), /12:00 America\/New_York/);
});

test('asking: a short brief, a past time and a missing day are caught; "now + 5 minutes" is the line', () => {
  const ok = { brief: 'A recap of the week', day: '2026-10-30', time: '12:00', tz: 'Europe/Kyiv', now: NOW, unavailable: null };
  assert.deepEqual(askProblems(ok), []);
  assert.deepEqual(askProblems({ ...ok, brief: 'short' }).map((p) => p.field), ['text']);
  assert.deepEqual(askProblems({ ...ok, brief: 'x'.repeat(601) }).map((p) => p.field), ['text']);
  assert.deepEqual(askProblems({ ...ok, day: TODAY, time: '11:03' }).map((p) => p.field), ['time']);   // 11:00 Kyiv now
  assert.deepEqual(askProblems({ ...ok, day: TODAY, time: '11:06' }), []);
  assert.deepEqual(askProblems({ ...ok, day: '' }).map((p) => p.field), ['time']);
  assert.deepEqual(askProblems({ ...ok, unavailable: 'No agent' }).map((p) => p.field), ['channel']);
  assert.equal(isSoonerThan(TODAY, '10:00', 'Europe/Kyiv', NOW, 5), true);
});

test('the address: an invalid value is dropped, a drawer keeps only the params that belong to it', () => {
  assert.deepEqual(parseCalendarSearch({}), { from: undefined, compose: undefined, channel: undefined, day: undefined, post: undefined });
  assert.equal(parseCalendarSearch({ from: '2026-02-30' }).from, undefined);
  assert.equal(parseCalendarSearch({ from: '2026-11-02' }).from, '2026-11-02');
  assert.deepEqual(parseCalendarSearch({ compose: 'new', channel: ' @space ', day: '2026-10-30', post: 'p1' }),
    { from: undefined, compose: 'new', channel: '@space', day: '2026-10-30', post: undefined });
  assert.equal(parseCalendarSearch({ compose: 'new', day: 'tomorrow' }).day, undefined);
  assert.deepEqual(parseCalendarSearch({ compose: 'edit', post: 'p1', channel: '@x' }),
    { from: undefined, compose: 'edit', channel: undefined, day: undefined, post: 'p1' });
  assert.equal(parseCalendarSearch({ compose: 'edit' }).compose, undefined);           // nothing to edit
  assert.equal(parseCalendarSearch({ compose: 'bogus', channel: '@space' }).channel, undefined);
  assert.equal(parseCalendarSearch({ compose: 1, from: 20261029 }).from, undefined);
});

test('the composer starts at noon on a later day, and on the next whole hour today', () => {
  assert.equal(defaultTime('2026-10-30', NOW), '12:00');
  assert.equal(defaultTime(TODAY, NOW), '12:00');                                       // 11:00 Kyiv now: 11:10 rounds up to 12:00
  assert.equal(defaultTime(TODAY, new Date('2026-10-29T09:45:00Z')), '12:00');          // 11:45 Kyiv: 11:55 rounds up to 12:00
  assert.equal(defaultTime(TODAY, new Date('2026-10-29T09:55:00Z')), '13:00');          // 11:55 Kyiv: 12:05 is over the hour, so 13:00
  assert.equal(defaultTime(TODAY, new Date('2026-10-29T21:30:00Z')), '23:59');          // 23:30 Kyiv: nothing whole is left today
});
