/**
 * Spec 073 FR-011 (T13; A8, A22, I6, L3): `checkPlanSkeleton` is pure. It checks only active series: a format the resource cannot
 * produce, a cadence time inside the resource's quiet hours, and a weekday's instances above the card's daily maximum. Without a day
 * it gives one problem per series and code; with a day, one per due instance with `at`. `producibleFormats` and
 * `skeletonResourcesOf` build the resources the check reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlanSkeleton, EXCLUDING_CODES, producibleFormats, SKELETON_CODES, skeletonResourcesOf, skeletonResourcesWith, type SkeletonResource } from './plan-skeleton';
import { isConfigCode } from './slot-config';
import { SeriesSchema, type Series } from '../network/playbook';
import { implementedFormats } from '../platform/capabilities';
import { makeCard } from '../post/testing/fixtures';
import { zonedToUtc } from '../roles/time';
import { reasonFor } from '../reasons/catalogue';

const CH = '@food';
const TG = `telegram:${CH}`;
const IG = 'instagram:ig1';
const DATE = '2026-10-07'; // Wednesday
const card = makeCard({ channelKey: CH, timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, postsPerDayMax: 3 });

const series = (o: Record<string, unknown>): Series => SeriesSchema.parse({
  name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора', ...o,
});
const tg = (over: Partial<SkeletonResource> = {}): SkeletonResource => ({ ref: TG, platform: 'telegram', formats: producibleFormats('telegram'), ...over });
const ig = (over: Partial<SkeletonResource> = {}): SkeletonResource => ({ ref: IG, platform: 'instagram', formats: producibleFormats('instagram'), tz: 'America/New_York', quiet: { start: 22, end: 7 }, ...over });
const codes = (p: Array<{ code: string }>) => p.map((x) => x.code);

test('A22 producibleFormats: every implemented format, minus what formatOk refuses', () => {
  assert.deepEqual(producibleFormats('telegram'), implementedFormats('telegram'));
  assert.ok(producibleFormats('telegram').includes('carousel'));
  const noHosting = producibleFormats('telegram', (f) => f !== 'carousel');
  assert.ok(!noHosting.includes('carousel') && noHosting.includes('photo'));
  assert.ok(producibleFormats('instagram').includes('ig_photo'));
  assert.ok(!producibleFormats('instagram').includes('photo'), 'a Telegram format is not an Instagram one');
});

test('I6 skeletonResourcesOf: the formats follow the env (a carousel needs slide hosting), the clock is the resource\'s own', () => {
  const res = [{ ref: TG, platform: 'telegram' as const }, { ref: IG, platform: 'instagram' as const, tz: 'America/New_York', quiet: { start: 22, end: 7 } }];
  const bare = skeletonResourcesOf(card, res, () => undefined);
  assert.ok(!bare[0].formats.includes('carousel'), 'no SUPABASE_* → no carousel');
  assert.deepEqual([bare[0].tz, bare[0].quiet], ['Europe/Kyiv', { start: 23, end: 8 }], 'the Telegram resource takes the card\'s clock');
  assert.deepEqual([bare[1].tz, bare[1].quiet], ['America/New_York', { start: 22, end: 7 }]);
  const hosted = skeletonResourcesOf(card, res, (k) => ({ SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', SUPABASE_CAROUSEL_BUCKET: 'b' } as Record<string, string>)[k]);
  assert.ok(hosted[0].formats.includes('carousel'));
  assert.deepEqual(skeletonResourcesOf(card, res)[0].formats, implementedFormats('telegram'), 'without an env every implemented format counts');
  assert.deepEqual(skeletonResourcesWith(card, res, (f) => f === 'text')[0].formats, ['text']);
});

test('series_format_unavailable: a format the resource cannot produce; a producible one passes; no day → one problem, no `at`', () => {
  const s = series({ format: 'carousel', cadence: 'daily@10:00,18:00' });
  const noHosting = [tg({ formats: producibleFormats('telegram', (f) => f !== 'carousel') })];
  const out = checkPlanSkeleton(card, null, [s], noHosting);
  assert.deepEqual(codes(out), ['series_format_unavailable'], 'one per series, not per instance');
  assert.equal(out[0].series, 'Рецепт дня');
  assert.equal(out[0].at, undefined);
  assert.match(out[0].detail, /^series "Рецепт дня" format carousel cannot be produced on telegram:@food \(available: /);
  assert.deepEqual(checkPlanSkeleton(card, null, [s], [tg()]), [], 'with hosting the carousel is fine');
  assert.deepEqual(checkPlanSkeleton(card, null, [series({ format: 'ig_photo', resource_ref: IG, cadence: 'daily@12:00' })], [ig()]), []);
  assert.deepEqual(codes(checkPlanSkeleton(card, null, [series({ format: 'photo', resource_ref: IG, cadence: 'daily@12:00' })], [ig()])), ['series_format_unavailable'], 'a Telegram format on Instagram');
});

test('A8 with a day: one problem per due instance of that day, each with `series` and `at` in the resource\'s zone', () => {
  const s = series({ format: 'carousel', cadence: 'daily@10:00,18:00' });
  const out = checkPlanSkeleton(card, null, [s], [tg({ formats: ['photo'] })], DATE);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.series), ['Рецепт дня', 'Рецепт дня']);
  assert.deepEqual(out.map((p) => p.at), [zonedToUtc(DATE, '10:00', 'Europe/Kyiv').toISOString(), zonedToUtc(DATE, '18:00', 'Europe/Kyiv').toISOString()]);
  assert.equal(out[0].at, '2026-10-07T07:00:00.000Z', 'Kyiv is UTC+3 on 7 October');
  // A weekly series that is not due that weekday has no instance, so no problem.
  const tuesday = series({ format: 'carousel', cadence: 'weekly:tue@10:00' });
  assert.deepEqual(checkPlanSkeleton(card, null, [tuesday], [tg({ formats: ['photo'] })], DATE), []);
  assert.equal(checkPlanSkeleton(card, null, [tuesday], [tg({ formats: ['photo'] })], '2026-10-06').length, 1, 'but it is due on the Tuesday');
});

test('series_in_quiet_hours: a cadence time inside the quiet hours, per series without a day, per instance with one', () => {
  const s = series({ cadence: 'daily@12:00,23:30' });
  const without = checkPlanSkeleton(card, null, [s], [tg()]);
  assert.deepEqual(codes(without), ['series_in_quiet_hours']);
  assert.equal(without[0].series, 'Рецепт дня');
  assert.equal(without[0].at, undefined);
  assert.match(without[0].detail, /posts at 23:30, inside the quiet hours 23:00-8:00/);
  const withDay = checkPlanSkeleton(card, null, [s], [tg()], DATE);
  assert.equal(withDay.length, 1, 'only the 23:30 instance');
  assert.equal(withDay[0].at, zonedToUtc(DATE, '23:30', 'Europe/Kyiv').toISOString());
  assert.deepEqual(checkPlanSkeleton(card, null, [series({ cadence: 'daily@07:59' })], [tg()]).map((p) => p.code), ['series_in_quiet_hours'], 'quiet runs until 08:00');
  assert.deepEqual(checkPlanSkeleton(card, null, [series({ cadence: 'daily@08:00,22:59' })], [tg()]), [], 'the edges are outside');
});

test('series_in_quiet_hours reads the RESOURCE\'s quiet hours: Instagram\'s own window, the card\'s for a resource without one', () => {
  const s = series({ resource_ref: IG, format: 'ig_photo', cadence: 'daily@22:30' });
  assert.deepEqual(codes(checkPlanSkeleton(card, null, [s], [ig()])), ['series_in_quiet_hours'], 'Instagram is quiet from 22:00');
  assert.deepEqual(checkPlanSkeleton(card, null, [s], [ig({ quiet: { start: 0, end: 0 } })]), [], 'no quiet hours on the resource');
  assert.deepEqual(codes(checkPlanSkeleton(card, null, [s], [ig({ quiet: undefined })])), [], 'without a quiet of its own the card\'s 23:00 applies, and 22:30 is outside');
  const late = series({ resource_ref: IG, format: 'ig_photo', cadence: 'daily@23:30' });
  assert.deepEqual(codes(checkPlanSkeleton(card, null, [late], [ig({ quiet: undefined })])), ['series_in_quiet_hours']);
});

test('both codes on one instance are both reported; an inactive series and a series on an unknown resource are left alone', () => {
  const both = series({ format: 'carousel', cadence: 'daily@23:30' });
  assert.deepEqual(codes(checkPlanSkeleton(card, null, [both], [tg({ formats: ['photo'] })], DATE)), ['series_format_unavailable', 'series_in_quiet_hours']);
  assert.deepEqual(checkPlanSkeleton(card, null, [{ ...both, active: false }], [tg({ formats: ['photo'] })], DATE), []);
  assert.deepEqual(checkPlanSkeleton(card, null, [series({ resource_ref: 'threads:t1', cadence: 'daily@23:30' })], [tg()], DATE), [], 'nothing is known about that resource');
  assert.deepEqual(checkPlanSkeleton(card, null, [], [tg()]), []);
});

test('series_rate_over_card_max: a weekday above the card\'s maximum on the channel\'s own resource; no series, no at; other resources do not count', () => {
  const three = [
    series({ name: 'Ранок', cadence: 'daily@09:00' }), series({ name: 'День', cadence: 'daily@13:00' }), series({ name: 'Вечір', cadence: 'daily@19:00' }),
  ];
  assert.deepEqual(checkPlanSkeleton(card, null, three, [tg()]), [], 'three fit a maximum of three');
  const four = [...three, series({ name: 'Ніч', cadence: 'daily@21:00' })];
  const out = checkPlanSkeleton(card, null, four, [tg()]);
  assert.deepEqual(codes(out), ['series_rate_over_card_max']);
  assert.equal(out[0].series, undefined);
  assert.equal(out[0].at, undefined);
  assert.match(out[0].detail, /^telegram:@food has 4 series posts on Sunday, more than the card's maximum of 3 a day$/);
  // The same four on Instagram are the platform's business, not the card's.
  const onIg = four.map((s) => ({ ...s, resource_ref: IG, format: 'ig_photo' }));
  assert.deepEqual(checkPlanSkeleton(card, null, onIg, [tg(), ig({ quiet: { start: 0, end: 0 } })]), []);
  // A weekly series only adds on its day; with a day only that weekday is looked at.
  const mon = [...three, series({ name: 'Понеділок', cadence: 'weekly:mon@21:00' })];
  assert.equal(checkPlanSkeleton(card, null, mon, [tg()]).length, 1);
  assert.match(checkPlanSkeleton(card, null, mon, [tg()])[0].detail, /on Monday/);
  assert.deepEqual(checkPlanSkeleton(card, null, mon, [tg()], DATE), [], 'Wednesday has three');
  assert.equal(checkPlanSkeleton(card, null, mon, [tg()], '2026-10-05').length, 1, 'Monday has four');
});

test('SKELETON_CODES: the two instance codes are config failures that exclude an instance; the rate code is a warning only; all have entries', () => {
  assert.deepEqual([...SKELETON_CODES], ['series_format_unavailable', 'series_in_quiet_hours', 'series_rate_over_card_max']);
  assert.deepEqual([...EXCLUDING_CODES].sort(), ['series_format_unavailable', 'series_in_quiet_hours']);
  for (const c of EXCLUDING_CODES) assert.equal(isConfigCode(c), true, c);
  assert.equal(isConfigCode('series_rate_over_card_max'), false, 'never a slot error');
  for (const c of SKELETON_CODES) assert.ok(reasonFor(c), c);
});

test('A8 a 074-style consumer: `series` on both instance codes and `at` when the day is given', () => {
  const s = series({ format: 'carousel', cadence: 'daily@23:30' });
  const res = [tg({ formats: ['photo'] })];
  const noDay = checkPlanSkeleton(card, null, [s], res).filter((p) => EXCLUDING_CODES.has(p.code));
  assert.ok(noDay.length === 2 && noDay.every((p) => p.series === 'Рецепт дня' && p.at === undefined));
  const day = checkPlanSkeleton(card, null, [s], res, DATE).filter((p) => EXCLUDING_CODES.has(p.code));
  assert.ok(day.length === 2 && day.every((p) => p.series === 'Рецепт дня' && p.at === zonedToUtc(DATE, '23:30', 'Europe/Kyiv').toISOString()));
});
