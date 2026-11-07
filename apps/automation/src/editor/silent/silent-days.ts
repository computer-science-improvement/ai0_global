import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { dailyRef, type InboxItemInput, type OwnerInbox, type SilentDayKind } from '../agents/owner-inbox';
import { localDate, localHour, localTimeLabel } from '../roles/time';
import { shiftDate } from '../schedule/schedule-rules';
import { attemptRejections, type SlotFallback } from './fallback-ladder';
import { evergreenFilled } from './evergreen-stats';
import { pauseActions, type PauseTarget } from '../series-pause/note-actions';
import { seriesIdOf } from '../series-pause/streak';
import { addSkip, isCriticRejection, isNotAMiss, isOwnerDecision, skipGroupOf, type SkipCounts } from './skip-reasons';
import { errText } from '../../common/err-text';
import { reasonFor, reasonOfError, reasonText } from '../reasons/catalogue';
import { dailyTarget } from '../slo/slo-target';
import type { SloState } from '../slo/types';

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
  /**
   * Spec 091 FR-007: the day's `channel_slo` row of the channel, when the controller wrote one. Its `target` replaces `minPerDay`;
   * `held` (target 0: off, shadow, owner or agent paused) has no dark day; a `starved` or `dark` channel is reported even when
   * its resource is in the `paused` set.
   */
  slo?:      { target: number; state: SloState } | null;
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
  /** Spec 060 FR-003: the problem and what the note says (see `OwnerInbox.postOnce`), and the owner's Telegram wording. */
  subject:  string;
  parts:    string[];
  alert:    { title: string; body: string };
  /** Spec 060 FR-004: the series this note is about (a «Пауза серії» button each, at most two). Empty when none is a series. */
  pauses:   PauseTarget[];
  /** Spec 069 A8: the note is about a PAST day; it never supersedes or retargets the notes of a later day. */
  pastDay?: boolean;
}

/** The series a set of slots belongs to, as `series_pauses` keys them (a plain slot has none: pausing a whole resource is not offered). */
export function pauseTargets(slots: WatchSlot[]): PauseTarget[] {
  const out: PauseTarget[] = [];
  for (const s of slots) {
    if (!s.ref.startsWith('telegram:') || (!s.seriesName && !s.scheduleRuleId)) continue;
    const id = seriesIdOf({
      id: s.id, channelKey: s.ref.slice('telegram:'.length), resourceRef: s.ref, seriesName: s.seriesName, scheduleRuleId: s.scheduleRuleId, topic: s.topic,
      scheduledAt: s.scheduledAt, updatedAt: s.updatedAt, status: s.status, error: s.error, criticVerdict: s.criticVerdict,
    });
    if (!out.some((t) => t.channelKey === id.channelKey && t.key === id.key)) out.push({ channelKey: id.channelKey, key: id.key, label: id.label });
  }
  return out;
}

/** Spec 060 FR-003: one subject for the day's misses (series_missed + dark_day merge into it) and one for the critic streak. */
export const missSubject = (ref: string) => `silent:${ref}:miss`;
export const criticSubject = (ref: string) => `silent:${ref}:critic`;
const STATUS_UK: Record<string, string> = { skipped: 'пропущено', failed: 'не вдалося', expired: 'прострочено' };
const GROUP_UK: Record<string, string> = {
  critic: 'критик', lint: 'перевірки тексту', config: 'налаштування', cap: 'ліміти й тихі години', nothing_fresh: 'немає свіжого матеріалу', budget: 'бюджет', other: 'інше',
};

/**
 * Spec 073 FR-007 (A24): the groups of a close that can make a series STALLED — it stopped for a reason that is not the
 * material running out (`nothing_fresh`), not the owner's decision, not the critic's verdict and not the budget: the
 * planner skipped it (`planner_skipped`, group `other`), a check of the text failed (`lint`), the slot's configuration is wrong
 * (`config`), or anything else (`other`).
 */
const STALL_GROUPS = new Set(['lint', 'config', 'other']);

