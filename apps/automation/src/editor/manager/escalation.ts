import type { Pool } from 'pg';
import type { InboxItemInput } from '../agents/owner-inbox';
import { plural } from '../owner-bot/owner-text';
import { dayBefore } from './kpi-math';

/**
 * Spec 069 FR-005: the manager escalates by code. Two triggers, no LLM:
 *   1. two or more pieces of advice / directives to one agent of one kind that nobody followed (`verification.adherence =
 *      'not_followed'`) within 14 days;
 *   2. the number of posts of an agent's resource below its norm (`kpi_snapshots` posts anomaly, z < 0) on 3 or more days
 *      in a row, with no directive filed for that agent in that span.
 * The output is an Inbox note (kind `manager_escalation`, never a code-filed `strategy` directive: approving one rebuilds the
 * playbook) and a line in the manager's memory. The digest lists the open ones and `submit_review` must answer each.
 */

export const ESCALATION_KIND = 'manager_escalation';
/** Never `directive` or `playbook`: those notes are swallowed by the item's own card (OWN_CARD_REF_TYPES). */
export const ESCALATION_REF_TYPE = 'escalation';
/** The window of trigger 1, and how long an unread escalation stays open. */
export const ESCALATION_DAYS = 14;
export const ESCALATION_MIN_NOT_FOLLOWED = 2;
/** Consecutive days of a negative posts anomaly that make trigger 2. */
export const ESCALATION_POSTS_DAYS = 3;
/** A `decline_reason` shorter than this does not answer an escalation. */
export const ESCALATION_REASON_MIN = 20;
/** The gate step of the posts trigger: a run that keeps going fires again only after this many more days. */
export const POSTS_GROW_STEP = 3;
/**
 * How far back the posts snapshots are read to find the true start of a run. A posts anomaly lasts until the 28-day baseline
 * (days 8-35) has caught up with the drop, i.e. up to about 35 days, so a shorter window would slide `posts_from` forward
 * every day once the run outgrows it (a note a day, and "no directive filed" judged on a truncated span).
 */
export const ESCALATION_POSTS_LOOKBACK_DAYS = 60;
/** The most open escalations the digest lists and `submit_review` takes answers for (one bound for both sides). */
export const ESCALATION_ANSWERS_MAX = 100;
const SUBJECT_RE = /^escalation:([^:]+):(.+)$/;

type Q = Pick<Pool, 'query'>;

export function escalationSubject(handle: string, kind: string): string {
  return `escalation:${handle}:${kind}`;
}

export function parseEscalationSubject(subject: string): { handle: string; kind: string } | null {
  const m = SUBJECT_RE.exec(subject);
  return m ? { handle: m[1], kind: m[2] } : null;
}

// ── trigger 1: advice nobody followed ──────────────────────────────────────

export interface NotFollowedGroup {
  agentId: string;
  handle:  string;
  kind:    string;
  ids:     string[];
  bodies:  string[];
}

/**
 * Per target agent and kind, the directives (any status: a superseded advice and its re-filed directive both count) whose
 * adherence is `not_followed`, changed within `days` days; groups of at least `min`.
 */
export async function notFollowedGroups(pool: Q, days = ESCALATION_DAYS, min = ESCALATION_MIN_NOT_FOLLOWED): Promise<NotFollowedGroup[]> {
  const { rows } = await pool.query(
    `SELECT a.id AS agent_id, a.handle, d.kind,
            array_agg(d.id::text ORDER BY d.created_at, d.id) AS ids,
            array_agg(left(d.body, 160) ORDER BY d.created_at, d.id) AS bodies
       FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
      WHERE NOT d.shadow AND d.verification->>'adherence' = 'not_followed' AND d.updated_at >= now() - ($1 || ' days')::interval
      GROUP BY a.id, a.handle, d.kind
     HAVING COUNT(*) >= $2
      ORDER BY a.handle, d.kind`, [String(days), min]);
  return rows.map((r: any) => ({ agentId: String(r.agent_id), handle: String(r.handle), kind: String(r.kind), ids: r.ids ?? [], bodies: r.bodies ?? [] }));
}

// ── trigger 2: posts below the norm for days ───────────────────────────────

export interface PostsDay { agentId: string; handle: string; ref: string; day: string }
export interface PostsRun { agentId: string; handle: string; ref: string; firstDay: string; days: number }

/**
 * The days (from `fromDay`) on which an agent's own resource had a negative posts anomaly in its snapshot. A resource whose
 * orchestrator is switched off, in shadow mode (it publishes nothing) or paused, or that is under an active resource pause,
 * is left out: its posts stopped because the owner (or the manager) stopped it, and there is nothing for a directive to fix.
 */
