// Kyiv wall-clock helpers for the editor chat (spec 010), now thin wrappers over
// the general lib/zoned-time.ts (spec 024). Chat scheduling stays in
// Europe/Kyiv whatever the browser's zone is: the picker value
// ("YYYY-MM-DDTHH:MM") is sent as "YYYY-MM-DD HH:MM" and the server reads it as Kyiv.

import { KYIV_TZ, dayIn, fmtDateTimeIn, formatIn } from './zoned-time';

export { KYIV_TZ };

/** "YYYY-MM-DDTHH:MM" of an instant in Kyiv (a datetime-local value). */
export function toKyivInput(d: Date): string {
  return `${dayIn(d, KYIV_TZ)}T${formatIn(d, KYIV_TZ)}`;
}

/** Default for the schedule picker: the next round hour in Kyiv. */
export function nextRoundHourKyiv(now = new Date()): string {
  const next = new Date(now.getTime() + 3600_000);
  return `${dayIn(next, KYIV_TZ)}T${formatIn(next, KYIV_TZ).slice(0, 2)}:00`;
}

/** datetime-local value → the API's Kyiv wall-clock format. */
export function inputToApi(v: string): string {
  return v.replace('T', ' ').slice(0, 16);
}

/** "2 Oct, 19:00" in Kyiv time. */
export function fmtKyiv(iso: string | null | undefined): string {
  return fmtDateTimeIn(iso, KYIV_TZ);
}
