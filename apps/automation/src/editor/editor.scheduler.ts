import type { Pool } from 'pg';
import type { ChannelMode, EditorCard } from './card';
import { APPROVAL_BATCH_HOUR, batchDateDue, writeAt } from './approval/approval-timing';
import type { EditorChannelsRepository } from './repo/editor-channels.repository';
import { isPlaceholderPlan } from './repo/editor-plans.repository';
import type { EditorPlansRepository, EditorSlot } from './repo/editor-plans.repository';
import type { EditorRunnerService } from './roles/editor-runner.service';
import { PAUSED_ERROR, slotRef } from './pauses/resource-pauses';
import { localDate, localHour, localWeekday, zonedToUtc } from './roles/time';
import { plannerRunsOn } from './schedule/planner-runs';

export interface EditorSchedulerDeps {
  pool:     Pick<Pool, 'query'>;
  channels: Pick<EditorChannelsRepository, 'listActive'>;
  plans:    Pick<EditorPlansRepository, 'getActivePlan' | 'claimDue' | 'skipStale' | 'sweepStuck' | 'consecutiveFailures'>
    & Partial<Pick<EditorPlansRepository, 'plannedBefore' | 'claimSlot' | 'updateSlot'>>;
  runner:   Pick<EditorRunnerService, 'runPlanner' | 'runExecutor' | 'runReviewer'>;
  enabled:  () => boolean;
  notify:   (text: string) => Promise<void>;
  log?:     (msg: string) => void;
  /**
   * Deterministic publisher of reserved (paid ad) slots — no LLM. Runs on every
   * tick regardless of EDITOR_ENABLED and channel mode (spec 008 T003); the
   * channel's publish_paused still applies inside the publisher.
   */
  reserved?: { publishDue(now: Date): Promise<number> };
  /**
   * Spec 020: the orchestrator's daily run (directives, idea pool, playbook
   * upkeep), once per channel-day before planning. Optional.
   */
  orchestrate?: (card: EditorCard) => Promise<unknown>;
  /**
   * Spec 024 FR-003: pins the auto-duplicate gate of the channel's network for
   * its plan day, so a change takes effect at the next plan-day boundary.
   */
  pinGate?: (card: EditorCard, now: Date) => Promise<unknown>;
  /** Spec 023 FR-004: materialise the owner's pins (today and tomorrow) before planning; idempotent. */
  pins?: (card: EditorCard, now: Date) => Promise<unknown>;
  /** Spec 021: the MANAGER's schedule and directive deliveries, once per tick after planning. */
  afterTick?: (now: Date) => Promise<void>;
  /**
   * Spec 031 approval mode. `mode` is a channel's effective mode (orchestrator ∧
   * card); approval channels plan the next day at 20:00 and write slots ahead
   * (approval-timing). `tick` publishes approved posts, expires stale ones and
   * sends the batch alert, in its own lane like the reserved slots.
   */
  approval?: {
    mode(card: EditorCard): Promise<ChannelMode>;
    tick(now: Date): Promise<void>;
  };
  /**
   * Spec 025 FR-013: resource pauses. Each tick lifts the pauses whose time is up, holds the orchestration and
   * planning of a channel whose own resources are paused (`held`), and skips claimed content slots on a paused
   * resource (`skipped`, error `resource_paused`) — approval write-ahead included, so nothing waits for the owner.
   * Reserved slots (paid ads) are not this lane's.
   */
  /**
   * Spec 049 FR-002: why a claimed slot's resource cannot publish now (a broken connection), or null. Such a slot
   * is skipped with that reason instead of running the writer for a post that cannot go out.
   */
  unavailable?: (ref: string) => Promise<string | null>;
  pauses?: {
    liftDue(now: Date): Promise<unknown>;
    pausedRefs(now: Date): Promise<Set<string>>;
    held(card: EditorCard, paused: Set<string>): Promise<boolean>;
  };
  /**
   * Spec 034 FR-011: the news watch of a news resource — a code-only feed check on its cadence that adds a
   * live slot for a fresh item (cheap when not due). Runs after planning, never for a held channel.
   */
  newsWatch?: (card: EditorCard, now: Date) => Promise<unknown>;
  /**
   * Spec 037 FR-010: the silent-day notes (dark_day, series_missed, critic_reject_streak) — a code-only check of
   * the slots, throttled by the hook itself, one Inbox note per resource per day and kind. Paused resources are left out.
   */
  silentDays?: (cards: EditorCard[], now: Date, paused: ReadonlySet<string>) => Promise<unknown>;
  /**
   * Spec 060 FR-001: the dead-series breaker. `check` counts same-cause skip streaks, pauses a series that reached
   * SERIES_SKIP_STREAK and skips the planned slots of every paused series (`series_paused`, $0) — runs before slots
   * are claimed. `plainPaused` lists the channels whose own plain slots (no series) are paused: they are not planned.
   */
  seriesPauses?: { check(now: Date): Promise<unknown>; plainPaused(): Promise<Set<string>> };
  /**
   * Spec 091: the channel SLO controller. While `enabled()` it replaces the `plainPaused` gate (a channel is never stopped from
   * planning because its plain slots skipped): `tick` runs after the breaker check and before claiming, `onSlotClosed` is told
   * of every content slot that closed without a post (fire-and-forget; it never fails the run). `enabled()` false (SLO_CONTROLLER=off)
   * keeps today's path, `resource:` pauses and the gate included.
   */
  slo?: {
    enabled(): boolean;
    tick(cards: EditorCard[], now: Date, paused: ReadonlySet<string>): Promise<void>;
    onSlotClosed(slotId: string, now?: Date): void;
  };
  /**
   * Spec 091 FR-005: the moment up to which a channel's failed planner runs no longer count (the last dark-recovery run),
   * so a restart does not bring back the tries that recovery cleared. Absent = none.
   */
  triesFloor?: (channelKey: string) => Promise<Date | null>;
  /** Spec 037 FR-014: the post audit — daily per resource and at once after a rule change; throttled by the hook itself. */
  postAudit?: (now: Date) => Promise<unknown>;
  /**
   * Spec 037 FR-003 (T3): an announced event with no post within 24 h after it — one owner Inbox note per event
   * (code-only, throttled by the hook itself).
   */
  eventRecaps?: (now: Date) => Promise<unknown>;
}

