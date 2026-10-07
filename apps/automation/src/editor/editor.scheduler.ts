import type { Pool } from 'pg';
import type { ChannelMode, EditorCard } from './card';
import { batchDateDue, writeAt } from './approval/approval-timing';
import type { EditorChannelsRepository } from './repo/editor-channels.repository';
import { isPlaceholderPlan } from './repo/editor-plans.repository';
import type { EditorPlansRepository, EditorSlot } from './repo/editor-plans.repository';
import type { EditorRunnerService } from './roles/editor-runner.service';
import { localDate, localHour, localWeekday } from './roles/time';

export interface EditorSchedulerDeps {
  pool:     Pick<Pool, 'query'>;
  channels: Pick<EditorChannelsRepository, 'listActive'>;
  plans:    Pick<EditorPlansRepository, 'getActivePlan' | 'claimDue' | 'skipStale' | 'sweepStuck' | 'consecutiveFailures'>
    & Partial<Pick<EditorPlansRepository, 'plannedBefore' | 'claimSlot'>>;
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
    await this.d.plans.skipStale(now, STALE_MS);
    await this.d.plans.sweepStuck(now, STUCK_MS);

    const cards = await this.d.channels.listActive();
    const byKey = new Map(cards.map((c) => [c.channelKey, c]));
    const approving = await this.approvingCards(cards);

    for (const card of cards) {
      if (this.d.pinGate) {
        try { await this.d.pinGate(card, now); } catch (err: any) { this.d.log?.(`auto-duplicate gate of ${card.channelKey} failed: ${err?.message ?? err}`); }
      }
      await this.maybeOrchestrate(card, now);
      await this.maybePlan(card, now);
      if (approving.has(card.channelKey)) await this.maybePlanAhead(card, now);
      await this.maybeReview(card as EditorCard & { createdAt?: Date }, now);
    }

    if (this.d.afterTick) {
      try { await this.d.afterTick(now); } catch (err: any) { this.d.log?.(`after-tick hook failed: ${err?.message ?? err}`); }
    }

    // Approval mode writes ahead of time; everything else (and late approval slots) at the slot time.
    const early = await this.claimWriteAhead(approving, byKey, now);
    const rest = early.length < CLAIM_BATCH ? await this.d.plans.claimDue(now, CLAIM_BATCH - early.length) : [];
    const due = [...early, ...rest].filter((s) => byKey.has(s.channelKey));
    await this.runLimited(due, EXECUTOR_PARALLEL, async (slot) => {
      await this.d.runner.runExecutor(slot, byKey.get(slot.channelKey)!);
      await this.checkFailures(slot.channelKey, now);
    });
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
    const tries = this.plannerTries.get(key) ?? { n: 0, at: 0 };
    if (tries.n >= PLANNER_MAX_TRIES || now.getTime() - tries.at < PLANNER_RETRY_MS) return;
    this.plannerTries.set(key, { n: tries.n + 1, at: now.getTime() });
    await this.d.runner.runPlanner(card, { planDate: date });
  }

  private readonly orchestrated = new Set<string>();

  private async maybeOrchestrate(card: EditorCard, now: Date): Promise<void> {
    if (!this.d.orchestrate) return;
    if (localHour(now, card.timezone) < card.planHour) return;
    const key = `${card.channelKey}:${localDate(now, card.timezone)}`;
    if (this.orchestrated.has(key)) return;
    this.orchestrated.add(key);
    const { rows } = await this.d.pool.query(
      `SELECT 1 FROM editor_runs WHERE role = 'orchestrator' AND channel_key = $1
          AND (started_at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date LIMIT 1`, [card.channelKey]);
    if (rows.length) return;
    try { await this.d.orchestrate(card); } catch (err: any) { this.d.log?.(`orchestrator ${card.channelKey} failed: ${err?.message ?? err}`); }
  }

  private async maybePlan(card: EditorCard, now: Date): Promise<void> {
    if (localHour(now, card.timezone) < card.planHour) return;
    const date = localDate(now, card.timezone);
    const active = await this.d.plans.getActivePlan(card.channelKey, date);
    if (active && !isPlaceholderPlan(active.rationale)) return;
    const key = `${card.channelKey}:${date}`;
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
