import { createHash } from 'node:crypto';

/**
 * Spec 060 FR-003: one note per cause, not per day. A note that carries a gate (`subject` = the problem it is about,
 * `parts` = the causes and numbers it says, as short strings such as `streak:3` or `missed:Prompt:nothing_fresh`)
 * fires again only when
 *   - its subject has no note yet, or
 *   - it says something the subject's notes of the last `OWNER_NOTE_REPEAT_DAYS` (default 3) did not (spec 069: the
 *     UNION of their parts, not only the last note's): a part that is new (another cause), or a number that grew by a
 *     whole step (`streak:8` → `streak:11`, never a smaller one), or
 *   - the last note is that old: then it is sent once more as "still … N days".
 * Otherwise it stays quiet. The memory lives in the Inbox rows (agent_inbox.subject / parts), not in a table of its own.
 */
export interface NoteGate {
  subject: string;
  parts:   string[];
  /**
   * Spec 069 FR-004: how much a numeric part (`name:N`) must grow over the largest N the window said to count as news,
   * per part name (`{ days: 3 }`). A part without an entry uses the default step (EDITOR_CRITIC_REJECT_STREAK, 3).
   */
  grow?:   Record<string, number>;
  /**
   * Spec 069 A8: the note answers none of the subject's other notes — it neither supersedes nor retargets them. A
   * first miss of a PAST day is reported late; it must not close today's open note.
   */
  standalone?: boolean;
}

export const DEFAULT_NOTE_REPEAT_DAYS = 3;
/** The default growth step of a numeric part: the critic streak's own N (EDITOR_CRITIC_REJECT_STREAK, default 3). */
export const DEFAULT_GROW_STEP = 3;
/** Spec 069 FR-004: a subject whose run reaches this length with no owner action is posted as info. */
export const DEMOTE_AFTER = 3;
const DAY = 86_400_000;

/** OWNER_NOTE_REPEAT_DAYS: a whole number of days ≥ 1; empty or invalid = 3. */
export function noteRepeatDays(env: (k: string) => string | undefined = (k) => process.env[k]): number {
  const n = Number(env('OWNER_NOTE_REPEAT_DAYS')?.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_NOTE_REPEAT_DAYS;
}

/** EDITOR_CRITIC_REJECT_STREAK: the default step by which a number must grow to be news; empty or invalid = 3. */
export function noteGrowStep(env: (k: string) => string | undefined = (k) => process.env[k]): number {
  const n = Number(env('EDITOR_CRITIC_REJECT_STREAK')?.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_GROW_STEP;
}

/** What the subject's earlier notes said (newest first). */
export interface PastNote { parts: string[] | null; createdAt: Date }

export interface GateOptions {
  /** The step for a numeric part with no entry in `grow`. */
  step?: number;
  grow?: Record<string, number>;
}

/** The run of a subject's notes (spec 069 A10): how long the problem has been re-announced. */
export interface NoteRun {
  /** This note and the earlier ones of the unbroken run. */
  runLength: number;
  /** When the oldest note of the run was made (null when the run is this note alone). */
  runSince:  Date | null;
}

export type GateDecision =
  | { fire: true; why: 'first' | 'changed' }
  | { fire: true; why: 'repeat'; stillDays: number }
  | { fire: false };

const NUMERIC_PART = /^(.+):(\d+)$/;
const numericPart = (p: string): { name: string; n: number } | null => {
  const m = NUMERIC_PART.exec(p);
  return m ? { name: m[1], n: Number(m[2]) } : null;
};

/** Whether `parts` say something the union of `notes` did not: an unseen part, or a number grown by a whole step. */
function hasNews(notes: readonly PastNote[], parts: readonly string[], o: GateOptions): boolean {
  const said = new Set<string>();
  const largest = new Map<string, number>();
  for (const n of notes) {
    for (const p of n.parts ?? []) {
      said.add(p);
      const m = numericPart(p);
      if (m) largest.set(m.name, Math.max(largest.get(m.name) ?? -Infinity, m.n));
    }
  }
  return parts.some((p) => {
    const m = numericPart(p);
    if (!m) return !said.has(p);
    const seen = largest.get(m.name);
    if (seen === undefined) return true;
    return m.n >= seen + Math.max(1, o.grow?.[m.name] ?? o.step ?? DEFAULT_GROW_STEP);
  });
}

/**
 * The unbroken run of a subject's notes ending at `now`: counted back from the newest note while consecutive notes (and the
 * newest and `now`) are at most `repeatDays + 1` days apart. `times` is newest first.
 */
export function noteRun(times: readonly Date[], now: Date, repeatDays: number): { count: number; since: Date | null } {
  const gap = (repeatDays + 1) * DAY;
  let prev = now.getTime();
  let count = 0;
  let since: Date | null = null;
  for (const t of times) {
    if (prev - t.getTime() > gap) break;
    count++;
    since = t;
    prev = t.getTime();
  }
  return { count, since };
}

/** Whether a gated note fires now (pure). `past` is the subject's notes, newest first. */
export function decideNote(past: PastNote[], parts: string[], now: Date, repeatDays: number, o: GateOptions = {}): GateDecision & NoteRun {
  const run = noteRun(past.map((p) => p.createdAt), now, repeatDays);
  const meta: NoteRun = { runLength: 1 + run.count, runSince: run.since };
  const last = past[0];
  if (!last) return { fire: true, why: 'first', ...meta };
  const horizon = now.getTime() - repeatDays * DAY;
  const window = past.filter((p) => p.createdAt.getTime() > horizon);
  if (window.length) return hasNews(window, parts, o) ? { fire: true, why: 'changed', ...meta } : { fire: false, ...meta };
  // Nothing inside the window: news against the last note is "changed", else the problem is still going.
  if (hasNews([last], parts, o)) return { fire: true, why: 'changed', ...meta };
  // Still going: since the oldest note of the unbroken run that already said all of this.
  let since = last.createdAt;
  for (const p of past) {
    if (hasNews([p], parts, o)) break;
    since = p.createdAt;
  }
  return { fire: true, why: 'repeat', stillDays: Math.max(1, Math.floor((now.getTime() - since.getTime()) / DAY)), ...meta };
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
