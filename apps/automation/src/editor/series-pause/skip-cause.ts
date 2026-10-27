import { agentCauseOf, isCriticRejection, isNotAMiss, isOwnerDecision, skipGroupOf } from '../silent/skip-reasons';

/**
 * Spec 060 FR-001 / spec 068 FR-002: why a series' slot ended without a post, as the breaker counts it (code only, no LLM).
 *
 * - `no_material` — nothing to write from: no fresh item, an empty library, rows without the fields the series needs;
 * - `source_used` — the source (or the library row) was already posted;
 * - `source_unreachable` — the source cannot be read: 403, timeout, too large, host blocked;
 * - `quality` — the executor judged the material too weak to post;
 * - `critic` — the critic rejected the post (transparent to a streak: it neither counts nor ends a run).
 *
 * The slot's `error` text is the record. A new `skip_slot` writes `skipped by agent: <cause>: <reason>` (spec 068 FR-001)
 * and that cause is read first; the stable codes of the code paths and, for the 14-day window of older rows, the free text
 * of an executor's own `skip_slot` are read by patterns. Owner decisions, budget waits, a slot the breaker itself skipped
 * (`series_paused`) and infra skips (spec 061 `preflight_format_unavailable`) are `ignore`: they neither count nor break a streak.
 */
export type SkipCause = 'no_material' | 'source_used' | 'source_unreachable' | 'quality' | 'critic';
/** The causes a pause stores (the 093 CHECK set, besides `owner`). */
export type PauseCause = 'no_material' | 'source_unreachable';
export const PAUSING_CAUSES: readonly PauseCause[] = ['no_material', 'source_unreachable'];

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
/** The guard codes anywhere in an agent's free text («…відхилена як source_already_posted»): the source was already posted. */
const USED_ANYWHERE = /\b(source_already_posted|library_item_already_posted|already_posted|library_ref_not_found)\b/;
const AGENT_PREFIX = /^skipped by agent:\s*/i;
/** A story the network already told (the story guard): editorial, never "no material". */
const STORY_TEXT = /\bstory_(repeat|skip)\b|повтор історії/i;

/**
 * Free text of an executor's `skip_slot` / run error: the source could not be read.
 * The Ukrainian stems below use `[\p{L}\p{N}_]` with the `u` flag: JS `\w` is ASCII-only and never matched a Cyrillic ending.
 */
const UNREACHABLE_TEXT = /\b(403|404|429|5\d\d)\b|time(d)?[ -]?out|too large|too big|host[_ ]blocked|unreachable|connection (refused|reset)|\bdns\b|\btls\b|недоступн|не вдалося (відкрити|завантажити|отримати|прочитати)|не відповіда|тайм-?аут|завеликий|завелика|заблокован|не завантажується/iu;
/** Free text: there is nothing usable to write from. */
const NO_MATERIAL_TEXT = /немає (повного |достатньо |вільн[\p{L}\p{N}_]* |нових |свіжих |непублікован[\p{L}\p{N}_]* )?(тексту|матеріал[\p{L}\p{N}_]*|свіж[\p{L}\p{N}_]*|даних|рядків|рядка|джерел[\p{L}\p{N}_]*|контенту|нових|запис[\p{L}\p{N}_]*)|нема (чого|матеріал[\p{L}\p{N}_]*|свіж[\p{L}\p{N}_]*)|нічого (свіжого|нового|публікувати)|не знайш[\p{L}\p{N}_]* (свіж|матеріал|повн|рядк|першоджерел)|не знайдено в бібліотец|без повного тексту|повного тексту \S+ (\S+ )?немає|обрізан|усічен|порожн|вичерпан|закінчил[\p{L}\p{N}_]+ (матеріал|рядки)|уже використано|заборонено (брати )?повторно|\bno (full|fresh|usable|new|suitable|unposted|more) (text|material|item|items|row|rows|source|sources|content)|\b(truncated|empty library|nothing (left|fresh|new)|no material|out of material|exhausted)\b|without (a )?(full|complete) (text|prompt)/iu;
/** The text speaks of the library, a row or a `data://` ref: «недоступний у бібліотеці» is a missing row, not a dead host. */
const LIBRARY_CONTEXT = /data:\/\/|бібліотец|датасет|рядк|запис/iu;

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

/**
 * How a closed slot counts for the breaker's streak. The order matters (spec 068 A2): out of scope, not closed, the
 * system's and the owner's own decisions, a paused series, the budget, the critic (an executor's skip after a revise is
 * the critic's), pre-flight and planner codes, a story the network told, the cause the executor named, then the old text.
 */
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
    if (/^(source_used|stale|no_material)/.test(pre[1])) return { k: 'cause', cause: 'no_material' };
    if (/^host_blocked/.test(pre[1])) return { k: 'cause', cause: 'source_unreachable' };
    return { k: 'ignore' };                                                           // format_unavailable and other infra reasons
  }
  // Spec 068 FR-004: the planner's own honest empty day (a placeholder slot) is classified by its code, like the pre-flight's.
  if (/^planner_no_material\b/.test(e)) return { k: 'cause', cause: 'no_material' };
  if (/^planner_source_unreachable\b/.test(e)) return { k: 'cause', cause: 'source_unreachable' };
  if (STORY_TEXT.test(e)) return { k: 'other' };
  // Spec 071's guard code (the series takes rows in order): the text names a row id («наступний — data://prompts/503»), which the
  // free-text reader below would take for an HTTP status. It is a content failure, never a dead source.
  if (/^(skipped by agent:\s*)?not_next_in_order\b/i.test(e)) return { k: 'other' };
  // Spec 068 FR-001: the cause the executor named in skip_slot.
  const named = agentCauseOf(e);
  if (named) return named === 'other' ? { k: 'other' } : { k: 'cause', cause: named };
  return classifyText(e);
}

/**
 * The older rows: the stable codes first, then the free text of an executor's own `skip_slot` (the 14-day window).
 * An anchored guard code stays `no_material` (the family makes it the same for a streak); the same code inside an
 * agent's sentence says the source was already posted.
 */
function classifyText(e: string): SlotClose {
  const agent = AGENT_PREFIX.test(e);
  const body = e.replace(AGENT_PREFIX, '');
  if (NO_MATERIAL_CODE.test(body) || EMBEDDED_NO_MATERIAL.test(body)) return { k: 'cause', cause: 'no_material' };
  if (agent && USED_ANYWHERE.test(body)) return { k: 'cause', cause: 'source_used' };
  // A run that crashed, timed out or was switched off did not test the material (idea-outcome reads it the same way): it neither
  // counts nor ends a run. The executor's own skips (`agent`) are judged by what they say.
  if (!agent && /^(error|timeout|disabled)\b/.test(body)) return { k: 'ignore' };
  if (UNREACHABLE_CODE.test(body)) return { k: 'cause', cause: 'source_unreachable' };
  const unreachable = UNREACHABLE_TEXT.test(body), nothing = NO_MATERIAL_TEXT.test(body);
  // «недоступний у бібліотеці» names a missing row: with the library in the text, "no material" wins over "unreachable".
  if (nothing && (!unreachable || LIBRARY_CONTEXT.test(body))) return { k: 'cause', cause: 'no_material' };
  if (unreachable) return { k: 'cause', cause: 'source_unreachable' };
  return { k: 'other' };
}
