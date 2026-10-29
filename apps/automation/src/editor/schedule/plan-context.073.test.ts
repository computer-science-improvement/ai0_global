// Spec 073 FR-011 / A8 / A22 / A54: `ScheduleService.planContext` runs the skeleton check for the plan day and carries the excluded
// instances (matched by `(series, at)`) in the context both planners read. A paused series is not due, so it is not excluded; the
// producible formats come from the service's `formatOk` (a carousel needs slide hosting); a check that cannot run excludes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleService } from './schedule.service';
import { scheduleBlock, dueInstances } from './plan-schedule-rules';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import { makeCard } from '../post/testing/fixtures';
import { zonedToUtc } from '../roles/time';

const CH = '@food';
const TG = `telegram:${CH}`;
const IG = 'instagram:ig1';
const DATE = '2026-10-07';                          // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z');       // 07:00 Kyiv
const card = makeCard({ channelKey: CH, timezone: 'Europe/Kyiv', postsPerDayMin: 1, postsPerDayMax: 4, quietStartHour: 23, quietEndHour: 8 });

const s = (name: string, over: Record<string, unknown> = {}) => ({ name, cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Серія з бібліотеки щодня', ...over });
const playbook = (series: unknown[]): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 0, max: 2 } },
  ],
  series,
});
const net = (pb: Playbook): NetworkCtx => ({
  orchestrator: { id: 'a1', handle: 'chef', mode: 'live' } as any, anchorKey: CH, groupId: 'g1', groupName: 'Food', mode: 'independent',
  resources: [{ ref: TG, platform: 'telegram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } }, { ref: IG, platform: 'instagram', tz: 'America/New_York', quiet: { start: 22, end: 7 } }],
  playbook: pb, playbookVersion: 3, telegramFormats: ['photo', 'text'],
});

function service(o: { formatOk?: (f: string) => boolean; paused?: string[] } = {}) {
  return new ScheduleService({
    pool: { query: async () => ({ rows: [] }) } as any,
    rules: { activeFor: async () => [], pinsOn: async () => [] } as any,
    network: {} as any, agents: {} as any, card: async () => null, plans: {} as any, inbox: { post: async () => {} } as any,
    ...(o.formatOk ? { formatOk: o.formatOk } : {}),
    ...(o.paused ? { pauses: { forChannel: async () => ({ paused: o.paused!.map((name) => ({ name, resourceRef: null, label: name, streak: 3, reason: '' })), recentSkips: [] }) } } : {}),
    now: () => NOW,
  } as any);
}
const plan = (svc: ScheduleService, pb: Playbook, scope: 'single' | 'network' = 'single', date = DATE) => svc.planContext(card, net(pb), date, NOW, scope);

test('A54 a series at 23:30 in the card\'s quiet hours is excluded for the day, matched by its instant; nothing excluded → no `excluded` key', async () => {
  const c = await plan(service(), playbook([s('Нічна', { cadence: 'daily@23:30' }), s('Рецепт дня')]));
  assert.equal(c.excluded?.length, 1);
  const e = c.excluded![0];
  assert.deepEqual([e.series, e.resourceRef, e.code], ['Нічна', TG, 'series_in_quiet_hours']);
  assert.equal(e.at.getTime(), zonedToUtc(DATE, '23:30', 'Europe/Kyiv').getTime());
  assert.match(e.detail, /^series "Нічна" posts at 23:30, inside the quiet hours 23:00-8:00$/);
  assert.deepEqual(dueInstances(c).map((d) => d.series.name), ['Рецепт дня']);
  const clean = await plan(service(), playbook([s('Рецепт дня')]));
  assert.equal('excluded' in clean, false);
});

test('A22 the producible formats come from formatOk: a carousel without slide hosting excludes every instance of the series; with hosting it does not', async () => {
  const pb = playbook([s('Слайди', { format: 'carousel', cadence: 'daily@10:00,18:00' })]);
  const noHosting = await plan(service({ formatOk: (f) => f !== 'carousel' }), pb);
  assert.deepEqual(noHosting.excluded?.map((e) => [e.code, e.at.toISOString()]), [
    ['series_format_unavailable', zonedToUtc(DATE, '10:00', 'Europe/Kyiv').toISOString()],
    ['series_format_unavailable', zonedToUtc(DATE, '18:00', 'Europe/Kyiv').toISOString()],
  ]);
  assert.equal((await plan(service({ formatOk: () => true }), pb)).excluded, undefined);
  assert.equal((await plan(service(), pb)).excluded, undefined, 'without formatOk every implemented format counts');
});

test('A8 an instance with both problems is excluded once, with the first code (the format)', async () => {
  const c = await plan(service({ formatOk: (f) => f !== 'carousel' }), playbook([s('Слайди', { format: 'carousel', cadence: 'daily@23:30' })]));
  assert.deepEqual(c.excluded?.map((e) => e.code), ['series_format_unavailable']);
});

test('a paused series is not due and so not excluded', async () => {
  const pb = playbook([s('Нічна', { cadence: 'daily@23:30' })]);
  assert.equal((await plan(service(), pb)).excluded?.length, 1);
  assert.equal((await plan(service({ paused: ['Нічна'] }), pb)).excluded, undefined);
});

test('scope: the single planner sees the channel\'s own resource; the network planner every resource, each with its own clock', async () => {
  const pb = playbook([s('Нічна', { cadence: 'daily@23:30' }), s('IG вечір', { resource_ref: IG, format: 'ig_photo', cadence: 'daily@22:30' })]);
  const single = await plan(service(), pb, 'single');
  assert.deepEqual(single.excluded?.map((e) => e.series), ['Нічна'], 'Instagram is not in the single planner\'s scope');
  const network = await plan(service(), pb, 'network');
  assert.deepEqual(network.excluded?.map((e) => [e.series, e.resourceRef]).sort(), [['IG вечір', IG], ['Нічна', TG]]);
  const ig = network.excluded!.find((e) => e.resourceRef === IG)!;
  assert.equal(ig.at.getTime(), zonedToUtc(DATE, '22:30', 'America/New_York').getTime(), 'in New York time: Instagram is quiet from 22:00');
});

test('only the plan day is looked at: a weekly series on another weekday is not excluded today but is on its day', async () => {
  const pb = playbook([s('Нічна', { cadence: 'weekly:tue@23:30' })]);
  assert.equal((await plan(service(), pb, 'single', DATE)).excluded, undefined, 'Wednesday');
  assert.equal((await plan(service(), pb, 'single', '2026-10-06')).excluded?.length, 1, 'Tuesday');
});

test('a check that cannot run excludes nothing: a throwing formatOk leaves the context whole', async () => {
  const c = await plan(service({ formatOk: () => { throw new Error('env unreadable'); } }), playbook([s('Рецепт дня')]));
  assert.equal(c.excluded, undefined);
  assert.equal(dueInstances(c).length, 1);
});

test('A53 the planner block, built from the real context, lists the excluded series with the Ukrainian reason and not as due', async () => {
  const c = await plan(service(), playbook([s('Нічна', { cadence: 'daily@23:30' }), s('Рецепт дня')]));
  const b = scheduleBlock(c)!;
  assert.ok(b.includes('- не плануй «Нічна»: Час серії припадає на тихі години'), b);
  assert.doesNotMatch(b, /- серія «Нічна»/);
  assert.match(b, /- серія «Рецепт дня»/);
});
