/**
 * Spec 073 FR-011: the skeleton of the plan, checked before the planner is paid. A series is authoritative (FR-002): it is
 * exempt from the card's format weights, so what can still make one of its instances impossible is not the content but the
 * setup around it:
 *   - `series_format_unavailable`: the series' format cannot be produced on its resource (not implemented there, or a carousel
 *     without slide hosting);
 *   - `series_in_quiet_hours`: a cadence time falls inside the resource's quiet hours (the playbook was checked at save, but a
 *     later edit of the card is not);
 *   - `series_rate_over_card_max`: a weekday's series instances on the channel's own resource exceed the card's daily maximum.
 * The first two exclude the instance from the day (`ScheduleService.planContext` leaves it out of the due set, tells the planner
 * not to plan it and writes a config placeholder for it); the third is only a warning, since the maximum is raised to the
 * series (the series is authoritative).
 *
 * Pure: the callers hand in the card, the series, the resources with the formats they can produce, and optionally a day.
 * 072's doctor calls it with the first four arguments (`skeletonResourcesOf` builds the resources); 074's re-plan calls it with
 * a day and reads `series` and `at` of each problem.
 */
import type { Platform } from '../agents/agent.types';
import type { EditorCard } from '../card';
import { type NetworkResourceClock, resourceClock } from '../network/network-context';
import type { Playbook, Series } from '../network/playbook';
import { instancesOn, parseCadence } from '../network/series';
import { implementedFormats } from '../platform/capabilities';
import { formatAvailable } from '../preflight/slot-preflight';
import { isQuietHour, zonedToUtc } from '../roles/time';
import { weekdayOf } from '../schedule/schedule-rules';
import type { Quiet } from '../time/resource-time';
import type { ConfigProblem } from './slot-config';

/** The codes of this check: the two instance codes are config failures (a slot error), the rate one is a warning only. */
export const SKELETON_CODES = ['series_format_unavailable', 'series_in_quiet_hours', 'series_rate_over_card_max'] as const;
export type SkeletonCode = typeof SKELETON_CODES[number];

/** The two codes that take an instance out of the day. */
export const EXCLUDING_CODES: ReadonlySet<string> = new Set(['series_format_unavailable', 'series_in_quiet_hours']);

/** A resource as the skeleton needs it: the formats it can produce here (implemented, and hosted where that matters) and its own clock. */
export interface SkeletonResource {
  ref:      string;
  platform: Platform;
  /** Producible here: `implementedFormats(platform)` minus what needs hosting that is not configured. */
  formats:  readonly string[];
  /** IANA zone of the resource; default `card.timezone`. */
  tz?:      string;
  /** Quiet hours of the resource; default the card's. */
  quiet?:   Quiet;
}

/** A8: the formats of a platform that can be produced now (`formatOk` is `formatAvailable(f, env).ok`; absent = every implemented one). */
export function producibleFormats(platform: Platform, formatOk?: (format: string) => boolean): string[] {
  return implementedFormats(platform).filter((f) => !formatOk || formatOk(f));
}

type SkeletonCard = Pick<EditorCard, 'channelKey' | 'timezone' | 'quietStartHour' | 'quietEndHour'>;

/** The skeleton resources of a list of network resources, with an explicit `formatOk` (what `ScheduleService` holds instead of an env). */
export function skeletonResourcesWith(
  card: SkeletonCard, resources: ReadonlyArray<NetworkResourceClock>, formatOk?: (format: string) => boolean,
): SkeletonResource[] {
  return resources.map((r) => {
    const clock = resourceClock(r, card);
    return { ref: r.ref, platform: r.platform, formats: producibleFormats(r.platform, formatOk), tz: clock.tz, quiet: clock.quiet };
  });
}

/** I6: the skeleton resources of a network, built the way the plan check builds them; `env` decides what is hosted (a carousel needs slide hosting). */
export function skeletonResourcesOf(
  card: SkeletonCard, resources: ReadonlyArray<NetworkResourceClock>, env?: (key: string) => string | undefined,
): SkeletonResource[] {
  return skeletonResourcesWith(card, resources, env ? (f) => formatAvailable(f, env).ok : undefined);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * What is wrong with the skeleton of a plan (empty = fine). Only active series are checked, and a series on a resource that is
 * not in `resources` is left alone (nothing is known about it).
 *   - without `day`: one problem per series and code (the doctor's view of the cadence);
 *   - with `day` (YYYY-MM-DD): one problem per due instance of that weekday, each with `at` (ISO of the instance's instant in
 *     the resource's zone), so a consumer can match the instance by `(series, at)`.
 * `series_rate_over_card_max` carries neither `series` nor `at`. `_playbook` is the active playbook, reserved for 072's seam: the
 * check reads the series list it is given.
 */
export function checkPlanSkeleton(
  card: SkeletonCard & Pick<EditorCard, 'postsPerDayMax'>,
  _playbook: Pick<Playbook, 'series'> | null,
  series: readonly Series[],
  resources: readonly SkeletonResource[],
  day?: string,
): ConfigProblem[] {
  const byRef = new Map(resources.map((r) => [r.ref, r]));
  const wd = day ? weekdayOf(day) : null;
  const out: ConfigProblem[] = [];
  for (const s of series) {
    if (s.active === false) continue;
    const r = byRef.get(s.resource_ref);
    const cad = parseCadence(s.cadence);
    if (!r || !cad) continue;
    const times = wd === null ? cad.times : instancesOn(cad, wd);
    if (!times.length) continue;
    const tz = r.tz ?? card.timezone;
    const add = (code: SkeletonCode, detail: (t: string[]) => string, at: string[]) => {
      if (day) for (const t of at) out.push({ code, detail: detail([t]), series: s.name, at: zonedToUtc(day, t, tz).toISOString() });
      else out.push({ code, detail: detail(at), series: s.name });
    };
    if (!r.formats.includes(s.format)) {
      add('series_format_unavailable', () => `series "${s.name}" format ${s.format} cannot be produced on ${r.ref} (available: ${r.formats.join(', ') || 'none'})`, times);
    }
    const q = r.quiet ?? { start: card.quietStartHour, end: card.quietEndHour };
    const quiet = times.filter((t) => isQuietHour(Number(t.slice(0, 2)), q.start, q.end));
    if (quiet.length) add('series_in_quiet_hours', (t) => `series "${s.name}" posts at ${t.join(', ')}, inside the quiet hours ${q.start}:00-${q.end}:00`, quiet);
  }
  const own = `telegram:${card.channelKey}`;
  const mine = series.filter((s) => s.active !== false && s.resource_ref === own);
  for (const d of wd === null ? [0, 1, 2, 3, 4, 5, 6] : [wd]) {
    const n = mine.reduce((a, s) => { const c = parseCadence(s.cadence); return a + (c ? instancesOn(c, d).length : 0); }, 0);
    if (n > card.postsPerDayMax) {
      out.push({ code: 'series_rate_over_card_max', detail: `${own} has ${n} series posts on ${DAY_NAMES[d]}, more than the card's maximum of ${card.postsPerDayMax} a day` });
      break;
    }
  }
  return out;
}