export async function negativePostsDays(pool: Q, fromDay: string): Promise<PostsDay[]> {
  const { rows } = await pool.query(
    `SELECT a.id AS agent_id, a.handle, s.scope_id AS ref, s.day::text AS day
       FROM kpi_snapshots s
       JOIN agents a ON a.scope = 'resource' AND a.scope_id = s.scope_id AND a.parent_id IS NULL AND a.kind = 'orchestrator'
        AND a.mode NOT IN ('off', 'shadow') AND a.status <> 'paused' AND (a.paused_until IS NULL OR a.paused_until <= now())
      WHERE s.scope = 'resource' AND s.day >= $1::date
        AND s.metrics->'posts'->>'anomaly' = 'true' AND (s.metrics->'posts'->>'z')::float8 < 0
        AND NOT EXISTS (SELECT 1 FROM resource_pauses p
                         WHERE p.resource_ref = s.scope_id AND p.lifted_at IS NULL AND p.starts_at <= now() AND p.until > now())
      ORDER BY a.handle, s.scope_id, s.day`, [fromDay]);
  return rows.map((r: any) => ({ agentId: String(r.agent_id), handle: String(r.handle), ref: String(r.ref), day: String(r.day) }));
}

/** Directives filed for an agent since `since` (shadow ones do not count: the owner never saw them). */
export async function filedSince(pool: Q, agentId: string, since: Date): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_directives WHERE to_agent_id = $1 AND created_at >= $2 AND NOT shadow`, [agentId, since]);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The running streak per agent: consecutive calendar days up to today (or yesterday, today's snapshot is made by the
 * morning review) of a negative posts anomaly; the longest streak among the agent's resources. Streaks shorter than
 * `min` days are dropped.
 */
export function postsRuns(rows: PostsDay[], today: string, min = ESCALATION_POSTS_DAYS): PostsRun[] {
  const byRef = new Map<string, PostsDay[]>();
  for (const r of rows) byRef.set(`${r.agentId}|${r.ref}`, [...(byRef.get(`${r.agentId}|${r.ref}`) ?? []), r]);
  const best = new Map<string, PostsRun>();
  for (const list of byRef.values()) {
    const days = [...new Set(list.map((r) => r.day))].sort();
    const last = days[days.length - 1];
    if (last < dayBefore(today, 1)) continue; // the streak ended before yesterday
    let first = last;
    let n = 1;
    for (let i = days.length - 2; i >= 0 && days[i] === dayBefore(first, 1); i--) { first = days[i]; n++; }
    if (n < min) continue;
    const run: PostsRun = { agentId: list[0].agentId, handle: list[0].handle, ref: list[0].ref, firstDay: first, days: n };
    const seen = best.get(run.agentId);
    if (!seen || seen.days < run.days) best.set(run.agentId, run);
  }
  return [...best.values()].sort((a, b) => a.handle.localeCompare(b.handle));
}

// ── the notes ──────────────────────────────────────────────────────────────

export interface EscalationNote {
  item:   InboxItemInput & { refType: string; refId: string };
  /** `escalationKeys` of this note: when the open escalation of its subject has the same key, that one already says it. */
  key:    string;
  /** The manager's memory line for it. */
  memory: { text: string; evidence: Record<string, unknown> };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (id: string) => id.slice(0, 8);

/** English title and body (the dashboard), a Ukrainian `alert` (Telegram); refType `escalation`. `day` is the Kyiv day of the check. */
export function notFollowedNote(g: NotFollowedGroup, day: string): EscalationNote {
  const subject = escalationSubject(g.handle, g.kind);
  const n = g.ids.length;
  const lines = g.bodies.map((b, i) => `• ${clip(b, 140)} (id ${short(g.ids[i])})`);
  const ids = [...g.ids].sort();
  return {
    key: escalationKeys([{ subject, directive_ids: ids, days: null }])[0],
    item: {
      agentId: g.agentId, kind: ESCALATION_KIND, severity: 'action', refType: ESCALATION_REF_TYPE, refId: `${subject}|${day}`,
      title: `Manager escalation: @${g.handle} did not follow ${n} ${g.kind} items in ${ESCALATION_DAYS} days`,
      body: [
        `@${g.handle} did not carry out ${n} pieces of the manager's ${g.kind} advice in the last ${ESCALATION_DAYS} days:`,
        ...lines,
        '',
        'The manager sees this in its next review and has to file a structural directive or explain why not. You can ask the agent in its chat why, change its rules or skills, or leave it.',
      ].join('\n'),
      alert: {
        title: `🧭 Менеджер: @${g.handle} не виконує поради (${g.kind}, ${n} за ${ESCALATION_DAYS} днів)`,
        body: [
          `Не виконано ${n} ${plural(n, 'пораду', 'поради', 'порад')} менеджера:`,
          ...g.bodies.map((b) => `• ${clip(b, 140)}`),
          '',
          'Менеджер це бачить: на наступному огляді він подасть структурну директиву або пояснить, чому ні. Ви можете спитати агента в чаті, поправити його правила чи скіл, або залишити як є.',
        ].join('\n'),
      },
      gate: { subject, parts: ids },
    },
    memory: {
      text: `Ескалація власнику: @${g.handle} не виконав ${n} ${plural(n, 'пораду', 'поради', 'порад')} ${g.kind} за ${ESCALATION_DAYS} днів (id ${ids.map(short).join(', ')}) — не повторюй їх, подай структурну директиву або поясни відмову в submit_review.escalations.`,
      evidence: { escalation: subject, directives: ids },
    },
  };
}

