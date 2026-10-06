/**
 * Per-resource time (spec 024 FR-004/FR-005): every resource has its own IANA
 * zone and quiet hours. One resolver with the same order as SQL resource_tz():
 *   telegram:<key> → the editor card's timezone / quiet hours (authoritative),
 *                    then the resource profile, then the defaults;
 *   other refs     → the resource profile, then the defaults
 * (Europe/Kyiv, quiet 23→8). An invalid stored zone falls back to Kyiv with a
 * warning. Owner-facing times (budget day, MANAGER, chat input) stay Kyiv.
 */
import { localDate, localTimeLabel, tzOffsetMs } from '../roles/time';

export const DEFAULT_TZ = 'Europe/Kyiv';
export const DEFAULT_QUIET: Quiet = { start: 23, end: 8 };

export interface Quiet { start: number; end: number }

/** True when `tz` is an IANA zone this runtime knows (Intl.DateTimeFormat accepts it). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** What the resolver reads: the card of a Telegram channel and the resource profile (both optional). */
export interface ResourceTimeCard { timezone?: string | null; quietStartHour?: number | null; quietEndHour?: number | null }
export interface ResourceTimeProfile { timezone?: string | null; quiet_hours?: { start: number; end: number } | null }

const isTelegram = (ref: string) => ref.startsWith('telegram:');
const isHour = (h: unknown): h is number => Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23;

/** Pure zone resolution; `invalid` names a stored zone that was ignored. */
export function resolveTz(ref: string, card: ResourceTimeCard | null, profile: ResourceTimeProfile | null): { tz: string; invalid?: string } {
  const candidates = isTelegram(ref) ? [card?.timezone, profile?.timezone] : [profile?.timezone];
  for (const c of candidates) {
    if (c == null || !String(c).trim()) continue;
    return isValidTimeZone(c) ? { tz: c } : { tz: DEFAULT_TZ, invalid: String(c) };
  }
  return { tz: DEFAULT_TZ };
}

/** Pure quiet-hours resolution (same order as the zone). */
export function resolveQuiet(ref: string, card: ResourceTimeCard | null, profile: ResourceTimeProfile | null): Quiet {
  if (isTelegram(ref) && card && isHour(card.quietStartHour) && isHour(card.quietEndHour)) return { start: card.quietStartHour, end: card.quietEndHour };
  const q = profile?.quiet_hours;
  if (q && isHour(q.start) && isHour(q.end)) return { start: q.start, end: q.end };
  return { ...DEFAULT_QUIET };
}

export interface ResourceTimeDeps {
  /** The editor card of a Telegram channel key (without the `telegram:` prefix). */
  card:    (channelKey: string) => Promise<ResourceTimeCard | null>;
  /** The stored resource profile JSON (raw, so an invalid stored zone is still seen). */
  profile: (ref: string) => Promise<ResourceTimeProfile | null>;
  /** An invalid stored zone (FR-004 corner case: resource_health.detail warning). */
  warn?:   (ref: string, detail: string) => Promise<void> | void;
}

/** The resolver (FR-004): tzOf / quietOf / localDay. */
export class ResourceTime {
  constructor(private readonly d: ResourceTimeDeps) {}

  private async sources(ref: string): Promise<[ResourceTimeCard | null, ResourceTimeProfile | null]> {
    const card = isTelegram(ref) ? await this.d.card(ref.slice('telegram:'.length)).catch(() => null) : null;
    const profile = await this.d.profile(ref).catch(() => null);
    return [card, profile];
  }

  async tzOf(ref: string): Promise<string> {
    const [card, profile] = await this.sources(ref);
    const r = resolveTz(ref, card, profile);
    if (r.invalid && this.d.warn) {
      try { await this.d.warn(ref, `invalid time zone "${r.invalid}", using ${DEFAULT_TZ}`); } catch { /* best-effort */ }
    }
    return r.tz;
  }

  async quietOf(ref: string): Promise<Quiet> {
    const [card, profile] = await this.sources(ref);
    return resolveQuiet(ref, card, profile);
  }

  /** The resource's calendar day (YYYY-MM-DD) of an instant. */
  async localDay(ref: string, instant: Date): Promise<string> {
    return localDate(instant, await this.tzOf(ref));
  }
}

/**
 * Instant of wall-clock `date` + `hhmm` in `tz`, strictly: a local time that
 * does not exist (spring DST gap) → null; an ambiguous one (autumn) → the
 * earlier instant. Offsets a day either side cover every transition.
 */
export function zonedToUtcStrict(date: string, hhmm: string, tz: string): Date | null {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((dt) => tzOffsetMs(new Date(guess + dt), tz)));
  const hits = [...offsets]
    .map((o) => guess - o)
    .filter((t) => localDate(new Date(t), tz) === date && localTimeLabel(new Date(t), tz) === hhmm)
    .sort((a, b) => a - b);
  return hits.length ? new Date(hits[0]) : null;
}

/** "зараз HH:MM" lines for resources outside Kyiv (prompts, FR-005); empty when all are in Kyiv. */
export function resourceTimeLines(zones: Array<{ ref: string; tz?: string | null }>, now: Date): string[] {
  return zones
    .filter((z) => z.tz && z.tz !== DEFAULT_TZ && isValidTimeZone(z.tz))
    .map((z) => `${z.ref} — ${z.tz}, зараз ${localTimeLabel(now, z.tz!)}`);
}
