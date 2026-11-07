/**
 * Spec 091 FR-003 / FR-010: the channel SLO controller. One tick per scheduler tick (code only, no LLM): for every channel it
 * computes the day's target, counts the day, sets the state, and, under per-tick caps, asks for one replacement slot (behind)
 * or one dark-recovery run (dark). A closed slot reaches it through `onSlotClosed` (fire-and-forget from the close paths).
 *
 * The parts it is given: `SlotInserter` (puts a slot into the plan), `RungPlanner` (what the slot should be),
 * `DarkRecovery` (a forced planner run for a dark channel). The controller owns the decisions and the counters.
 */
import type { Pool } from 'pg';
import type { ChannelMode, EditorCard } from '../card';
import type { OwnerInbox } from '../agents/owner-inbox';
import { dailyRef } from '../agents/owner-inbox';
import type { AutonomyDecisionsRepository } from '../autonomy/autonomy-decisions.repository';
import { remainingCapacity } from '../roles/plan-rules';
import { localDate, zonedToUtc } from '../roles/time';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { classifyClose, type SkipCause } from '../series-pause/skip-cause';
import type { StreakHit } from '../series-pause/streak';
import type { ChannelSloRepository } from './channel-slo.repository';
import { dailyTarget, sloState } from './slo-target';
import type { ClosedSlot, DarkRecovery, RungKind, RungPlanner, SlotInserter, SloSlotMark, SloState } from './types';
import { MAX_REPLACEMENT_DEPTH } from './slot-inserter';

type Env = (k: string) => string | undefined;

export const SLO_RECOVERY_GATE = 'slo_recovery';
/** Inbox kind of the 72-hour note. Not one of 090's INFO_ONLY_NOTE_KINDS: it is an `action` note. */
export const CHANNEL_DARK_NOTE_KIND = 'channel_dark';
export const CHANNEL_DARK_REF = 'channel_dark';
export const CHANNEL_STARVED_NOTE_KIND = 'channel_starved';
export const DARK_NOTE_AFTER_HOURS = 72;
const HOUR = 3_600_000;

