import { zonedToUtc } from '../roles/time';
import { CHAT_TIMEZONE } from './default-card';

const VERBS = 'опублікуй|публікуй|запости|опублікувати|заплануй|запланувати|постав на|відклади на|publish|schedule|post it';
const INTENT_RE = new RegExp(`(?:^|[^\\p{L}])(?:${VERBS})`, 'iu');
const NEGATED_RE = new RegExp(`(?:^|[^\\p{L}])не\\s+(?:${VERBS})`, 'iu');

/**
 * Did the owner explicitly ask to publish or schedule in THIS message? A
 * conservative keyword check (spec 010 Safety): the composer's publish_draft and
 * schedule_draft refuse without it, so text injected into a fetched page can
 * never publish. A negated request ("не публікуй") is not a request.
 */
export function hasPublishIntent(message: string): boolean {
  return INTENT_RE.test(message) && !NEGATED_RE.test(message);
}

/**
 * Parse a schedule time: an ISO instant with an offset/Z, or a wall-clock
 * 'YYYY-MM-DD HH:MM' (also with 'T') read in Kyiv time. Null when invalid.
 */
export function parseKyivTime(at: string): Date | null {
  const s = at.trim();
  const wall = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::00)?$/);
  if (wall) {
    const [, y, mo, d, h, mi] = wall;
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59) return null;
    const date = `${y}-${mo}-${d}`;
    const out = zonedToUtc(date, `${h.padStart(2, '0')}:${mi}`, CHAT_TIMEZONE);
    return Number.isNaN(out.getTime()) ? null : out;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const out = new Date(s);
    return Number.isNaN(out.getTime()) ? null : out;
  }
  return null;
}

const HANDLE_RE = /@[A-Za-z0-9_]{3,64}/g;

/** Channel handles mentioned in a message, latest mention first. */
export function mentionedChannels(text: string): string[] {
  return [...new Set((text.match(HANDLE_RE) ?? []).reverse())];
}
