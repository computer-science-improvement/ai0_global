// Time-zone helpers (spec 024 FR-011), generalised from kyiv-time.ts. Every
// value goes through Intl with an explicit zone, never Date#getHours(), so the
// browser's own zone never leaks into what the owner sees. Owner-facing times
// are Kyiv; a resource's own times are in its zone, and both are shown when
// they differ (BR-GEN-01 as replaced by spec 024).

export const KYIV_TZ = 'Europe/Kyiv';

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** True when `tz` is an IANA zone this browser knows. */
export function isValidZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}

/** A usable zone: the given one when valid, else Kyiv. */
export function zoneOr(tz: string | null | undefined, fallback = KYIV_TZ): string {
  return isValidZone(tz) ? tz : fallback;
}

/** Wall-clock parts of an instant in `tz`. */
export function zonedParts(d: Date | string | number, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFmt(zoneOr(tz)).formatToParts(new Date(d))) out[p.type] = p.value;
  return { year: +out.year, month: +out.month, day: +out.day, hour: +out.hour % 24, minute: +out.minute };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of an instant in `tz`. */
export function dayIn(d: Date | string | number, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" of an instant in `tz`. */
export function formatIn(iso: Date | string | number, tz: string): string {
  const p = zonedParts(iso, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of `tz` from UTC at an instant, in minutes (Kyiv in summer → 180). */
export function offsetMinutes(at: Date | number, tz: string): number {
  const t = new Date(at).getTime();
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(t / 60_000) * 60_000) / 60_000);
}

/** The instant of a wall-clock time in `tz` ("2026-10-08", 9, 0 → Date). Gap times move forward; ambiguous ones take the earlier. */
export function zonedToUtc(day: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  const first = naive - offsetMinutes(naive, tz) * 60_000;
  const second = naive - offsetMinutes(first, tz) * 60_000;
  // Ambiguous (autumn): both candidates are valid — take the earlier instant.
  const candidates = [first, second].filter((t) => formatIn(t, tz) === `${pad(hour)}:${pad(minute)}` && dayIn(t, tz) === day);
  return new Date(candidates.length ? Math.min(...candidates) : Math.max(first, second));
}

/** Minutes from the start (00:00) of `day` in `tz` to an instant; can be negative or exceed 1440. */
export function minutesFromDayStart(iso: Date | string | number, day: string, tz: string): number {
  return Math.round((new Date(iso).getTime() - zonedToUtc(day, 0, 0, tz).getTime()) / 60_000);
}

/** A short owner-facing name of a zone: "Kyiv" for Europe/Kyiv, else the IANA id. */
export function zoneLabel(tz: string): string {
  if (tz === KYIV_TZ || tz === 'Europe/Kiev') return 'Kyiv';
  return tz;
}

/** Two zones show the same wall clock at this instant. */
export function sameClock(at: Date | string | number, a: string, b: string): boolean {
  return a === b || offsetMinutes(new Date(at), a) === offsetMinutes(new Date(at), b);
}

/**
 * The resource's time, plus the owner's (Kyiv) time when they differ:
 * "09:00 America/New_York · 16:00 Kyiv"; a Kyiv resource → "16:00".
 */
export function dual(iso: Date | string | number, tz: string | null | undefined, ref: string = KYIV_TZ): string {
  const zone = zoneOr(tz);
  if (sameClock(iso, zone, ref)) return formatIn(iso, zone);
  return `${formatIn(iso, zone)} ${zoneLabel(zone)} · ${formatIn(iso, ref)} ${zoneLabel(ref)}`;
}

/** Every IANA zone the browser knows (Intl.supportedValuesOf), with a small fallback list. */
export function listZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.('timeZone');
    if (all?.length) return all.includes(KYIV_TZ) ? all : [KYIV_TZ, ...all];
  } catch { /* older engines */ }
  return [KYIV_TZ, 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Warsaw', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo'];
}

/** "2 Oct, 19:00" in `tz`. */
export function fmtDateTimeIn(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: zoneOr(tz), day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}