/** How far ahead approval-mode slots are looked at for writing (the evening batch covers the next day). */
export const WRITE_AHEAD_WINDOW_MS = 36 * 3600_000;

export const STALE_MS          = 3 * 3600_000;
export const STUCK_MS          = 15 * 60_000;
export const PLANNER_RETRY_MS  = 30 * 60_000;
export const PLANNER_MAX_TRIES = 3;
export const EXECUTOR_PARALLEL = 2;
export const CLAIM_BATCH       = 3;
const REVIEW_MIN_CARD_AGE_MS   = 7 * 86_400_000;

/**
 * One tick per minute (wired to @Cron in EditorModule):
 *   housekeeping → plan (once per channel-day) → review (weekly) → execute due slots.
 * Ticks never overlap; a long planner/executor run simply makes later ticks skip.
 */
export class EditorScheduler {
  private busy = false;
  private readonly plannerTries = new Map<string, { n: number; at: number }>();
  private readonly alerted = new Set<string>();
  /** Spec 091 FR-005: per channel, the planner tries before this instant were cleared by a recovery run. */
  private readonly triesFloor = new Map<string, Date>();

  constructor(private readonly d: EditorSchedulerDeps) {}

  private reservedBusy = false;

  /**
   * Reserved slots (paid ads, scheduled chat posts, promos) have their own lock:
   * a long orchestrator / planner / manager tick never delays them (spec 022 review).
   */
  async cronTick(): Promise<void> {
    const now = new Date();
    await Promise.all([this.reservedTick(now), this.approvalTick(now), this.mainTick(now)]);
  }

  private approvalBusy = false;

  /** Approved posts go out at their time even while a long planner run holds the main tick (spec 031). */
  async approvalTick(now: Date): Promise<void> {
    if (!this.d.approval || this.approvalBusy || !this.d.enabled()) return;
    this.approvalBusy = true;
    try {
      await this.d.approval.tick(now);
    } catch (err: any) {
      this.d.log?.(`approval tick failed: ${err?.message ?? err}`);
    } finally {
      this.approvalBusy = false;
    }
  }

