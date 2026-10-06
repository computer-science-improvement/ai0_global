// Kyiv wall-clock helpers for the editor chat (spec 010). Scheduling is always
// in Europe/Kyiv, whatever the browser's own timezone is: the picker value
// ("YYYY-MM-DDTHH:MM") is sent as "YYYY-MM-DD HH:MM" and the server reads it as Kyiv.

export const KYIV_TZ = 'Europe/Kyiv';

function parts(d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "YYYY-MM-DDTHH:MM" of an instant in Kyiv (a datetime-local value). */
export function toKyivInput(d: Date): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Default for the schedule picker: the next round hour in Kyiv. */
export function nextRoundHourKyiv(now = new Date()): string {
  const p = parts(new Date(now.getTime() + 3600_000));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

/** datetime-local value → the API's Kyiv wall-clock format. */
export function inputToApi(v: string): string {
  return v.replace('T', ' ').slice(0, 16);
}

/** "2 Oct, 19:00" in Kyiv time. */
export function fmtKyiv(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: KYIV_TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}
