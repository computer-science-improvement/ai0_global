import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { dailyRef, type InboxItemInput, type OwnerInbox, type SilentDayKind } from '../agents/owner-inbox';
import { localDate, localHour, localTimeLabel } from '../roles/time';
import { attemptRejections, type SlotFallback } from './fallback-ladder';
import { addSkip, isCriticRejection, isNotAMiss, isOwnerDecision, skipGroupOf, type SkipCounts } from './skip-reasons';

/**
 * Spec 037 FR-010 (T10): the owner's Inbox notes about silent days, computed by code from the slots (no LLM):
 *
 * - `dark_day` — a resource that plans ≥ 1 post a day (a slot today, or the card's posts_per_day minimum) has no
 *   post out (published, or shadowed on a shadow channel) by 18:00 in the resource's zone;
 * - `series_missed` — a series slot (`series_name`) or an owner's fixed-time pin (`schedule_rule_id`) of the day
 *   ended without going out (skipped / failed / expired; the owner's own rejections and pauses excluded);
 * - `critic_reject_streak` — the last N critic verdicts of a resource were rejections (N configurable, default 3;
 *   every attempt of the fallback ladder counts).
 *
 * At most one note per resource, per local day and per kind (`OwnerInbox.postOnce` + `dailyRef`). The check runs
 * from the editor scheduler's minute tick, throttled (`everyMs`, 5 min by default).
 */

export const DARK_DAY_HOUR = 18;
export const DEFAULT_REJECT_STREAK = 3;
export const SILENT_CHECK_EVERY_MS = 5 * 60_000;
/** The slots the check reads: two days back (yesterday's late slots, the streak) and today's later ones. */
export const WINDOW_BACK_MS = 48 * 3600_000;
export const WINDOW_AHEAD_MS = 24 * 3600_000;

const OUT = new Set(['published', 'shadowed']);
const ENDED_NOT_OUT = new Set(['skipped', 'failed', 'expired']);
const TERMINAL = new Set(['published', 'shadowed', 'skipped', 'failed', 'expired', 'awaiting_approval', 'approved']);

export interface WatchSlot {
  id:             string;
  ref:            string;
  scheduledAt:    Date;
  updatedAt:      Date;
  status:         string;
  error:          string | null;
  format:         string;
  topic:          string;
  seriesName:     string | null;
  scheduleRuleId: string | null;
  criticVerdict:  string | null;
  fallback:       SlotFallback | null;
}

export interface WatchResource {
  ref:       string;
  tz:        string;
  /** The card's posts-per-day minimum (Telegram channels in a non-off mode); 0 for other resources. */
  minPerDay: number;
  agentId?:  string | null;
}

export interface SilentAlert {
  kind:     SilentDayKind;
  ref:      string;
  /** The resource's local date the note is about (the dedup key). */
  day:      string;
  title:    string;
  body:     string;
  agentId:  string | null;
  slotIds:  string[];
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function reasonsLine(c: SkipCounts): string {
  const parts = Object.entries(c).filter(([, n]) => (n ?? 0) > 0).map(([g, n]) => `${g.replace('_', ' ')} ${n}`);
  return parts.length ? parts.join(', ') : 'none';
}

/** The trailing run of critic rejections of a resource's attempts (oldest → newest). */
export function rejectStreak(slots: WatchSlot[]): { n: number; slotIds: string[] } {
  const attempts: Array<{ slotId: string; rejected: boolean }> = [];
  for (const s of [...slots].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())) {
    if (!TERMINAL.has(s.status)) continue;                      // still being written
    const ladder = attemptRejections(s.fallback);
    if (ladder.length) {
      for (const r of ladder) attempts.push({ slotId: s.id, rejected: r });
      continue;
    }
    if (!s.criticVerdict || s.criticVerdict === 'error') continue; // never reached the critic, or the critic was down
    attempts.push({ slotId: s.id, rejected: isCriticRejection(s.error, s.criticVerdict) });
  }
  let n = 0;
  const ids: string[] = [];
  for (let i = attempts.length - 1; i >= 0 && attempts[i].rejected; i--) {
    n++;
    if (!ids.includes(attempts[i].slotId)) ids.push(attempts[i].slotId);
  }
  return { n, slotIds: ids };
}