export function postsNote(r: PostsRun, day: string): EscalationNote {
  const subject = escalationSubject(r.handle, 'posts');
  return {
    key: escalationKeys([{ subject, directive_ids: [], days: r.days }])[0],
    item: {
      agentId: r.agentId, kind: ESCALATION_KIND, severity: 'action', refType: ESCALATION_REF_TYPE, refId: `${subject}|${day}`,
      title: `Manager escalation: posts of ${r.ref} below the norm for ${r.days} days, no directive filed`,
      body: [
        `The number of posts of ${r.ref} has been well below its 28-day norm on ${r.days} days in a row (since ${r.firstDay}), and the manager has filed nothing for @${r.handle} in that time.`,
        '',
        'The manager sees this in its next review and has to file a directive or explain why not. You can check the agent’s plans and skipped slots on /app/editor.',
      ].join('\n'),
      alert: {
        title: `🧭 Менеджер: постів на ${r.ref} менше за норму ${r.days} ${plural(r.days, 'день', 'дні', 'днів')} поспіль`,
        body: [
          `З ${r.firstDay} кількість постів помітно нижча за норму, а директив для @${r.handle} менеджер не подав.`,
          'На наступному огляді він подасть директиву або пояснить, чому ні. Плани й пропущені слоти — на /app/editor.',
        ].join('\n'),
      },
      // The run keeps its first day, so a longer run is not a new cause; it fires again only after POSTS_GROW_STEP more days.
      gate: { subject, parts: [`posts_from:${r.firstDay}`, `days:${r.days}`], grow: { days: POSTS_GROW_STEP } },
    },
    memory: {
      text: `Ескалація власнику: кількість постів ${r.ref} нижча за норму ${r.days} ${plural(r.days, 'день', 'дні', 'днів')} поспіль (з ${r.firstDay}), директив немає — розбери причину й подай директиву або поясни відмову в submit_review.escalations.`,
      evidence: { escalation: subject, ref: r.ref, from: r.firstDay, days: r.days },
    },
  };
}

// ── open escalations (one definition: the digest, the review check) ───────

export interface DigestEscalation {
  subject:       string;
  agent:         string;
  /** A directive kind (trigger 1) or `posts` (trigger 2). */
  kind:          string;
  since:         string;
  /** Trigger 1: the directives that were not followed. */
  directive_ids: string[];
  /** Trigger 2: how many days the run had when the note was written. */
  days:          number | null;
  text:          string;
}

/**
 * An open escalation is an unread `manager_escalation` note of the last 14 days, one per gate subject (the newest). The
 * order is stable (by subject), so the digest hash only changes when an escalation appears, is repeated with new parts, or is read.
 * The list is bounded by `ESCALATION_ANSWERS_MAX` (the oldest first; the rest show up as those are read), the same number
 * `submit_review` takes answers for, so a review can always answer every escalation it is shown.
 */
export async function openEscalations(pool: Q, now: Date): Promise<DigestEscalation[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (subject) subject, parts, title, created_at FROM agent_inbox
      WHERE kind = $1 AND read_at IS NULL AND subject IS NOT NULL AND created_at > $2
      ORDER BY subject, created_at DESC, id DESC`,
    [ESCALATION_KIND, new Date(now.getTime() - ESCALATION_DAYS * 86_400_000)]);
  const out: DigestEscalation[] = [];
  for (const r of rows as Array<{ subject: string; parts: string[] | null; title: string; created_at: Date | string }>) {
    const s = parseEscalationSubject(r.subject);
    if (!s) continue;
    const parts = r.parts ?? [];
    const days = parts.map((p) => /^days:(\d+)$/.exec(p)).find(Boolean);
    out.push({
      subject: r.subject, agent: s.handle, kind: s.kind, since: new Date(r.created_at).toISOString().slice(0, 10),
      directive_ids: s.kind === 'posts' ? [] : parts,
      days: days ? Number(days[1]) : null,
      text: clip(r.title, 160),
    });
  }
  const kept = out.length > ESCALATION_ANSWERS_MAX
    ? [...out].sort((a, b) => a.since.localeCompare(b.since) || a.subject.localeCompare(b.subject)).slice(0, ESCALATION_ANSWERS_MAX)
    : out;
  return kept.sort((a, b) => a.subject.localeCompare(b.subject));
}

/** What the hash and the review signature see of the open escalations: the subject and its parts, in stable order. */
export function escalationKeys(list: ReadonlyArray<Pick<DigestEscalation, 'subject' | 'directive_ids' | 'days'>> | undefined): string[] {
  return [...(list ?? [])].map((e) => `${e.subject}#${[...e.directive_ids].sort().join(',')}#${e.days ?? ''}`).sort();
}
