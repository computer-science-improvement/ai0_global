import type { Pool } from 'pg';
import { DEMOTE_AFTER, noteRun } from './note-gate';

/**
 * Spec 069 FR-004 / A10: the subjects that keep coming back without a reaction from the owner — the notes `OwnerInbox`
 * posts as info (no card). Nothing is stored: the rule is recomputed here from the Inbox rows and the owner-bot cards,
 * the same rule `postOnce` applies (a run of at least `DEMOTE_AFTER` notes, no card of the run resolved from Telegram,
 * never a critical one), so the daily summary lists exactly what stopped ringing.
 */
export interface RepeatingSubject {
  subject: string;
  /** The newest note's stored (English) title. */
  title:   string;
  /** When the run began. */
  since:   Date;
  /** The notes of the run so far. */
  count:   number;
}

interface Row { subject: string; title: string; severity: string; created_at: Date | string }

/** How far back the runs are read. */
const LOOKBACK_DAYS = 30;

/**
 * The runs of gated notes ending now. `repeatDays` is OWNER_NOTE_REPEAT_DAYS: two notes of a run are at most
 * `repeatDays + 1` days apart. A run began as a real alert (some note in it was not info) and is skipped if its newest
 * note is critical.
 */
export async function repeatingSubjects(pool: Pick<Pool, 'query'>, now: Date, repeatDays: number): Promise<RepeatingSubject[]> {
  const { rows } = await pool.query(
    `SELECT subject, title, severity, created_at FROM agent_inbox
      WHERE subject IS NOT NULL AND created_at > $1 ORDER BY subject, created_at DESC, id DESC LIMIT 3000`,
    [new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)]);
  const bySubject = new Map<string, Row[]>();
  for (const r of rows as Row[]) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r]);

  const found: Array<RepeatingSubject & { notes: Row[] }> = [];
  for (const [subject, notes] of bySubject) {
    const run = noteRun(notes.map((n) => new Date(n.created_at)), now, repeatDays);
    if (run.count < DEMOTE_AFTER || !run.since) continue;
    const inRun = notes.slice(0, run.count);
    if (inRun[0].severity === 'critical' || inRun.every((n) => n.severity === 'info')) continue;
    found.push({ subject, title: inRun[0].title, since: run.since, count: run.count, notes: inRun });
  }
  if (!found.length) return [];

  // The owner reacted to a run when a card of one of its notes was resolved from Telegram since the run began.
  const { rows: acted } = await pool.query(
    `SELECT n.subject, n.created_at FROM owner_cards c JOIN agent_inbox n ON c.kind = 'inbox' AND c.ref_id = n.id::text
      WHERE n.subject = ANY($1::text[]) AND n.created_at > $2 AND c.resolved_by LIKE 'telegram:%'`,
    [found.map((f) => f.subject), new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)]);
  const reacted = (f: RepeatingSubject) => (acted as Array<{ subject: string; created_at: Date | string }>)
    .some((a) => a.subject === f.subject && new Date(a.created_at).getTime() >= f.since.getTime());
  return found.filter((f) => !reacted(f)).map(({ notes: _notes, ...f }) => f).sort((a, b) => a.since.getTime() - b.since.getTime());
}

/** A subject in the owner's words (Ukrainian, for the Telegram summary); the stored title when the subject is not a known shape. */
export function subjectLabelUk(subject: string, title: string): string {
  const silent = /^silent:(.+):(miss|critic)$/.exec(subject);
  if (silent) return silent[2] === 'miss' ? `Не виходять серії чи пости на ${silent[1]}` : `Критик відхиляє пости на ${silent[1]}`;
  const escalation = /^escalation:([^:]+):(.+)$/.exec(subject);
  if (escalation) return `Менеджер: поради не виконуються (@${escalation[1]}, ${escalation[2]})`;
  const connection = /^connection:(.+)$/.exec(subject);
  if (connection) return `Підключення ${connection[1]}`;
  const resource = /^resource:(.+)$/.exec(subject);
  if (resource) return `Ресурс ${resource[1]}`;
  return title.replace(/ — still going.*$/, '').slice(0, 100);
}
