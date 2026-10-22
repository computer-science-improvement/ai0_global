import { isCriticRejection, isNotAMiss, isOwnerDecision, skipGroupOf } from '../silent/skip-reasons';

/**
 * Spec 060 FR-001: why a series' slot ended without a post, as the breaker counts it (code only, no LLM).
 *
 * - `no_material` — nothing to write from: no fresh item, an empty library, rows without the fields the series needs,
 *   a source already posted;
 * - `source_unreachable` — the source cannot be read: 403, timeout, too large, host blocked;
 * - `critic` — the critic rejected the post (never paused: it keeps the critic_reject_streak note).
 *
 * The slot's `error` text is the record (stable prefixes for the code paths, free text for an executor's own
 * `skip_slot`). Owner decisions, budget waits, a slot the breaker itself skipped (`series_paused`) and infra skips
 * (spec 061 `preflight_format_unavailable`) are `ignore`: they neither count nor break a streak.
 */
export type SkipCause = 'no_material' | 'source_unreachable' | 'critic';
export const PAUSING_CAUSES: readonly SkipCause[] = ['no_material', 'source_unreachable'];

/** What a closed slot means for a streak: counts as a cause, is transparent, ends it as a success, or ends it as something else. */
export type SlotClose =
  | { k: 'cause'; cause: SkipCause }
  | { k: 'ignore' }
  | { k: 'out' }
  | { k: 'other' };

/** The error prefix of a slot the breaker skipped because its series is paused (costs $0). */
export const SERIES_PAUSED_CODE = 'series_paused';

const OUT = new Set(['published', 'shadowed', 'awaiting_approval', 'approved']);

/** Stable codes of the code paths. */
const NO_MATERIAL_CODE = /^(no_fresh_item\b|series ".*": required source .* has nothing left|source_not_published\b|source_already_posted\b|library_item_already_posted\b|already_posted\b|library_ref_not_found\b|live_source_missing\b)/;
const UNREACHABLE_CODE = /^(host_blocked\b|feed_too_large\b|fetch_failed\b|source_unreachable\b)/;
/** A run that ended on a publish guard in its last step keeps the code after the status (`max_steps: … source_already_posted`). */
const EMBEDDED_NO_MATERIAL = /^(max_steps|no_terminal|error|failed)\b.*\b(source_already_posted|library_item_already_posted)\b/;

/** Free text of an executor's `skip_slot` / run error: the source could not be read. */
const UNREACHABLE_TEXT = /\b(403|404|429|5\d\d)\b|time(d)?[ -]?out|too large|too big|host[_ ]blocked|unreachable|connection (refused|reset)|\bdns\b|\btls\b|недоступн|не вдалося (відкрити|завантажити|отримати|прочитати)|не відповіда|тайм-?аут|завеликий|завелика|заблокован/i;
/** Free text: there is nothing usable to write from. */
const NO_MATERIAL_TEXT = /немає (повного |достатньо |вільн\w* |нових |свіжих )?(тексту|матеріал\w*|свіж\w*|даних|рядків|рядка|джерел\w*|контенту|нових)|нема (чого|матеріал\w*|свіж\w*)|нічого (свіжого|нового|публікувати)|не знайшов\w* (свіж|матеріал|повн|рядк)|обрізан|усічен|порожн|вичерпан|закінчил\w+ (матеріал|рядки)|\bno (full|fresh|usable|new|suitable|unposted|more) (text|material|item|items|row|rows|source|sources|content)|\b(truncated|empty library|nothing (left|fresh|new)|no material|out of material|exhausted)\b|without (a )?(full|complete) (text|prompt)/i;

export interface ClosedSlotLike { status: string; error: string | null; criticVerdict?: string | null }

/** "1 пропуск", "3 пропуски", "5 пропусків". */
export function skipsUk(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? 'пропуск' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'пропуски' : 'пропусків';
}

/** The first line of a slot error as the owner reads it: the `skipped by agent:` prefix dropped, clipped. */
export function reasonLine(error: string | null | undefined, max = 160): string {
  const t = (error ?? '').replace(/^skipped by agent:\s*/i, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** How a closed slot counts for the breaker's streak. */
export function classifyClose(s: ClosedSlotLike): SlotClose {
  if (OUT.has(s.status)) return { k: 'out' };
  if (s.status === 'expired') return { k: 'ignore' };
  if (s.status !== 'skipped' && s.status !== 'failed') return { k: 'ignore' };       // planned / running: not closed
  const e = (s.error ?? '').trim();
  if (isNotAMiss(e) || isOwnerDecision(e)) return { k: 'ignore' };
  if (new RegExp(`^${SERIES_PAUSED_CODE}\\b`).test(e)) return { k: 'ignore' };
  const group = skipGroupOf(e, s.criticVerdict);
  if (group === 'budget' || /^waiting for budget\b/.test(e)) return { k: 'ignore' };
  if (isCriticRejection(e, s.criticVerdict) || group === 'critic') return { k: 'cause', cause: 'critic' };
  // Spec 061 FR-001: `preflight_<reason>` codes classify by prefix, so the pre-flight can add reasons without touching this file.
  const pre = /^preflight_(\w+)/.exec(e);
  if (pre) {
    if (/^(source_used|stale)/.test(pre[1])) return { k: 'cause', cause: 'no_material' };
    if (/^host_blocked/.test(pre[1])) return { k: 'cause', cause: 'source_unreachable' };
    return { k: 'ignore' };                                                           // format_unavailable and other infra reasons
  }
  if (NO_MATERIAL_CODE.test(e) || EMBEDDED_NO_MATERIAL.test(e)) return { k: 'cause', cause: 'no_material' };
  if (UNREACHABLE_CODE.test(e)) return { k: 'cause', cause: 'source_unreachable' };
  if (UNREACHABLE_TEXT.test(e)) return { k: 'cause', cause: 'source_unreachable' };
  if (NO_MATERIAL_TEXT.test(e)) return { k: 'cause', cause: 'no_material' };
  return { k: 'other' };
}