/** The catalogue code of a slot error (`planner_skipped`, `lint_failed`, …), or its skip group (also a catalogue code) for a free-text one. */
function errorCodeOf(error: string | null | undefined, group: string): string {
  return reasonOfError(error) ?? group;
}

/**
 * The series that have not gone out two local days in a row: on both `today` and the day before, the series has slots, every
 * one closed (skipped / failed / expired) for a qualifying reason (`STALL_GROUPS`), and none went out. A material close
 * (nothing left to post) is the breaker's, the owner's own decisions are not a stall, and one post out on either day ends it.
 * Returns the series name → the code of today's latest close.
 */
export function stalledSeries(slots: WatchSlot[], today: string, tz: string): Map<string, string> {
  const yesterday = shiftDate(today, -1);
  const byName = new Map<string, { today: WatchSlot[]; before: WatchSlot[] }>();
  for (const s of slots) {
    if (!s.seriesName) continue;
    const d = localDate(s.scheduledAt, tz);
    if (d !== today && d !== yesterday) continue;
    const e = byName.get(s.seriesName) ?? { today: [], before: [] };
    (d === today ? e.today : e.before).push(s);
    byName.set(s.seriesName, e);
  }
  const stalled = (s: WatchSlot) => ENDED_NOT_OUT.has(s.status) && !isOwnerDecision(s.error) && STALL_GROUPS.has(skipGroupOf(s.error, s.criticVerdict));
  const out = new Map<string, string>();
  for (const [name, e] of byName) {
    if (!e.today.length || !e.before.length || !e.today.every(stalled) || !e.before.every(stalled)) continue;
    const latest = [...e.today].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    out.set(name, errorCodeOf(latest.error, skipGroupOf(latest.error, latest.criticVerdict)));
  }
  return out;
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
  /** Spec 069 A8: `<ref>|<day>` of the misses already reported (a `series_missed` / `dark_day` note exists); a PAST day among them is not reported again. */
  reportedDays?: ReadonlySet<string>;
}): SilentAlert[] {
  const streakN = Math.max(1, i.streakN ?? DEFAULT_REJECT_STREAK);
  const darkHour = i.darkHour ?? DARK_DAY_HOUR;
  const byRef = new Map<string, WatchSlot[]>();
  for (const s of i.slots) byRef.set(s.ref, [...(byRef.get(s.ref) ?? []), s]);
  const out: SilentAlert[] = [];

  for (const r of i.resources) {
    const stuck = r.slo?.state === 'starved' || r.slo?.state === 'dark';
    if (i.paused?.has(r.ref) && !stuck) continue;
    const slots = byRef.get(r.ref) ?? [];
    const minPerDay = r.slo ? r.slo.target : r.minPerDay;
    const today = localDate(i.now, r.tz);
    const dayOf = (s: WatchSlot) => localDate(s.scheduledAt, r.tz);
    const counted = slots.filter((s) => !isNotAMiss(s.error));

    // ── dark_day ────────────────────────────────────────────────────────────
    if (localHour(i.now, r.tz) >= darkHour && r.slo?.state !== 'held') {
      const planned = counted.filter((s) => dayOf(s) === today);
      if ((planned.length >= 1 || minPerDay >= 1) && !planned.some((s) => OUT.has(s.status))) {
        const reasons: SkipCounts = {};
        for (const s of planned) if (ENDED_NOT_OUT.has(s.status)) addSkip(reasons, skipGroupOf(s.error, s.criticVerdict));
        const later = planned.filter((s) => s.status === 'planned' || s.status === 'running' || s.status === 'approved' || s.status === 'awaiting_approval')
          .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
        const lastMiss = planned.filter((s) => ENDED_NOT_OUT.has(s.status)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
        const body = [
          planned.length
            ? `Planned today: ${planned.length}; out: 0; not out by reason: ${reasonsLine(reasons)}.`
            : `No slot was planned today although the channel's daily target is ${minPerDay} post(s) a day (check the planner runs).`,
          later.length ? `Still to come: ${later.length} (next at ${localTimeLabel(later[0].scheduledAt, r.tz)}, ${later[0].status}).` : '',
          lastMiss?.error ? `Latest: ${reasonText(lastMiss.error, 'en')}` : '',
          'Check the slots and the run traces on /app/editor.',
        ].filter(Boolean).join(' ');
        const groups = Object.keys(reasons).sort();
        out.push({
          kind: 'dark_day', ref: r.ref, day: today, agentId: r.agentId ?? null, slotIds: planned.map((s) => s.id),
          title: `Silent day: nothing went out on ${r.ref} by ${darkHour}:00`, body,
          subject: missSubject(r.ref), parts: planned.length ? ['dark', ...groups.map((g) => `dark:${g}`)] : ['dark', 'dark:no_plan'],
          pauses: pauseTargets(planned.filter((s) => ENDED_NOT_OUT.has(s.status))),
          alert: {
            title: `Тихий день: на ${r.ref} до ${darkHour}:00 нічого не вийшло`,
            body: [
              planned.length ? `Заплановано сьогодні: ${planned.length}, вийшло: 0${groups.length ? `; причини: ${groups.map((g) => GROUP_UK[g] ?? g).join(', ')}` : ''}.`
                : `Сьогодні не заплановано жодного слота, хоча денна ціль каналу — мінімум ${minPerDay}.`,
              later.length ? `Ще попереду: ${later.length}.` : '',
              'Слоти й сліди запусків — на /app/editor.',
            ].filter(Boolean).join('\n'),
          },
        });
      }
    }

    // ── series_missed (one note per resource and day, listing that day's misses) ──
    const missedByDay = new Map<string, WatchSlot[]>();
    for (const s of counted) {
      if (!s.seriesName && !s.scheduleRuleId) continue;
      // Spec 037 T10: an evergreen post that filled a series slot is not the series' post — the alert still fires.
      if ((!ENDED_NOT_OUT.has(s.status) && !evergreenFilled(s.fallback)) || isOwnerDecision(s.error)) continue;
      const d = dayOf(s);
      if (d > today) continue;
      // Spec 069 A8: yesterday is still inside the 48 h window, but its slot set shrinks as the window slides — a new part
      // set would be a new note. A past day is told once; a first miss reported late (after midnight) still goes out.
      if (d < today && i.reportedDays?.has(`${r.ref}|${d}`)) continue;
      missedByDay.set(d, [...(missedByDay.get(d) ?? []), s]);
    }
    // Spec 073 FR-007: a series that stopped on two local days in a row is one more part (and line) of today's note.
    const stalled = stalledSeries(counted, today, r.tz);
    for (const [day, miss] of missedByDay) {
      miss.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
      const stalledHere = day === today ? [...stalled].filter(([name]) => miss.some((s) => s.seriesName === name)) : [];
      // Spec 073 FR-014: the lines read the reason catalogue (label, the system's words, what to change), in English for the
      // dashboard body and in Ukrainian for the owner's Telegram note.
      const lineOf = (s: WatchSlot, lang: 'en' | 'uk') => {
        const ever = evergreenFilled(s.fallback);
        const uk = lang === 'uk';
        const who = s.seriesName ? (uk ? `серія «${s.seriesName}»` : `series "${s.seriesName}"`) : (uk ? 'слот за розкладом' : 'fixed slot');
        const status = uk ? (STATUS_UK[s.status] ?? s.status) : s.status;
        const what = ever
          ? (uk ? `замінено вічнозеленим постом (${status}); основний пост: ${clip(ever.reason, 160)}` : `filled by an evergreen post (${status}); the main post: ${clip(ever.reason, 160)}`)
          : `${status}: ${s.error ? reasonText(s.error, lang) : (uk ? 'причину не записано' : 'no reason recorded')}`;
        return `${localTimeLabel(s.scheduledAt, r.tz)} ${who} — ${what}`;
      };
      const lines = miss.slice(0, 4).map((s) => lineOf(s, 'en'));
      const linesUk = miss.slice(0, 4).map((s) => lineOf(s, 'uk'));
      const parts = [...new Set([
        ...miss.map((s) => `missed:${s.seriesName ?? `rule:${s.scheduleRuleId}`}:${evergreenFilled(s.fallback) ? 'evergreen' : skipGroupOf(s.error, s.criticVerdict)}`),
        ...stalledHere.map(([name]) => `stalled:${name}`),
      ])].sort();
      const stalledEn = stalledHere.map(([name, code]) => `Series "${name}" has not gone out two days in a row: ${reasonFor(code)?.en ?? code}`);
      const stalledUk = stalledHere.map(([name, code]) => `Серія «${name}» не виходить два дні поспіль: ${reasonFor(code)?.uk ?? code}`);
      out.push({
        kind: 'series_missed', ref: r.ref, day, agentId: r.agentId ?? null, slotIds: miss.map((s) => s.id),
        title: `Series or fixed slot missed on ${r.ref} (${day})`,
        body: [`${miss.length} series / fixed slot(s) did not go out:`, ...lines.map((l) => `• ${l}`), miss.length > 4 ? `• … and ${miss.length - 4} more` : '', ...stalledEn].filter(Boolean).join('\n'),
        subject: missSubject(r.ref), parts, pauses: pauseTargets(miss), ...(day < today ? { pastDay: true } : {}),
        alert: {
          title: `Серія чи слот за розкладом не вийшли на ${r.ref} (${day})`,
          body: [`Не вийшло: ${miss.length}.`, ...linesUk.map((l) => `• ${l}`), miss.length > 4 ? `• … і ще ${miss.length - 4}` : '', ...stalledUk].filter(Boolean).join('\n'),
        },
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
        subject: criticSubject(r.ref), parts: [`streak:${streak.n}`], pauses: pauseTargets(slots.filter((s) => streak.slotIds.includes(s.id))),
        alert: {
          title: `Критик відхилив пости поспіль на ${r.ref}: ${streak.n}`,
          body: 'Пости пишуться й відкидаються: перегляньте нотатки критика на слотах, профіль ресурсу й джерела на /app/editor.',
        },
      });
    }
  }
  return mergeDayNotes(out);
}

/**
 * Spec 060 FR-003: a `series_missed` and a `dark_day` of the same resource and day are one problem — one note, the
 * `dark_day` one, with the missed series listed under it. (A note posted earlier in the day is superseded by the
 * merged one: same subject, and its parts are not covered by the earlier note.)
 */
export function mergeDayNotes(alerts: SilentAlert[]): SilentAlert[] {
  const out: SilentAlert[] = [];
  for (const a of alerts) {
    const dark = a.kind === 'series_missed' ? alerts.find((x) => x.kind === 'dark_day' && x.ref === a.ref && x.day === a.day) : undefined;
    if (!dark) { out.push(a); continue; }
    dark.body = `${dark.body}\n\n${a.body}`;
    dark.alert = { title: dark.alert.title, body: `${dark.alert.body}\n\n${a.alert.body}` };
    dark.parts = [...new Set([...dark.parts, ...a.parts])];
    dark.slotIds = [...new Set([...dark.slotIds, ...a.slotIds])];
    dark.pauses = [...dark.pauses, ...a.pauses.filter((t) => !dark.pauses.some((d) => d.channelKey === t.channelKey && d.key === t.key))];
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
  /** Spec 068 FR-005: the card's minimum for a local day after the dead-series pauses (default: the card's own `postsPerDayMin`). */
  minPerDay?: (card: EditorCard, day: string, now: Date) => Promise<number>;
}

/** Spec 091 FR-007: `channel_slo` rows of the days around `now`, keyed `<channel_key>|<YYYY-MM-DD>`. A missing table is an empty map. */
async function sloRowsOf(pool: Pick<Pool, 'query'>, now: Date): Promise<Map<string, { target: number; state: SloState }>> {
  const out = new Map<string, { target: number; state: SloState }>();
  try {
    const { rows } = await pool.query(
      `SELECT channel_key, day::text AS day, target, state FROM channel_slo WHERE day >= ($1::timestamptz AT TIME ZONE 'UTC')::date - 1`, [now]);
    for (const r of rows) out.set(`${r.channel_key}|${r.day}`, { target: Number(r.target), state: r.state });
  } catch { /* the controller has not run yet */ }
  return out;
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
    const sloOf = new Map<string, { target: number; state: SloState }>();
    const sloRows = await sloRowsOf(this.d.pool, now);
    for (const c of cards) {
      const ref = `telegram:${c.channelKey}`;
      const row = sloRows.get(`${c.channelKey}|${localDate(now, c.timezone)}`);
      if (row) sloOf.set(ref, row);
      minOf.set(ref, row ? row.target : c.mode === 'off' ? 0 : await this.minOfCard(c, now));
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
        ref, tz: tzOf.get(ref) ?? 'Europe/Kyiv', minPerDay: minOf.get(ref) ?? 0, slo: sloOf.get(ref) ?? null, agentId: agentOf.get(anchorOf.get(ref) ?? ref) ?? null,
      })),
    };
  }

  /** The card's daily minimum for its local today: the pause-aware one when wired, else the card's own (a failure falls back too). */
  private async minOfCard(c: EditorCard, now: Date): Promise<number> {
    const own = Math.max(0, Number(c.postsPerDayMin) || 0);
    // Spec 091 FR-007: no day row (the controller is off or has not run): the pause-aware hook when wired, else the target rules on what is at hand.
    if (!this.d.minPerDay) return dailyTarget({ cardMin: own, capacityLeft: own, published: 0, plannedAhead: 0 }).target;
    try { return Math.max(0, Number(await this.d.minPerDay(c, localDate(now, c.timezone), now)) || 0); } catch { return own; }
  }

  /**
   * Spec 069 A8: the `<ref>|<day>` of every series_missed / dark_day note of the last days (their ref is `<ref>|<day>#<parts>`).
   * A failed lookup is an empty set: the gate still stops a repeat of the same parts.
   */
  private async reportedDays(): Promise<Set<string>> {
    try {
      const { rows } = await this.d.pool.query(
        `SELECT DISTINCT split_part(ref_id, '#', 1) AS day_ref FROM agent_inbox
          WHERE ref_type = 'resource_day' AND kind IN ('series_missed', 'dark_day') AND created_at > now() - interval '7 days'`);
      return new Set(rows.map((r: any) => String(r.day_ref)));
    } catch {
      return new Set();
    }
  }

  /** Throttled check from the scheduler tick; returns the number of new Inbox notes. */
  async check(cards: EditorCard[], now: Date, paused?: ReadonlySet<string>): Promise<number> {
    const every = this.d.everyMs ?? SILENT_CHECK_EVERY_MS;
    if (every > 0 && now.getTime() - this.lastRun < every) return 0;
    this.lastRun = now.getTime();
    const { slots, resources } = await this.load(cards, now);
    const alerts = evaluateSilentDays({ now, resources, slots, streakN: this.d.streakN, paused, reportedDays: await this.reportedDays() });
    let n = 0;
    for (const a of alerts) {
      const item: InboxItemInput & { refType: string; refId: string } = {
        agentId: a.agentId, kind: a.kind, severity: 'action', title: a.title, body: a.body, ...dailyRef(a.ref, a.day),
        alert: a.alert, gate: { subject: a.subject, parts: a.parts, ...(a.pastDay ? { standalone: true } : {}) }, actions: pauseActions(a.pauses),
      };
      try {
        if ((await this.d.inbox.postOnce(item)) != null) n++;
      } catch (err: any) {
        this.d.log?.(`silent-day note ${a.kind} for ${a.ref} failed: ${errText(err)}`);
      }
    }
    return n;
  }
}