/** Every silent-day note due at `now` (pure; dedup is the Inbox's). */
export function evaluateSilentDays(i: {
  now: Date; resources: WatchResource[]; slots: WatchSlot[]; streakN?: number; paused?: ReadonlySet<string>; darkHour?: number;
}): SilentAlert[] {
  const streakN = Math.max(1, i.streakN ?? DEFAULT_REJECT_STREAK);
  const darkHour = i.darkHour ?? DARK_DAY_HOUR;
  const byRef = new Map<string, WatchSlot[]>();
  for (const s of i.slots) byRef.set(s.ref, [...(byRef.get(s.ref) ?? []), s]);
  const out: SilentAlert[] = [];

  for (const r of i.resources) {
    if (i.paused?.has(r.ref)) continue;
    const slots = byRef.get(r.ref) ?? [];
    const today = localDate(i.now, r.tz);
    const dayOf = (s: WatchSlot) => localDate(s.scheduledAt, r.tz);
    const counted = slots.filter((s) => !isNotAMiss(s.error));

    // ── dark_day ────────────────────────────────────────────────────────────
    if (localHour(i.now, r.tz) >= darkHour) {
      const planned = counted.filter((s) => dayOf(s) === today);
      if ((planned.length >= 1 || r.minPerDay >= 1) && !planned.some((s) => OUT.has(s.status))) {
        const reasons: SkipCounts = {};
        for (const s of planned) if (ENDED_NOT_OUT.has(s.status)) addSkip(reasons, skipGroupOf(s.error, s.criticVerdict));
        const later = planned.filter((s) => s.status === 'planned' || s.status === 'running' || s.status === 'approved' || s.status === 'awaiting_approval')
          .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
        const lastMiss = planned.filter((s) => ENDED_NOT_OUT.has(s.status)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
        const body = [
          planned.length
            ? `Planned today: ${planned.length}; out: 0; not out by reason: ${reasonsLine(reasons)}.`
            : `No slot was planned today although the card asks for at least ${r.minPerDay} post(s) a day (check the planner runs).`,
          later.length ? `Still to come: ${later.length} (next at ${localTimeLabel(later[0].scheduledAt, r.tz)}, ${later[0].status}).` : '',
          lastMiss?.error ? `Latest: ${clip(lastMiss.error, 220)}` : '',
          'Check the slots and the run traces on /app/editor.',
        ].filter(Boolean).join(' ');
        out.push({
          kind: 'dark_day', ref: r.ref, day: today, agentId: r.agentId ?? null, slotIds: planned.map((s) => s.id),
          title: `Silent day: nothing went out on ${r.ref} by ${darkHour}:00`, body,
        });
      }
    }

    // ── series_missed (one note per resource and day, listing that day's misses) ──
    const missedByDay = new Map<string, WatchSlot[]>();
    for (const s of counted) {
      if (!s.seriesName && !s.scheduleRuleId) continue;
      if (!ENDED_NOT_OUT.has(s.status) || isOwnerDecision(s.error)) continue;
      const d = dayOf(s);
      if (d > today) continue;
      missedByDay.set(d, [...(missedByDay.get(d) ?? []), s]);
    }
    for (const [day, miss] of missedByDay) {
      miss.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
      const lines = miss.slice(0, 4).map((s) => `${localTimeLabel(s.scheduledAt, r.tz)} ${s.seriesName ? `series "${s.seriesName}"` : 'fixed slot'} — ${s.status}: ${clip(s.error ?? 'no reason recorded', 160)}`);
      out.push({
        kind: 'series_missed', ref: r.ref, day, agentId: r.agentId ?? null, slotIds: miss.map((s) => s.id),
        title: `Series or fixed slot missed on ${r.ref} (${day})`,
        body: [`${miss.length} series / fixed slot(s) did not go out:`, ...lines.map((l) => `• ${l}`), miss.length > 4 ? `• … and ${miss.length - 4} more` : ''].filter(Boolean).join('\n'),
      });
    }

    // ── critic_reject_streak ────────────────────────────────────────────────
    const streak = rejectStreak(slots);
    if (streak.n >= streakN) {
      out.push({
        kind: 'critic_reject_streak', ref: r.ref, day: today, agentId: r.agentId ?? null, slotIds: streak.slotIds,
        title: `Critic rejected ${streak.n} posts in a row on ${r.ref}`,
        body: `The last ${streak.n} critic verdicts on ${r.ref} were rejections (fallback attempts included). `
          + 'Posts are being written and thrown away: check the critic notes on the slots, the resource profile and the sources on /app/editor.',
      });
    }
  }
  return out;
}

// ── SQL + scheduler hook ─────────────────────────────────────────────────────

export interface SilentDaysDeps {
  pool:     Pick<Pool, 'query'>;
  inbox:    Pick<OwnerInbox, 'postOnce'>;
  /** N of `critic_reject_streak` (EDITOR_CRITIC_REJECT_STREAK, default 3). */
  streakN?: number;
  everyMs?: number;
  log?:     (m: string) => void;
}

export class SilentDaysWatch {
  private lastRun = 0;

  constructor(private readonly d: SilentDaysDeps) {}

  /** The slots and resources of the window (read-only). */
  async load(cards: EditorCard[], now: Date): Promise<{ slots: WatchSlot[]; resources: WatchResource[] }> {
    const { rows } = await this.d.pool.query(
      `SELECT s.id::text AS id, COALESCE(s.resource_ref, 'telegram:' || s.channel_key) AS ref, s.channel_key, s.scheduled_at, s.updated_at,
              s.status, s.error, s.format, s.topic, s.series_name, s.schedule_rule_id::text AS schedule_rule_id,
              s.critic->>'verdict' AS verdict, s.fallback
         FROM editor_slots s
        WHERE s.kind = 'content' AND s.scheduled_at >= $1 AND s.scheduled_at < $2
        ORDER BY s.updated_at LIMIT 5000`,
      [new Date(now.getTime() - WINDOW_BACK_MS), new Date(now.getTime() + WINDOW_AHEAD_MS)]);
    const slots: WatchSlot[] = rows.map((r: any) => ({
      id: r.id, ref: r.ref, scheduledAt: new Date(r.scheduled_at), updatedAt: new Date(r.updated_at), status: r.status, error: r.error ?? null,
      format: r.format, topic: r.topic, seriesName: r.series_name ?? null, scheduleRuleId: r.schedule_rule_id ?? null,
      criticVerdict: r.verdict ?? null, fallback: r.fallback ?? null,
    }));
    const anchorOf = new Map<string, string>(rows.map((r: any) => [r.ref, `telegram:${r.channel_key}`]));
    const minOf = new Map<string, number>();
    for (const c of cards) {
      const ref = `telegram:${c.channelKey}`;
      minOf.set(ref, c.mode === 'off' ? 0 : Math.max(0, Number(c.postsPerDayMin) || 0));
      if (!anchorOf.has(ref)) anchorOf.set(ref, ref);
    }
    // Resources: every card's channel (a missing plan is a silent day too) and every resource with slots.
    const refs = [...new Set([...minOf.keys(), ...slots.map((s) => s.ref)])];
    if (!refs.length) return { slots, resources: [] };
    const { rows: tz } = await this.d.pool.query(`SELECT ref, resource_tz(ref) AS tz FROM unnest($1::text[]) AS ref`, [refs]);
    const tzOf = new Map<string, string>(tz.map((r: any) => [r.ref, r.tz || 'Europe/Kyiv']));
    const anchors = [...new Set(refs.map((r) => anchorOf.get(r) ?? r))];
    const { rows: ag } = await this.d.pool.query(
      `SELECT scope_id, id::text AS id FROM agents WHERE kind = 'orchestrator' AND parent_id IS NULL AND scope_id = ANY($1::text[])`, [anchors]);
    const agentOf = new Map<string, string>(ag.map((r: any) => [r.scope_id, r.id]));
    // A channel whose card is off (or that has no card) is skipped unless it planned slots; a card's off mode wins.
    const off = new Set(cards.filter((c) => c.mode === 'off').map((c) => `telegram:${c.channelKey}`));
    return {
      slots,
      resources: refs.filter((r) => !off.has(r)).map((ref) => ({
        ref, tz: tzOf.get(ref) ?? 'Europe/Kyiv', minPerDay: minOf.get(ref) ?? 0, agentId: agentOf.get(anchorOf.get(ref) ?? ref) ?? null,
      })),
    };
  }

  /** Throttled check from the scheduler tick; returns the number of new Inbox notes. */
  async check(cards: EditorCard[], now: Date, paused?: ReadonlySet<string>): Promise<number> {
    const every = this.d.everyMs ?? SILENT_CHECK_EVERY_MS;
    if (every > 0 && now.getTime() - this.lastRun < every) return 0;
    this.lastRun = now.getTime();
    const { slots, resources } = await this.load(cards, now);
    const alerts = evaluateSilentDays({ now, resources, slots, streakN: this.d.streakN, paused });
    let n = 0;
    for (const a of alerts) {
      const item: InboxItemInput & { refType: string; refId: string } = {
        agentId: a.agentId, kind: a.kind, severity: 'action', title: a.title, body: a.body, ...dailyRef(a.ref, a.day),
      };
      try {
        if ((await this.d.inbox.postOnce(item)) != null) n++;
      } catch (err: any) {
        this.d.log?.(`silent-day note ${a.kind} for ${a.ref} failed: ${err?.message ?? err}`);
      }
    }
    return n;
  }
}
