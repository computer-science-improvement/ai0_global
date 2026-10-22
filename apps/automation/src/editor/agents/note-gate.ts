import { createHash } from 'node:crypto';

/**
 * Spec 060 FR-003: one note per cause, not per day. A note that carries a gate (`subject` = the problem it is about,
 * `parts` = the causes and numbers it says, as short strings such as `streak:3` or `missed:Prompt:nothing_fresh`)
 * fires again only when
 *   - its subject has no note yet, or
 *   - it says something the subject's last note did not (a part that is new: another cause, a bigger streak), or
 *   - the last note is `OWNER_NOTE_REPEAT_DAYS` old (default 3): then it is sent once more as "still … N days".
 * Otherwise it stays quiet. The memory lives in the Inbox rows (agent_inbox.subject / parts), not in a table of its own.
 */
export interface NoteGate { subject: string; parts: string[] }

export const DEFAULT_NOTE_REPEAT_DAYS = 3;
const DAY = 86_400_000;

/** OWNER_NOTE_REPEAT_DAYS: a whole number of days ≥ 1; empty or invalid = 3. */
export function noteRepeatDays(env: (k: string) => string | undefined = (k) => process.env[k]): number {
  const n = Number(env('OWNER_NOTE_REPEAT_DAYS')?.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_NOTE_REPEAT_DAYS;
}

/** What the subject's earlier notes said (newest first). */
export interface PastNote { parts: string[] | null; createdAt: Date }

export type GateDecision =
  | { fire: true; why: 'first' | 'changed' }
  | { fire: true; why: 'repeat'; stillDays: number }
  | { fire: false };

const cover = (have: string[] | null, need: string[]) => !!have && need.every((p) => have.includes(p));

/** Whether a gated note fires now (pure). `past` is the subject's notes, newest first. */
export function decideNote(past: PastNote[], parts: string[], now: Date, repeatDays: number): GateDecision {
  const last = past[0];
  if (!last) return { fire: true, why: 'first' };
  if (!cover(last.parts, parts)) return { fire: true, why: 'changed' };
  if (now.getTime() - last.createdAt.getTime() < repeatDays * DAY) return { fire: false };
  // Still going: since the oldest note of the unbroken run that already said all of this.
  let since = last.createdAt;
  for (const p of past) {
    if (!cover(p.parts, parts)) break;
    since = p.createdAt;
  }
  return { fire: true, why: 'repeat', stillDays: Math.max(1, Math.floor((now.getTime() - since.getTime()) / DAY)) };
}

/** Short stable key of a set of parts, for the once-per-day unique ref of a gated note. */
export function partsKey(parts: string[]): string {
  return createHash('sha1').update([...new Set(parts)].sort().join('\n')).digest('hex').slice(0, 8);
}

/** "5 днів", "1 день", "3 дні". */
export function daysUk(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дні' : 'днів';
}

/** The "still" wording of a repeated note: the stored (English) title and the Telegram (Ukrainian) one. */
export function stillWording(title: string, alertTitle: string | null | undefined, days: number): { title: string; alertTitle: string | null } {
  return {
    title: `${title} — still going, ${days} day${days === 1 ? '' : 's'}`,
    alertTitle: alertTitle ? `${alertTitle} — досі, ${days} ${daysUk(days)}` : null,
  };
}