const num = (env: Env, key: string, def: number, min: number, max: number): number => {
  const n = Number(env(key)?.trim());
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** What the module computes per channel from the pause tables, the agent runtime and the schedule (all read-only). */
export interface SloChannelContext {
  /** The effective mode (orchestrator and card, the lowest). */
  mode:             ChannelMode;
  /** Why the channel owes nothing today (agent paused, an owner resource pause, every series owner-paused), or null. */
  heldReason:       string | null;
  playbookPerDay:   { min: number; max: number } | null;
  /** Daily posts owed to series the OWNER paused. */
  ownerPausedSlots: number;
}

export interface SloControllerDeps {
  pool:      Pick<Pool, 'query'>;
  repo:      Pick<ChannelSloRepository, 'upsert' | 'bump' | 'get'>;
  inserter:  SlotInserter;
  planner:   RungPlanner;
  dark:      DarkRecovery;
  env:       Env;
  /** The channel's mode, hold and schedule inputs. */
  context:   (card: EditorCard, pausedRefs: ReadonlySet<string>, day: string, now: Date) => Promise<SloChannelContext>;
  /** A channel card by key (an event arrives with a slot id, not a card). */
  card:      (channelKey: string) => Promise<EditorCard | null>;
  /** The slot as it is now (the close paths hand over an id). */
  slot:      (id: string) => Promise<EditorSlot | null>;
  /** Does the budget gate allow another run for this channel? Absent = yes. */
  budget?:   (card: EditorCard) => Promise<{ ok: true } | { ok: false; reason: string }>;
  inbox?:    Pick<OwnerInbox, 'postOnce'>;
  agentOf?:  (channelKey: string) => Promise<string | null>;
  decisions?: Pick<AutonomyDecisionsRepository, 'record'>;
  log?:      (m: string) => void;
}

interface Counts {
  published: number; plannedAhead: number; skipped: number; lastPostAt: Date | null;
  /** The rungs of today's controller slots, and whether one of them is still open / was inserted in the last hour. */
  rungs: RungKind[]; openSlo: boolean; recentOpenSlo: boolean;
}

interface Assessment {
  card: EditorCard; day: string; ctx: SloChannelContext; counts: Counts;
  target: number; held: boolean; capacityLeft: number; state: SloState; reason: string | null; darkSince: Date | null;
}

type CardWithCreated = EditorCard & { createdAt?: Date };

export class SloController {
  /** Local days (per channel) on which the rung planner returned null: the ladder is exhausted for the day. */
  private readonly starvedOn = new Map<string, string>();
  private readonly streaks = new Map<string, { at: Date; n: number; reason: string }>();
  private readonly lastRecovery = new Map<string, Date>();
  private readonly seen = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private lastPaused: ReadonlySet<string> = new Set();

  constructor(private readonly d: SloControllerDeps) {}

  enabled(): boolean { return (this.d.env('SLO_CONTROLLER') ?? 'on').trim() !== 'off'; }

  /** FR-002: the breaker hands over a streak of a channel's own plain slots; it counts toward `starved`. */
  onPlainStreak(channelKey: string, hit: StreakHit): void {
    this.streaks.set(channelKey, { at: hit.lastAt, n: hit.n, reason: hit.reason });
  }

  /** Test seam: mark a channel's ladder as exhausted for a day. */
  markStarved(channelKey: string, day: string): void { this.starvedOn.set(channelKey, day); }

  // ── the tick (FR-010) ────────────────────────────────────────────────────────

  /**
   * One pass over the channels: target, counts, state, the row; then at most one replacement (behind) and one recovery
   * run (dark) per channel. Never throws: one channel's failure is logged and the next one runs.
   */
  async tick(cards: EditorCard[], now: Date, pausedRefs: ReadonlySet<string> = new Set()): Promise<void> {
    if (!this.enabled() || !cards.length) return;
    this.lastPaused = pausedRefs;
    let counts: Map<string, Counts>;
    try { counts = await this.countDays(cards, now); } catch (err: any) {
      this.d.log?.(`SLO counts failed: ${err?.message ?? err}`);
      return;
    }
    for (const card of cards) {
      try {
        await this.serial(card.channelKey, async () => {
          const a = await this.assess(card, now, pausedRefs, counts.get(card.channelKey) ?? emptyCounts());
          if (!a || a.state === 'held') return;
          if (a.state === 'dark') await this.recoverDark(a, now);
          else if (a.state === 'behind') await this.replaceLatest(a, now);
        });
      } catch (err: any) {
        this.d.log?.(`SLO tick of ${card.channelKey} failed: ${err?.message ?? err}`);
      }
    }
  }

  // ── events: a slot closed without a post (FR-003) ───────────────────────────

  /**
   * Fire-and-forget from the close paths (`skipByCode`, the ladder's final skip, `skipStale`, the executor's end): it
   * logs and swallows every error, so it can never fail the run that closed the slot.
   */
  onSlotClosed(slotId: string, now: Date = new Date()): void {
    if (!this.enabled() || this.seen.has(slotId)) return;
    void this.handleClosed(slotId, now).catch((err: any) => this.d.log?.(`SLO replacement for ${slotId} failed: ${err?.message ?? err}`));
  }

  /** Awaitable form of `onSlotClosed` (tests). Returns the new slot id, or null. */
  async handleClosed(slotId: string, now: Date = new Date()): Promise<string | null> {
    if (!this.enabled()) return null;
    const slot = await this.d.slot(slotId);
    if (!slot || slot.kind !== 'content' || (slot.status !== 'skipped' && slot.status !== 'failed')) return null;
    if (this.seen.has(slotId)) return null;                                                      // the runner hook and the scheduler both report a close
    this.seen.add(slotId);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    if (slot.resourceRef && slot.resourceRef !== `telegram:${slot.channelKey}`) return null;      // another platform: not the channel's minimum
    if (slot.approvedAt || slot.ownerEdited || slot.rejectReason) return null;                   // the owner touched it: an approval hold, not a miss
    const c = classifyClose({ status: slot.status, error: slot.error, criticVerdict: slot.critic?.verdict ?? null });
    if (c.k === 'ignore' || c.k === 'out') return null;                                           // budget, config, the owner's own decisions
    const cause: SkipCause = c.k === 'cause' ? c.cause : 'quality';                              // an unclassified skip: the cheapest rungs
    const card = await this.d.card(slot.channelKey);
    if (!card) return null;
    return this.serial(slot.channelKey, async () => {
      const a = await this.assess(card, now, this.lastPaused, null);
      if (!a || a.state === 'held' || a.state === 'dark') return null;                            // a dark channel is recovered by its own path
      return this.replace(a, toClosed(slot), cause, now);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  /** The grouped read of FR-010 step 2: published, planned ahead, skipped, last post, and the controller's own slots, for every channel's local day. */
  private async countDays(cards: EditorCard[], now: Date): Promise<Map<string, Counts>> {
    const keys: string[] = [], froms: Date[] = [], tos: Date[] = [];
    for (const c of cards) {
      const from = zonedToUtc(localDate(now, c.timezone), '00:00', c.timezone);
      keys.push(c.channelKey); froms.push(from); tos.push(new Date(from.getTime() + 86_400_000));
    }
    const W = `SELECT t.channel_key, t.d_from, t.d_to FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS t(channel_key, d_from, d_to)`;
    const { rows } = await this.d.pool.query(
      `WITH w AS (${W})
       SELECT w.channel_key,
              (SELECT count(*) FROM editor_slots s WHERE s.channel_key = w.channel_key AND s.kind = 'content' AND s.resource_ref IS NULL
                  AND s.scheduled_at >= w.d_from AND s.scheduled_at < w.d_to AND s.status = 'published')::int AS pub_slots,
              (SELECT count(*) FROM editor_slots s WHERE s.channel_key = w.channel_key AND s.kind = 'content' AND s.resource_ref IS NULL
                  AND s.scheduled_at >= w.d_from AND s.scheduled_at < w.d_to AND s.status IN ('planned','running','awaiting_approval','approved'))::int AS ahead,
              (SELECT count(*) FROM editor_slots s WHERE s.channel_key = w.channel_key AND s.kind = 'content' AND s.resource_ref IS NULL
                  AND s.scheduled_at >= w.d_from AND s.scheduled_at < w.d_to AND s.status IN ('skipped','failed')
                  AND COALESCE(s.error, '') !~ '^(superseded by a new plan|mode_changed|draft canceled)')::int AS skipped,
              (SELECT count(*) FROM published_posts p WHERE p.channel_id = w.channel_key AND p.posted_at >= w.d_from AND p.posted_at < w.d_to)::int AS pub_posts,
              (SELECT max(p.posted_at) FROM published_posts p WHERE p.channel_id = w.channel_key) AS last_post,
              (SELECT max(s.scheduled_at) FROM editor_slots s WHERE s.channel_key = w.channel_key AND s.kind = 'content' AND s.status = 'published') AS last_slot
         FROM w`, [keys, froms, tos]);
    const { rows: marks } = await this.d.pool.query(
      `WITH w AS (${W})
       SELECT s.channel_key, s.slo->>'rung' AS rung, s.status, s.created_at
         FROM w JOIN editor_slots s ON s.channel_key = w.channel_key AND s.slo IS NOT NULL AND s.kind = 'content'
          AND s.scheduled_at >= w.d_from AND s.scheduled_at < w.d_to`, [keys, froms, tos]);
    const out = new Map<string, Counts>();
    for (const r of rows) {
      const lastPost = [r.last_post, r.last_slot].filter(Boolean).map((x: any) => new Date(x)).sort((a: Date, b: Date) => b.getTime() - a.getTime())[0] ?? null;
      out.set(r.channel_key, {
        published: Math.max(Number(r.pub_slots), Number(r.pub_posts)), plannedAhead: Number(r.ahead), skipped: Number(r.skipped),
        lastPostAt: lastPost, rungs: [], openSlo: false, recentOpenSlo: false,
      });
    }
    for (const m of marks) {
      const c = out.get(m.channel_key);
      if (!c) continue;
      if (m.rung) c.rungs.push(m.rung as RungKind);
      if (['planned', 'running', 'awaiting_approval', 'approved'].includes(m.status)) {
        c.openSlo = true;
        if (now.getTime() - new Date(m.created_at).getTime() < HOUR) c.recentOpenSlo = true;
      }
    }
    return out;
  }

  /** Counts for one channel (the event path). */
  private async countOne(card: EditorCard, now: Date): Promise<Counts> {
    return (await this.countDays([card], now)).get(card.channelKey) ?? emptyCounts();
  }

  /** FR-001 + FR-002 + FR-010 steps 1-4: target, state and the upserted day row. */
  private async assess(card: EditorCard, now: Date, paused: ReadonlySet<string>, known: Counts | null): Promise<Assessment | null> {
    const day = localDate(now, card.timezone);
    const counts = known ?? await this.countOne(card, now);
    const ctx = await this.d.context(card, paused, day, now);
    const prev = await this.d.repo.get(card.channelKey, day).catch(() => null);
    const modeHeld = ctx.mode !== 'live' && ctx.mode !== 'approve' ? `mode is ${ctx.mode}` : null;
    const capacityLeft = remainingCapacity(card, day, now);
    const t = dailyTarget({
      cardMin: card.postsPerDayMin, playbookPerDay: ctx.playbookPerDay, ownerPausedSlots: ctx.ownerPausedSlots,
      heldReason: modeHeld ?? ctx.heldReason, capacityLeft, published: counts.published, plannedAhead: counts.plannedAhead,
      previousTarget: prev?.target ?? null,
    });
    const darkHours = num(this.d.env, 'SLO_DARK_HOURS', 24, 6, 168);
    const recovering = counts.recentOpenSlo || (this.lastRecovery.get(card.channelKey) ?? new Date(0)).getTime() > now.getTime() - HOUR;
    const streak = this.streaks.get(card.channelKey);
    const starvedToday = this.starvedOn.get(card.channelKey) === day || prev?.state === 'starved'
      || (!!streak && now.getTime() - streak.at.getTime() < 24 * HOUR && counts.rungs.length >= 2 && !counts.openSlo);
    const created = (card as CardWithCreated).createdAt;
    const st = sloState({
      target: t.target, held: t.held, heldReason: t.reason, published: counts.published, plannedAhead: counts.plannedAhead, capacityLeft,
      recovering, ladderExhausted: starvedToday, lastPostAt: counts.lastPostAt,
      activeSince: created ? new Date(created) : null, darkHours, now,
    });
    let reason = st.reason ?? t.reason;
    if (st.state === 'starved' && streak) reason = `${reason}; ${streak.n} plain slots in a row skipped (${streak.reason})`.slice(0, 300);
    await this.d.repo.upsert({
      channelKey: card.channelKey, day, target: t.target, published: counts.published, plannedAhead: counts.plannedAhead,
      skipped: counts.skipped, state: st.state, reason, lastPostAt: counts.lastPostAt, darkSince: st.darkSince,
    });
    return { card, day, ctx, counts, target: t.target, held: t.held, capacityLeft, state: st.state, reason, darkSince: st.darkSince };
  }

  /** Step 5 of the tick: a `behind` channel with no open replacement gets one for the newest closed slot of the day that has none. */
  private async replaceLatest(a: Assessment, now: Date): Promise<void> {
    if (a.counts.openSlo) return;
    const from = zonedToUtc(a.day, '00:00', a.card.timezone);
    const { rows } = await this.d.pool.query(
      `SELECT s.id FROM editor_slots s
        WHERE s.channel_key = $1 AND s.kind = 'content' AND s.resource_ref IS NULL AND s.status IN ('skipped','failed')
          AND s.scheduled_at >= $2 AND s.scheduled_at < $3 AND s.replaces_slot_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM editor_slots r WHERE r.replaces_slot_id = s.id)
          AND COALESCE(s.slo->>'depth', '0')::int < ${MAX_REPLACEMENT_DEPTH}
        ORDER BY s.scheduled_at DESC LIMIT 8`,
      [a.card.channelKey, from, new Date(from.getTime() + 86_400_000)]);
    for (const r of rows) {
      const slot = await this.d.slot(String(r.id));
      if (!slot || slot.approvedAt || slot.ownerEdited || slot.rejectReason) continue;
      const c = classifyClose({ status: slot.status, error: slot.error, criticVerdict: slot.critic?.verdict ?? null });
      if (c.k === 'ignore' || c.k === 'out') continue;
      if (await this.replace(a, toClosed(slot), c.k === 'cause' ? c.cause : 'quality', now)) return;   // at most one per channel per tick
      if (this.starvedOn.get(a.card.channelKey) === a.day) return;
    }
  }

  /**
   * FR-003: the trigger rules, then one replacement through the rung planner and the inserter. Returns the new slot id.
   * Caller holds the channel's serial lock.
   */
  private async replace(a: Assessment, closed: ClosedSlot, cause: SkipCause, now: Date): Promise<string | null> {
    const { card, day } = a;
    if (localDate(closed.scheduledAt, card.timezone) !== day) return null;                       // only today's misses are made up
    if (a.counts.published + a.counts.plannedAhead >= a.target) return null;
    if (a.capacityLeft <= 0) return null;
    if (a.state === 'starved' || this.starvedOn.get(card.channelKey) === day) return null;
    if ((closed.slo?.depth ?? 0) >= MAX_REPLACEMENT_DEPTH) return null;                          // one try and one retry
    if (this.d.budget) {
      const b = await this.d.budget(card).catch(() => ({ ok: true as const }));
      if (!b.ok) { this.d.log?.(`SLO: no replacement for ${card.channelKey}: ${b.reason}`); return null; }
    }
    const choice = await this.d.planner.choose(card, closed, cause, a.counts.rungs, now);
    if (!choice) { await this.starved(a); return null; }
    const mark: SloSlotMark = { replaces: closed.id, rung: choice.rung, cause, depth: (closed.slo?.depth ?? 0) + 1 };
    const id = await this.d.inserter.insert(card, choice.spec, mark, now);
    if (!id) return null;
    a.counts.plannedAhead += 1;
    a.counts.rungs.push(choice.rung);
    a.counts.openSlo = true;
    await this.d.repo.bump(card.channelKey, day, 'replacements');
    this.d.log?.(`SLO: ${card.channelKey} got a replacement (${choice.rung}) for slot ${closed.id}`);
    return id;
  }

  /** The ladder has no rung left for today: `starved` (no more replacements today) and one info note. */
  private async starved(a: Assessment): Promise<void> {
    const { card, day } = a;
    this.starvedOn.set(card.channelKey, day);
    const short = Math.max(0, a.target - a.counts.published - a.counts.plannedAhead);
    await this.d.repo.upsert({
      channelKey: card.channelKey, day, target: a.target, published: a.counts.published, plannedAhead: a.counts.plannedAhead,
      skipped: a.counts.skipped, state: 'starved', reason: `${short} post(s) short and no recovery rung left today`,
      lastPostAt: a.counts.lastPostAt, darkSince: a.darkSince,
    });
    if (!this.d.inbox) return;
    try {
      await this.d.inbox.postOnce({
        agentId: (await this.d.agentOf?.(card.channelKey).catch(() => null)) ?? null, kind: CHANNEL_STARVED_NOTE_KIND, severity: 'info',
        title: `${card.channelKey} is short of material today: ${a.counts.published} of ${a.target} posts`,
        body: `The recovery ladder has no rung left for ${day}: ${short} post(s) short. The channel is not paused; it tries again tomorrow.`,
        ...dailyRef(`telegram:${card.channelKey}`, `${day}|starved`),
      });
    } catch (err: any) { this.d.log?.(`starved note of ${card.channelKey} failed: ${err?.message ?? err}`); }
  }

  /**
   * FR-005 under its caps: at most once per SLO_DARK_HOURS and SLO_MAX_RECOVERY_RUNS_PER_DAY a day; one recovery run per
   * channel per tick. Also the 72-hour owner note.
   */
  private async recoverDark(a: Assessment, now: Date): Promise<void> {
    try { await this.recover(a, now); } finally { await this.darkNote(a, now); }   // the note says what was tried, this run included
  }

  private async recover(a: Assessment, now: Date): Promise<void> {
    const { card, day } = a;
    const maxRuns = num(this.d.env, 'SLO_MAX_RECOVERY_RUNS_PER_DAY', 3, 0, 10);
    const darkHours = num(this.d.env, 'SLO_DARK_HOURS', 24, 6, 168);
    // A run needs room: none in quiet hours or a full rest of the day (it would plan nothing and start the cooldown), and none
    // while the day still has slots to run (a re-plan would supersede them; their skips bring the run back).
    if (a.capacityLeft <= 0 || a.counts.plannedAhead > 0) return;
    const row = await this.d.repo.get(card.channelKey, day).catch(() => null);
    if (maxRuns <= 0 || (row?.recoveryRuns ?? 0) >= maxRuns) return;
    const last = await this.lastRecoveryAt(card.channelKey);
    // The SLO_DARK_HOURS spacing holds within the channel's local day; a new day may run again (from its first free hour).
    if (last && localDate(last, card.timezone) === day && now.getTime() - last.getTime() < darkHours * HOUR) return;
    if (this.d.budget) {
      const b = await this.d.budget(card).catch(() => ({ ok: true as const }));
      if (!b.ok) { this.d.log?.(`SLO: no recovery run for ${card.channelKey}: ${b.reason}`); return; }
    }
    this.lastRecovery.set(card.channelKey, now);                    // set first: a slow run must not be started twice
    const lastSkips = await this.lastSkipReasons(card.channelKey);
    let summary: string;
    try {
      const r = await this.d.dark.recover(card, {
        darkSince: a.darkSince ?? now, lastSkips, target: a.target, runsToday: row?.recoveryRuns ?? 0,
      }, now);
      summary = r.summary;
    } catch (err: any) {
      summary = `recovery run failed: ${String(err?.message ?? err).slice(0, 200)}`;
      this.d.log?.(`SLO recovery of ${card.channelKey} failed: ${err?.message ?? err}`);
    }
    await this.d.repo.bump(card.channelKey, day, 'recovery_runs');
    await this.d.decisions?.record({
      gate: SLO_RECOVERY_GATE, refType: 'channel', refId: card.channelKey, channelKey: card.channelKey, action: 'applied',
      summary: `${card.channelKey} is dark (${a.reason ?? 'no post'}): ${summary}`, at: now,
    });
  }

  private async lastRecoveryAt(channelKey: string): Promise<Date | null> {
    const mem = this.lastRecovery.get(channelKey);
    try {
      const { rows } = await this.d.pool.query(
        `SELECT max(decided_at) AS at FROM autonomy_decisions WHERE gate = $1 AND ref_type = 'channel' AND ref_id = $2`, [SLO_RECOVERY_GATE, channelKey]);
      const db = rows[0]?.at ? new Date(rows[0].at) : null;
      return db && (!mem || db > mem) ? db : mem ?? null;
    } catch { return mem ?? null; }
  }

  /** The last 5 skip reasons of the channel, newest first. */
  private async lastSkipReasons(channelKey: string): Promise<string[]> {
    try {
      const { rows } = await this.d.pool.query(
        `SELECT error FROM editor_slots WHERE channel_key = $1 AND kind = 'content' AND status IN ('skipped','failed') AND error IS NOT NULL
            AND error !~ '^(superseded by a new plan|mode_changed|draft canceled)'
          ORDER BY scheduled_at DESC LIMIT 5`, [channelKey]);
      return rows.map((r: any) => String(r.error).replace(/\s+/g, ' ').slice(0, 160));
    } catch { return []; }
  }

  /** FR-005: once per dark stretch (keyed by `dark_since`), at 72 h dark, one `action` note with the reasons and what was tried. */
  private async darkNote(a: Assessment, now: Date): Promise<void> {
    if (!this.d.inbox || !a.darkSince || now.getTime() - a.darkSince.getTime() < DARK_NOTE_AFTER_HOURS * HOUR) return;
    const { card } = a;
    try {
      const skips = await this.lastSkipReasons(card.channelKey);
      const { rows: tried } = await this.d.pool.query(
        `SELECT summary FROM autonomy_decisions WHERE gate = $1 AND ref_type = 'channel' AND ref_id = $2 AND decided_at >= $3
          ORDER BY decided_at DESC LIMIT 5`, [SLO_RECOVERY_GATE, card.channelKey, a.darkSince]).catch(() => ({ rows: [] as any[] }));
      const body = [
        `${card.channelKey} has had no post since ${a.counts.lastPostAt ? `${a.counts.lastPostAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'it became active'}.`,
        a.reason ? `State: ${a.reason}.` : '',
        skips.length ? `Last skip reasons:\n${skips.map((s) => `- ${s}`).join('\n')}` : 'There were no recent skips: the channel has not planned anything.',
        tried.length ? `Tried:\n${tried.map((t: any) => `- ${t.summary}`).join('\n')}` : 'Recovery runs and evergreen posts are tried automatically; none has got a post out yet.',
        'The channel is not paused. Check its sources and the planner runs (Editor, Runs), or pause the channel yourself if this is intended.',
      ].filter(Boolean).join('\n\n');
      await this.d.inbox.postOnce({
        agentId: (await this.d.agentOf?.(card.channelKey).catch(() => null)) ?? null, kind: CHANNEL_DARK_NOTE_KIND, severity: 'action',
        title: `Channel dark for 3 days: ${card.channelKey}`, body,
        alert: { title: `Канал ${card.channelKey} без постів 3 дні`, body: 'Система пробувала відновити його сама й не змогла. Деталі в Inbox.' },
        refType: CHANNEL_DARK_REF, refId: `${card.channelKey}|${a.darkSince.toISOString()}`,
      });
    } catch (err: any) { this.d.log?.(`dark note of ${card.channelKey} failed: ${err?.message ?? err}`); }
  }
}

const emptyCounts = (): Counts => ({ published: 0, plannedAhead: 0, skipped: 0, lastPostAt: null, rungs: [], openSlo: false, recentOpenSlo: false });

/** The slot as the rung planner reads it. */
export function toClosed(s: EditorSlot): ClosedSlot {
  return {
    id: s.id, channelKey: s.channelKey, scheduledAt: s.scheduledAt, status: s.status as 'skipped' | 'failed', error: s.error, format: s.format,
    topic: s.topic, seriesName: s.seriesName ?? null, topicMode: s.topicMode ?? 'fixed', live: s.liveSpec ?? null, sourceHints: s.sourceHints ?? [],
    slo: s.slo ?? null,
  };
}
