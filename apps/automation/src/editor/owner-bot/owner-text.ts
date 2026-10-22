// Spec 012: the owner bot's Telegram text. Ukrainian, as the owner's alerts already are; HTML parse mode, so every
// dynamic piece goes through `esc`.

import { errText } from '../../common/err-text';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** At most `n` characters, cut at a word when one is near, with an ellipsis. */
export function clip(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.7 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** Ukrainian plural: plural(5, 'картка', 'картки', 'карток') → 'карток'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

export const BODY_MAX = 600;

/** A card: the kind line, the title in bold, the item's text, and the outcome once decided. */
export function cardText(c: { emoji: string; label: string; title: string; body?: string | null; outcome?: string | null }): string {
  const parts = [`${c.emoji} <b>${esc(c.label)}</b> · ${esc(clip(c.title, 200))}`];
  if (c.body?.trim()) parts.push(esc(clip(c.body, BODY_MAX)));
  if (c.outcome) parts.push(`<i>${esc(c.outcome)}</i>`);
  return parts.join('\n\n');
}

/** "14:05" in Kyiv time, for the outcome line. */
export function kyivTime(d: Date): string {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** The reason an action failed, as owner text: the service's `details` or `error`, else the message. */
export function errorText(err: any): string {
  const r = err?.response ?? err?.getResponse?.();
  const body = r && typeof r === 'object' ? r : null;
  const details = body?.details;
  if (typeof details === 'string' && details) return details;
  if (Array.isArray(details) && details.length) return details.map(String).join('; ');
  if (typeof body?.error === 'string') return body.error;
  return errText(err);
}