  private async reservedTick(now: Date): Promise<void> {
    if (!this.d.reserved || this.reservedBusy) return;
    this.reservedBusy = true;
    try {
      await this.d.reserved.publishDue(now);
    } catch (err: any) {
      this.d.log?.(`reserved slots failed: ${err?.message ?? err}`);
    } finally {
      this.reservedBusy = false;
    }
  }

  private async mainTick(now: Date): Promise<void> {
    if (this.busy || !this.d.enabled()) return;
    this.busy = true;
    try {
      await this.tick(now);
    } catch (err: any) {
      this.d.log?.(`editor tick failed: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  async tick(now: Date): Promise<void> {
    await this.d.plans.skipStale(now, STALE_MS, (ids) => { for (const id of ids) this.slotClosed(id, now); });
    await this.d.plans.sweepStuck(now, STUCK_MS);

    const cards = await this.d.channels.listActive();
    const byKey = new Map(cards.map((c) => [c.channelKey, c]));
    const approving = await this.approvingCards(cards);
    const paused = await this.pausedRefs(now);
    // Spec 091 FR-002: with the controller on, no channel is stopped from planning by a plain-slot pause (the controller recovers it).
    const plainPaused = this.sloOn() ? new Set<string>() : await this.plainPaused();

    for (const card of cards) {
      if (this.d.pinGate) {
        try { await this.d.pinGate(card, now); } catch (err: any) { this.d.log?.(`auto-duplicate gate of ${card.channelKey} failed: ${err?.message ?? err}`); }
      }
      const held = await this.held(card, paused);
      if (!held) await this.maybeOrchestrate(card, now);
      if (this.d.pins) await this.d.pins(card, now).catch((err: any) => this.d.log?.(`pins of ${card.channelKey} failed: ${err?.message ?? err}`));
      if (!held && !plainPaused.has(card.channelKey)) {
        await this.maybePlan(card, now);
        if (approving.has(card.channelKey)) await this.maybePlanAhead(card, now);
        if (this.d.newsWatch) {
          try { await this.d.newsWatch(card, now); } catch (err: any) { this.d.log?.(`news watch of ${card.channelKey} failed: ${err?.message ?? err}`); }
        }
      }
      await this.maybeReview(card as EditorCard & { createdAt?: Date }, now);
    }

    if (this.d.afterTick) {
      try { await this.d.afterTick(now); } catch (err: any) { this.d.log?.(`after-tick hook failed: ${err?.message ?? err}`); }
    }
    if (this.d.silentDays) {
      try { await this.d.silentDays(cards, now, paused); } catch (err: any) { this.d.log?.(`silent-day check failed: ${err?.message ?? err}`); }
    }
    if (this.d.seriesPauses) {
      try { await this.d.seriesPauses.check(now); } catch (err: any) { this.d.log?.(`series breaker failed: ${err?.message ?? err}`); }
    }
    if (this.sloOn()) {
      try { await this.d.slo!.tick(cards, now, paused); } catch (err: any) { this.d.log?.(`SLO controller failed: ${err?.message ?? err}`); }
    }
    if (this.d.postAudit) {
      try { await this.d.postAudit(now); } catch (err: any) { this.d.log?.(`post audit failed: ${err?.message ?? err}`); }
    }
    if (this.d.eventRecaps) {
      try { await this.d.eventRecaps(now); } catch (err: any) { this.d.log?.(`event recap check failed: ${err?.message ?? err}`); }
    }

    // Approval mode writes ahead of time; everything else (and late approval slots) at the slot time.
    const early = await this.claimWriteAhead(approving, byKey, now);
    const rest = early.length < CLAIM_BATCH ? await this.d.plans.claimDue(now, CLAIM_BATCH - early.length) : [];
    const due: EditorSlot[] = [];
    for (const s of [...early, ...rest]) {
      // Spec 073 FR-004: `claimDue` leaves an off channel's slots alone, so this is the owner switching the channel off
      // between the card read and the claim: close the slot with the NOT_A_MISS reason, never leave it running.
      if (!byKey.has(s.channelKey)) { await this.skip(s, 'mode_changed'); continue; }
      if (paused.has(slotRef(s))) { await this.skipPaused(s); continue; }
      const broken = await this.unavailable(s);
      if (broken) await this.skip(s, broken);
      else due.push(s);
    }
    await this.runLimited(due, EXECUTOR_PARALLEL, async (slot) => {
      await this.d.runner.runExecutor(slot, byKey.get(slot.channelKey)!);
      this.slotClosed(slot.id, now);        // spec 091: whatever way the run ended, the controller looks at a slot that closed without a post
      await this.checkFailures(slot.channelKey, now);
    });
  }

  /** Spec 025 FR-013: lift pauses whose time is up, then the refs paused now (empty without the hook or on error). */
  private async pausedRefs(now: Date): Promise<Set<string>> {
    if (!this.d.pauses) return new Set();
    try {
      await this.d.pauses.liftDue(now);
      return await this.d.pauses.pausedRefs(now);
    } catch (err: any) {
      this.d.log?.(`resource pauses failed: ${err?.message ?? err}`);
      return new Set();
    }
  }

  private sloOn(): boolean {
    try { return !!this.d.slo?.enabled(); } catch { return false; }
  }

  /** Spec 091 FR-003: tell the controller a slot closed (fire-and-forget; its own errors are logged there). */
  private slotClosed(id: string, now?: Date): void {
    if (!this.sloOn()) return;
    try { this.d.slo!.onSlotClosed(id, now); } catch (err: any) { this.d.log?.(`SLO close event of ${id} failed: ${err?.message ?? err}`); }
  }

  /**
   * Spec 091 FR-005: the dark-recovery part clears a channel's planner tries (the in-memory counter and, through the floor, the
   * count restored from `editor_runs` after a restart), so `maybePlan` may run the planner again today.
   */
  resetPlannerTries(channelKey: string, now: Date = new Date()): void {
    for (const k of [...this.plannerTries.keys()]) if (k.startsWith(`${channelKey}:`)) this.plannerTries.set(k, { n: 0, at: 0 });
    this.triesFloor.set(channelKey, now);
  }

  /**
   * Spec 091 FR-005: run the planner for one channel now, whatever its tries, with an extra context string appended to the
   * planner's user prompt (the dark reason, the last skip reasons, the instruction). The day's plan is replaced like any replan.
   */
  async runPlannerNow(card: EditorCard, extraContext: string | null = null): ReturnType<EditorSchedulerDeps['runner']['runPlanner']> {
    return this.d.runner.runPlanner(card, extraContext ? { extra: extraContext } : {});
  }

  /** Spec 060: channels whose own plain slots the breaker paused (empty without the hook or on error). */
  private async plainPaused(): Promise<Set<string>> {
    if (!this.d.seriesPauses) return new Set();
    try { return await this.d.seriesPauses.plainPaused(); } catch (err: any) {
      this.d.log?.(`series pauses failed: ${err?.message ?? err}`);
      return new Set();
    }
  }

  private async held(card: EditorCard, paused: Set<string>): Promise<boolean> {
    if (!paused.size || !this.d.pauses) return false;
    try { return await this.d.pauses.held(card, paused); } catch (err: any) {
      this.d.log?.(`pause check of ${card.channelKey} failed: ${err?.message ?? err}`);
      return false;
    }
  }

  /** Spec 049 FR-002: the reason a slot's resource cannot publish (null without the hook or on an error). */
  private async unavailable(slot: EditorSlot): Promise<string | null> {
    if (!this.d.unavailable) return null;
    try { return await this.d.unavailable(slotRef(slot)); } catch (err: any) {
      this.d.log?.(`health check of ${slotRef(slot)} failed: ${err?.message ?? err}`);
      return null;
    }
  }

  private async skip(slot: EditorSlot, reason: string): Promise<void> {
    try {
      await this.d.plans.updateSlot?.(slot.id, { status: 'skipped', error: reason });
    } catch (err: any) {
      this.d.log?.(`skipping slot ${slot.id} failed: ${err?.message ?? err}`);
    }
  }

  /** A claimed content slot on a paused resource: never written, published or shadowed. */
  private async skipPaused(slot: EditorSlot): Promise<void> {
    try {
      await this.d.plans.updateSlot?.(slot.id, { status: 'skipped', error: PAUSED_ERROR });
    } catch (err: any) {
      this.d.log?.(`skipping paused slot ${slot.id} failed: ${err?.message ?? err}`);
    }
  }

  /** Channels whose effective mode is `approve` (empty without the approval hook). */
  private async approvingCards(cards: EditorCard[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.d.approval) return out;
    for (const c of cards) {
      try {
        if ((await this.d.approval.mode(c)) === 'approve') out.add(c.channelKey);
      } catch (err: any) {
        this.d.log?.(`effective mode of ${c.channelKey} failed: ${err?.message ?? err}`);
      }
    }
    return out;
  }

  /** Approval-mode slots whose write time (approval-timing.writeAt) has come, claimed planned → running. */
  private async claimWriteAhead(approving: Set<string>, byKey: Map<string, EditorCard>, now: Date): Promise<EditorSlot[]> {
    if (!approving.size || !this.d.plans.plannedBefore || !this.d.plans.claimSlot) return [];
    const candidates = await this.d.plans.plannedBefore([...approving], new Date(now.getTime() + WRITE_AHEAD_WINDOW_MS));
    const out: EditorSlot[] = [];
    for (const s of candidates) {
      if (out.length >= CLAIM_BATCH) break;
      const card = byKey.get(s.channelKey);
      if (!card || writeAt(s, card).getTime() > now.getTime()) continue;
      // Spec 040 FR-008: a failed attempt waits for its retry time (scheduledAt keeps the planned one).
      if (s.retryAt && s.retryAt.getTime() > now.getTime()) continue;
      const claimed = await this.d.plans.claimSlot(s.id);
      if (claimed) out.push(claimed);
    }
    return out;
  }

  /** Approval mode: from 20:00 the next day is planned, so its batch can be written and approved this evening. */
  private async maybePlanAhead(card: EditorCard, now: Date): Promise<void> {
    const date = batchDateDue(now, card);
    if (!date) return;
    const active = await this.d.plans.getActivePlan(card.channelKey, date);
    if (active && !isPlaceholderPlan(active.rationale)) return;
    const key = `${card.channelKey}:${date}`;
    // Spec 073 A13: the ahead key's first eligible instant is the batch hour today (`date` is tomorrow's).
    const today = localDate(now, card.timezone);
    await this.seedTries(card, key, today, zonedToUtc(today, `${APPROVAL_BATCH_HOUR}:00`, card.timezone));
    const tries = this.plannerTries.get(key) ?? { n: 0, at: 0 };
    if (tries.n >= PLANNER_MAX_TRIES || now.getTime() - tries.at < PLANNER_RETRY_MS) return;
    this.plannerTries.set(key, { n: tries.n + 1, at: now.getTime() });
    await this.d.runner.runPlanner(card, { planDate: date });
  }

  /**
   * Spec 073 FR-005: when the key is not in `plannerTries` (a fresh process), start it from the planner runs that already
   * failed since the key's first eligible instant (`since`) on the local day `day` — so a restart neither forgets three
   * failed tries nor retries sooner than `PLANNER_RETRY_MS` after the last one. Only an absent key is seeded; a failing
   * read leaves it absent (this tick plans as an empty state would, and the next tick tries the read again).
   */
  private async seedTries(card: EditorCard, key: string, day: string, since: Date): Promise<void> {
    if (this.plannerTries.has(key)) return;
    try {
      // Spec 091: a recovery run cleared the tries up to its start; only the runs after it count.
      let floor = this.triesFloor.get(card.channelKey) ?? null;
      if (this.d.triesFloor) { const f = await this.d.triesFloor(card.channelKey).catch(() => null); if (f && (!floor || f > floor)) floor = f; }
      if (floor && floor > since) since = floor;
      const r = await plannerRunsOn(this.d.pool, card.channelKey, card.timezone, day, { since });
      this.plannerTries.set(key, { n: r.failed, at: r.lastFailedAt?.getTime() ?? 0 });
    } catch (err: any) {
      this.d.log?.(`planner runs of ${card.channelKey} could not be read: ${err?.message ?? err}`);
    }
  }

  private readonly orchestrated = new Set<string>();

  /**
   * The orchestrator's daily run, once per channel-day from the card's plan hour, before planning. Spec 034
   * FR-013: "today" is the card zone's date for both the in-memory key and the editor_runs check (it used to
   * compare with the Kyiv date, so a channel in another zone could run twice or skip a day near midnight).
   */
  private async maybeOrchestrate(card: EditorCard, now: Date): Promise<void> {
    if (!this.d.orchestrate) return;
    if (localHour(now, card.timezone) < card.planHour) return;
    const day = localDate(now, card.timezone);
    const key = `${card.channelKey}:${day}`;
    if (this.orchestrated.has(key)) return;
    this.orchestrated.add(key);
    const { rows } = await this.d.pool.query(
      `SELECT 1 FROM editor_runs WHERE role = 'orchestrator' AND channel_key = $1
          AND (started_at AT TIME ZONE $2)::date = $3::date LIMIT 1`, [card.channelKey, card.timezone, day]);
    if (rows.length) return;
    try { await this.d.orchestrate(card); } catch (err: any) { this.d.log?.(`orchestrator ${card.channelKey} failed: ${err?.message ?? err}`); }
  }

  private async maybePlan(card: EditorCard, now: Date): Promise<void> {
    if (localHour(now, card.timezone) < card.planHour) return;
    const date = localDate(now, card.timezone);
    const active = await this.d.plans.getActivePlan(card.channelKey, date);
    if (active && !isPlaceholderPlan(active.rationale)) return;
    const key = `${card.channelKey}:${date}`;
    // Spec 073 A13: today's key starts at the plan hour on that day in the card's zone.
    await this.seedTries(card, key, date, zonedToUtc(date, `${String(card.planHour).padStart(2, '0')}:00`, card.timezone));
    const tries = this.plannerTries.get(key) ?? { n: 0, at: 0 };
    if (tries.n >= PLANNER_MAX_TRIES || now.getTime() - tries.at < PLANNER_RETRY_MS) return;
    this.plannerTries.set(key, { n: tries.n + 1, at: now.getTime() });
    await this.d.runner.runPlanner(card);
  }

  private async maybeReview(card: EditorCard & { createdAt?: Date }, now: Date): Promise<void> {
    if (localWeekday(now, card.timezone) !== 1) return;                       // Mondays
    if (localHour(now, card.timezone) < Math.max(0, card.planHour - 1)) return;
    if (card.createdAt && now.getTime() - new Date(card.createdAt).getTime() < REVIEW_MIN_CARD_AGE_MS) return;
    const { rows } = await this.d.pool.query(
      `SELECT 1 FROM editor_runs WHERE role = 'reviewer' AND channel_key = $1 AND started_at > now() - interval '6 days' LIMIT 1`,
      [card.channelKey]);
    if (rows.length) return;
    await this.d.runner.runReviewer(card);
  }

  private async checkFailures(channelKey: string, now: Date): Promise<void> {
    const n = await this.d.plans.consecutiveFailures(channelKey);
    const key = `${channelKey}:${now.toISOString().slice(0, 10)}`;
    if (n >= 3 && !this.alerted.has(key)) {
      this.alerted.add(key);
      try { await this.d.notify(`⚠️ Editor: ${channelKey} — ${n} слоти поспіль завершились помилкою. Перевір /app/editor.`); } catch { /* best-effort */ }
    }
  }

  private async runLimited(items: EditorSlot[], limit: number, fn: (s: EditorSlot) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const s = queue.shift()!;
        try { await fn(s); } catch (err: any) { this.d.log?.(`editor executor crashed for slot ${s.id}: ${err?.message ?? err}`); }
      }
    });
    await Promise.all(workers);
  }
}
