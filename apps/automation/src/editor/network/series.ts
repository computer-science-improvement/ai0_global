import { z } from 'zod';
import { API_SOURCE_NAMES } from '../tools/api-adapters/names';

/**
 * Series v2 (spec 023 FR-002): cadence with several days and times, an optional content source, how
 * binding that source is, and who owns the series. Pure helpers shared by the playbook validator, the
 * change classifier, the orchestrator's series tools and the planners. No imports from playbook.ts.
 */

export const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY = '(?:mon|tue|wed|thu|fri|sat|sun)';
const TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d';
/** `daily@HH:MM[,HH:MM…]` or `weekly:mon[,thu…]@HH:MM[,…]` (the v1 forms `daily@10:00`, `weekly:sun@10:00` still match). */
export const CADENCE_RE = new RegExp(`^(daily|weekly:${DAY}(?:,${DAY})*)@(${TIME}(?:,${TIME})*)$`);
export const MAX_SERIES_TIMES = 6;

export interface Cadence {
  /** Weekdays (0 = Sunday), sorted; null = every day. */
  days:  number[] | null;
  /** Local times HH:MM, sorted, unique. */
  times: string[];
}

export function parseCadence(cadence: string): Cadence | null {
  const m = cadence.trim().match(CADENCE_RE);
  if (!m) return null;
  const times = [...new Set(m[2].split(','))].sort();
  if (m[1] === 'daily') return { days: null, times };
  const days = [...new Set(m[1].slice('weekly:'.length).split(',').map((d) => DOW.indexOf(d as typeof DOW[number])))].sort((a, b) => a - b);
  return { days, times };
}

export function formatCadence(c: Cadence): string {
  const times = [...c.times].sort().join(',');
  return c.days === null ? `daily@${times}` : `weekly:${c.days.map((d) => DOW[d]).join(',')}@${times}`;
}

/** Instances on one weekday (0 = Sunday). */
export function instancesOn(c: Cadence, weekday: number): string[] {
  return c.days === null || c.days.includes(weekday) ? c.times : [];
}

/** Average instances per day (runway, frequency). */
export function instancesPerDay(c: Cadence): number {
  return c.times.length * (c.days === null ? 7 : c.days.length) / 7;
}

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * How a cadence changed: the same days and the same number of times → the largest shift of a time (paired
 * in order, minutes, absolute); anything else (days, count) is a structural change of the schedule.
 */
export function cadenceChange(a: string, b: string): { same: true } | { shiftMinutes: number } | { structural: string } {
  if (a === b) return { same: true };
  const x = parseCadence(a);
  const y = parseCadence(b);
  if (!x || !y) return { structural: 'cadence unreadable' };
  if (JSON.stringify(x.days) !== JSON.stringify(y.days)) return { structural: 'days changed' };
  if (x.times.length !== y.times.length) return { structural: 'number of times changed' };
  let max = 0;
  for (let i = 0; i < x.times.length; i++) max = Math.max(max, Math.abs(minutesOf(x.times[i]) - minutesOf(y.times[i])));
  return max === 0 ? { same: true } : { shiftMinutes: max };
}

export const SeriesSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind:       z.literal('library'),
    table:      z.string().min(2).max(63).describe('Датасет із library_catalog'),
    category:   z.string().max(100).optional(),
    query:      z.string().max(200).optional(),
    today_only: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('api'), source: z.string().min(2).max(60), params: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ kind: z.literal('feed'), ref: z.string().min(3).max(500).describe('id або URL джерела з картки каналу') }),
  z.object({ kind: z.literal('network_highlights'), scope: z.enum(['channel', 'network']).default('network') }),
  z.object({ kind: z.literal('free') }),
]);
export type SeriesSource = z.infer<typeof SeriesSourceSchema>;

/** Short text of a source for prompts and summaries: `library:recipes`, `api:nasa_apod`, `feed:<ref>`… */
export function seriesSourceLabel(s: SeriesSource): string {
  switch (s.kind) {
    case 'library': return `library:${s.table}${s.category ? `/${s.category}` : ''}${s.today_only ? ' (today)' : ''}`;
    case 'api': return `api:${s.source}`;
    case 'feed': return `feed:${s.ref}`;
    case 'network_highlights': return `network_highlights:${s.scope}`;
    default: return 'free';
  }
}

export const SERIES_SOURCE_MODES = ['suggested', 'required'] as const;
export const SERIES_ORIGINS = ['agent', 'owner', 'migration'] as const;

export const CadenceSchema = z.string().max(200).regex(CADENCE_RE, 'daily@HH:MM[,HH:MM] або weekly:mon[,thu]@HH:MM[,…]')
  .refine((c) => (parseCadence(c)?.times.length ?? 0) <= MAX_SERIES_TIMES, `не більше ${MAX_SERIES_TIMES} часів`);

/** Sources the series may name (validated against the library, the API adapters and the card's feeds). */
export interface SeriesSourceCatalog {
  tables: string[];
  /** Card sources of kind rss / url (ids and refs). */
  feeds:  string[];
}

/** One line per problem with a series source (empty = fine). */
export function seriesSourceErrors(name: string, src: SeriesSource | undefined, cat: SeriesSourceCatalog | null): string[] {
  if (!src) return [];
  const label = `серія «${name}»`;
  if (src.kind === 'api' && !(API_SOURCE_NAMES as readonly string[]).includes(src.source)) {
    return [`${label}: API ${src.source} немає (є: ${API_SOURCE_NAMES.join(', ')})`];
  }
  if (!cat) return [];
  if (src.kind === 'library' && !cat.tables.includes(src.table)) return [`${label}: датасету ${src.table} немає в бібліотеці`];
  if (src.kind === 'feed' && !cat.feeds.includes(src.ref)) return [`${label}: фіду ${src.ref} немає в картці каналу`];
  return [];
}

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

/** The fields of a series that describe what it is (everything but ownership and its lock), key-order free. */
export function seriesContent(s: object): string {
  const { origin: _o, locked: _l, migrated_from: _m, ...rest } = s as any;
  return stable(rest);
}
