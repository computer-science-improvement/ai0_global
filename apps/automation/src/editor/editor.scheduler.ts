import type { Pool } from 'pg';
import type { EditorCard } from './card';
import type { EditorChannelsRepository } from './repo/editor-channels.repository';
import { RESERVED_ONLY_RATIONALE } from './repo/editor-plans.repository';
import type { EditorPlansRepository, EditorSlot } from './repo/editor-plans.repository';
import type { EditorRunnerService } from './roles/editor-runner.service';
import { localDate, localHour, localWeekday } from './roles/time';

export interface EditorSchedulerDeps {
  pool:     Pick<Pool, 'query'>;
  channels: Pick<EditorChannelsRepository, 'listActive'>;
  plans:    Pick<EditorPlansRepository, 'getActivePlan' | 'claimDue' | 'skipStale' | 'sweepStuck' | 'consecutiveFailures'>;
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
}

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

  async cronTick(): Promise<void> {
    if (this.busy) return;
    if (!this.d.enabled() && !this.d.reserved) return;
    this.busy = true;
    const now = new Date();
    try {
      if (this.d.reserved) {
        try { await this.d.reserved.publishDue(now); } catch (err: any) { this.d.log?.(`reserved slots failed: ${err?.message ?? err}`); }
      }
      if (this.d.enabled()) await this.tick(now);
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

    for (const card of cards) {
      await this.maybePlan(card, now);
      await this.maybeReview(card as EditorCard & { createdAt?: Date }, now);
    }

    const due = (await this.d.plans.claimDue(now, CLAIM_BATCH)).filter((s) => byKey.has(s.channelKey));
    await this.runLimited(due, EXECUTOR_PARALLEL, async (slot) => {
      await this.d.runner.runExecutor(slot, byKey.get(slot.channelKey)!);
      await this.checkFailures(slot.channelKey, now);
    });
  }

  private async maybePlan(card: EditorCard, now: Date): Promise<void> {
    if (localHour(now, card.timezone) < card.planHour) return;
    const date = localDate(now, card.timezone);
    const active = await this.d.plans.getActivePlan(card.channelKey, date);
    if (active && active.rationale !== RESERVED_ONLY_RATIONALE) return;
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
