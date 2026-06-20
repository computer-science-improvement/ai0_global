import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { StrategyRunsRepository } from '../../config/strategy-runs.repository';
import { TelegramNotifier } from '../../publishers/telegram-notifier.service';

/**
 * Proactive failure alerting. The platform runs unattended; before this, a
 * strategy erroring every tick or a run stuck 'running' was only visible as a
 * red chip on a dashboard nobody watches. This watcher polls the run log and
 * pings the owner via TelegramNotifier (which itself no-ops when no owner id is
 * configured, so this is safe to leave on).
 *
 * De-duped in memory: each condition alerts ONCE; an error streak that clears
 * (an ok/skipped run lands) is forgotten so the next failure re-alerts.
 */
@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly alerted = new Set<string>();

  constructor(
    private readonly runsRepo: StrategyRunsRepository,
    private readonly notifier: TelegramNotifier,
    private readonly config:   ConfigService,
  ) {}

  private num(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    const n = raw == null || raw === '' ? fallback : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  @Cron('*/15 * * * *') // every 15 minutes
  async tick(): Promise<void> {
    try { await this.checkOnce(); }
    catch (err: any) { this.logger.warn(`alerting check failed: ${err.message}`); }
  }

  /** Run the failure checks once. Returns counts of NEW alerts fired. */
  async checkOnce(): Promise<{ errorsAlerted: number; stuckAlerted: number }> {
    if (this.config.get<string>('ALERT_ENABLED') === 'false') return { errorsAlerted: 0, stuckAlerted: 0 };

    const errThreshold = this.num('ALERT_CONSECUTIVE_ERRORS', 3);
    const stuckMinutes = this.num('ALERT_STUCK_RUNNING_MINUTES', 20);

    let errorsAlerted = 0;
    let stuckAlerted = 0;

    // ── Consecutive-error strategies ──
    const errs = await this.runsRepo.consecutiveErrorStrategies(errThreshold);
    const activeErrKeys = new Set(errs.map(e => `err:${e.ext_id}`));
    for (const e of errs) {
      const key = `err:${e.ext_id}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      errorsAlerted++;
      const last = (e.last_error ?? '').slice(0, 300);
      await this.notifier.notifyAlert(
        `🔴 Strategy "${e.ext_id}" failed ${e.consecutive_errors}× in a row.\nLast error: ${last || '(none)'}`,
      );
    }
    // Forget streaks that have since cleared, so a future failure re-alerts.
    for (const key of [...this.alerted]) {
      if (key.startsWith('err:') && !activeErrKeys.has(key)) this.alerted.delete(key);
    }

    // ── Stuck 'running' runs ──
    const stuck = await this.runsRepo.stuckRunning(stuckMinutes);
    for (const s of stuck) {
      const key = `stuck:${s.ext_id}:${new Date(s.started_at).getTime()}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      stuckAlerted++;
      await this.notifier.notifyAlert(
        `⏳ Strategy "${s.ext_id}" has been stuck 'running' since ${new Date(s.started_at).toISOString()} (> ${stuckMinutes}m).`,
      );
    }

    return { errorsAlerted, stuckAlerted };
  }
}
