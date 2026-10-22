import { localDate, localTimeLabel } from '../roles/time';

/**
 * Spec 063 FR-005: local times come from tools. Review 3, pp1716: the post said «до 22 жовтня, 17:00 за Києвом» while the
 * API said 15:00Z = 18:00 Kyiv — the model converted the zone itself (and the reminder's critic claimed the two times
 * match). A tool that returns an event or deadline time adds a `*_local` field next to it, in Europe/Kyiv, e.g.
 * `"ends_at_local": "22.10, 18:00 (Київ)"`; the executor prompt says to take the reader's time from these fields.
 */

export const KYIV = 'Europe/Kyiv';

const WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/** «2026-10-22 23:59:00» and «2026-10-22T23:59:00» without a zone: the APIs we read (GamerPower) give UTC. */
const NO_ZONE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** «22.10, 18:00 (Київ)» for an ISO instant with a time (a date alone or anything else: null). */
export function kyivLocal(value: unknown, tz: string = KYIV): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let d: Date;
  if (WITH_ZONE.test(v)) d = new Date(v);
  else if (NO_ZONE.test(v)) d = new Date(`${v.replace(' ', 'T')}${v.length <= 16 ? ':00' : ''}Z`);
  else return null;
  if (Number.isNaN(d.getTime())) return null;
  const [, m, day] = localDate(d, tz).split('-');
  return `${day}.${m}, ${localTimeLabel(d, tz)} (${tz === KYIV ? 'Київ' : tz})`;
}

/**
 * Adds `<key>_local` next to every time-bearing string of an object (`ends_at`, `starts_at`, `date`, `published_at`, …).
 * Other values stay as they are; a key that already has its `_local` twin keeps it.
 */
export function withLocalTimes<T extends Record<string, unknown>>(o: T, tz: string = KYIV): T {
  const out: Record<string, unknown> = { ...o };
  for (const [k, v] of Object.entries(o)) {
    if (k.endsWith('_local') || `${k}_local` in o) continue;
    const local = kyivLocal(v, tz);
    if (local) out[`${k}_local`] = local;
  }
  return out as T;
}
