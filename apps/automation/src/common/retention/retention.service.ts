import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';

/**
 * Nightly retention prune for unbounded, append-only tables (AI logs, stats
 * snapshots, follower/metric history). Without this they grow forever — ai_logs
 * in particular stores the full prompt + output of every AI call.
 *
 * SAFE BY DEFAULT: the whole job is gated behind RETENTION_ENABLED=true. While
 * off it deletes nothing and just logs what it would do, so enabling retention
 * is a deliberate, reviewable step. Per-table windows are configurable; a window
 * of 0 (or less) disables pruning for that table.
 *
 * Table/column names come from a hard-coded allowlist (never user input), so the
 * interpolated identifiers are injection-safe; the day window is parameterized.
 */
interface RetentionPolicy {
  table: string;
  col:   string;
  envDays: string;
  defaultDays: number;
}

export const RETENTION_POLICIES: RetentionPolicy[] = [
  { table: 'ai_logs',                      col: 'created_at',  envDays: 'AI_LOGS_RETENTION_DAYS',              defaultDays: 30  },
  { table: 'post_stats_snapshots',         col: 'captured_at', envDays: 'POST_SNAPSHOTS_RETENTION_DAYS',       defaultDays: 90  },
  { table: 'channel_stats_snapshots',      col: 'captured_at', envDays: 'CHANNEL_SNAPSHOTS_RETENTION_DAYS',    defaultDays: 90  },
  { table: 'meta_follower_history',        col: 'snapshot_at', envDays: 'META_HISTORY_RETENTION_DAYS',         defaultDays: 365 },
  { table: 'tracked_post_metrics_history', col: 'snapshot_at', envDays: 'TRACKED_POST_HISTORY_RETENTION_DAYS', defaultDays: 180 },
  { table: 'tracked_subs_history',         col: 'snapshot_at', envDays: 'TRACKED_SUBS_HISTORY_RETENTION_DAYS',  defaultDays: 365 },
];

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  private enabled(): boolean {
    return this.config.get<string>('RETENTION_ENABLED') === 'true';
  }

  private days(envKey: string, fallback: number): number {
    const raw = this.config.get<string>(envKey);
    const n = raw == null || raw === '' ? fallback : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightly(): Promise<void> {
    await this.pruneOnce();
  }

  /** Prune every policy table once. Returns per-table deleted counts. */
  async pruneOnce(): Promise<Array<{ table: string; deleted: number }>> {
    if (!this.enabled()) {
      this.logger.log('Retention disabled (set RETENTION_ENABLED=true to prune) — nothing deleted');
      return [];
    }

    const results: Array<{ table: string; deleted: number }> = [];
    for (const p of RETENTION_POLICIES) {
      const days = this.days(p.envDays, p.defaultDays);
      if (days <= 0) continue; // 0/negative disables this table
      try {
        const { rowCount } = await this.pool.query(
          `DELETE FROM ${p.table} WHERE ${p.col} < now() - ($1 * interval '1 day')`,
          [days],
        );
        const deleted = rowCount ?? 0;
        if (deleted > 0) this.logger.log(`Pruned ${deleted} rows from ${p.table} (older than ${days}d)`);
        results.push({ table: p.table, deleted });
      } catch (err: any) {
        this.logger.warn(`Prune ${p.table} failed: ${err.message}`);
      }
    }
    return results;
  }
}
