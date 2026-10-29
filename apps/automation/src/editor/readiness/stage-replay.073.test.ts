/**
 * Spec 073 L2 (T13): "no false blocker on @ai0_global". The lead captures the raw API responses of a working channel as
 * `readiness/fixtures/stage-<channel>.json` (`{ channel_key, captured_at, channel, schedule, skills, rules, series_pauses, datasets }`);
 * 073 never writes or commits one. This test takes the file whose `channel_key` is `@ai0_global`, builds the skeleton check's inputs
 * from `channel` (the card) and `schedule` (its resources and series), and expects no problem on any of the next seven days: a
 * channel that publishes fine must never be blocked by the new check. With no such file, or a field missing, it is `test.skip` with
 * the reason. The same reading is also run on a small synthetic capture, so the replay itself is exercised without stage data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPlanSkeleton, producibleFormats, type SkeletonResource } from './plan-skeleton';
import { SeriesSchema } from '../network/playbook';
import { shiftDate } from '../schedule/schedule-rules';

const FIXTURES = join(__dirname, 'fixtures');

/** The stage capture of a channel, or null when there is none. */
function stageOf(channelKey: string): { file: string; json: any } | null {
  if (!existsSync(FIXTURES)) return null;
  for (const f of readdirSync(FIXTURES).filter((x) => /^stage-.*\.json$/.test(x))) {
    try {
      const json = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
      if (json?.channel_key === channelKey) return { file: f, json };
    } catch { /* a file that is not JSON is not a capture */ }
  }
  return null;
}

const first = (o: any, ...keys: string[]): unknown => keys.map((k) => o?.[k]).find((v) => v !== undefined && v !== null);

/** The skeleton problems of a capture over seven days from `from`, or `{ skip }` naming what the capture lacks. */
function replay(json: any, from = '2026-10-29'): { skip: string } | { problems: Array<{ day: string; code: string; detail: string }> } {
  const card = json?.channel?.card ?? json?.channel;
  const schedule = json?.schedule;
  const tz = first(card, 'timezone');
  const quietStart = first(card, 'quiet_start_hour', 'quietStartHour');
  const quietEnd = first(card, 'quiet_end_hour', 'quietEndHour');
  const max = first(card, 'posts_per_day_max', 'postsPerDayMax');
  if (typeof tz !== 'string') return { skip: 'the capture\'s channel has no timezone' };
  if (typeof quietStart !== 'number' || typeof quietEnd !== 'number') return { skip: 'the capture\'s channel has no quiet hours' };
  if (typeof max !== 'number') return { skip: 'the capture\'s channel has no posts-per-day maximum' };
  if (!Array.isArray(schedule?.series) || !Array.isArray(schedule?.resources)) return { skip: 'the capture\'s schedule has no `series` or no `resources`' };
  let series;
  // The schedule API writes `source: null` and `migrated_from: null` for a series without them; the schema wants the keys absent.
  const noNulls = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null));
  try { series = schedule.series.map((s: Record<string, unknown>) => SeriesSchema.parse(noNulls(s))); } catch { return { skip: 'a series of the capture does not parse' }; }
  const resources: SkeletonResource[] = schedule.resources.map((r: any) => ({
    ref: r.ref, platform: r.platform, formats: producibleFormats(r.platform), tz: r.timezone, quiet: r.quietHours ? { start: r.quietHours.start, end: r.quietHours.end } : undefined,
  }));
  const channel = { channelKey: String(json.channel_key), timezone: tz, quietStartHour: quietStart, quietEndHour: quietEnd, postsPerDayMax: max };
  const problems: Array<{ day: string; code: string; detail: string }> = [];
  for (let i = 0; i < 7; i++) {
    const day = shiftDate(from, i);
    for (const p of checkPlanSkeleton(channel, null, series, resources, day)) problems.push({ day, code: p.code, detail: p.detail });
  }
  return { problems };
}

test('L2 no false blocker on @ai0_global: the skeleton check finds nothing in the captured card and schedule', (t) => {
  const stage = stageOf('@ai0_global');
  if (!stage) return t.skip('no readiness/fixtures/stage-*.json with channel_key @ai0_global (the lead captures it)');
  const r = replay(stage.json, typeof stage.json.captured_at === 'string' ? stage.json.captured_at.slice(0, 10) : undefined);
  if ('skip' in r) return t.skip(`${stage.file}: ${r.skip}`);
  assert.deepEqual(r.problems, [], `${stage.file}: a channel that publishes fine is blocked by the skeleton check`);
});

// ── the replay itself, on a synthetic capture in the shape the lead's file has ──────────────────────

const capture = (over: { quietStart?: number; max?: number; cadence?: string; format?: string } = {}) => ({
  channel_key: '@ai0_global', captured_at: '2026-10-29T08:00:00Z',
  channel: { card: { channel_key: '@ai0_global', timezone: 'Europe/Kyiv', quiet_start_hour: over.quietStart ?? 23, quiet_end_hour: 8, posts_per_day_max: over.max ?? 4 } },
  schedule: {
    resources: [{ ref: 'telegram:@ai0_global', platform: 'telegram', timezone: 'Europe/Kyiv', quietHours: { start: over.quietStart ?? 23, end: 8 }, formats: ['text', 'photo'], perDay: { min: 1, max: 4 } }],
    series: [
      { name: 'Новини ШІ', cadence: over.cadence ?? 'daily@10:00,18:00', resource_ref: 'telegram:@ai0_global', format: over.format ?? 'text', brief: 'Головні новини про ШІ за день', active: true, source: null, source_mode: 'suggested', origin: 'owner', locked: true, migrated_from: null, topic_mode: 'fixed' },
    ],
  },
});

test('the replay reads a capture as the API returns it and finds nothing wrong with a sane channel', () => {
  const r = replay(capture());
  assert.deepEqual(r, { problems: [] });
});

test('the replay can fail: a quiet window over the cadence, a format that does not exist here, and a daily maximum below the series are all found', () => {
  const quiet = replay(capture({ quietStart: 17 }));
  assert.ok('problems' in quiet && quiet.problems.some((p) => p.code === 'series_in_quiet_hours'), JSON.stringify(quiet));
  const format = replay(capture({ format: 'ig_reel' }));
  assert.ok('problems' in format && format.problems.some((p) => p.code === 'series_format_unavailable'), JSON.stringify(format));
  const rate = replay(capture({ max: 1 }));
  assert.ok('problems' in rate && rate.problems.some((p) => p.code === 'series_rate_over_card_max'), JSON.stringify(rate));
});

test('the replay names what a capture lacks instead of failing: no card fields, no schedule, an unparsable series', () => {
  assert.deepEqual(replay({ channel_key: '@ai0_global' }), { skip: 'the capture\'s channel has no timezone' });
  const noQuiet = capture() as any;
  delete noQuiet.channel.card.quiet_start_hour;
  assert.deepEqual(replay(noQuiet), { skip: 'the capture\'s channel has no quiet hours' });
  const noSchedule = capture() as any;
  delete noSchedule.schedule;
  assert.deepEqual(replay(noSchedule), { skip: 'the capture\'s schedule has no `series` or no `resources`' });
  const bad = capture() as any;
  bad.schedule.series[0].cadence = 'whenever';
  assert.deepEqual(replay(bad), { skip: 'a series of the capture does not parse' });
});
