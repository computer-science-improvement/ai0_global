import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';

/**
 * Nightly retention for unbounded, append-only tables (AI logs, stats
 * snapshots, follower/metric history, run traces) and for message text kept
 * longer than it is useful (privacy). Without this they grow forever — ai_logs
 * in particular stores the full prompt + output of every AI call.
 *
 * Two kinds of policy:
 *  - RETENTION_POLICIES  — DELETE rows older than the window.
 *  - SCRUB_POLICIES      — keep the row (dedup keys, metrics, status) but blank
 *                          out its text/payload columns older than the window.
 *
 * Gated behind RETENTION_ENABLED=true (`.env.example` ships it on since spec
 * 007). While off it deletes nothing and just logs. Per-table windows are
 * configurable via env; a window of 0 (or less) disables that table.
 *
 * `bot_logs` is deliberately absent: it is the publish dedup ledger until spec
 * 009 retires the legacy strategies.
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

/** A column blanked by a scrub policy, and the value it is reset to. */
interface ScrubColumn {
  name:  string;
  /** SQL literal: NULL for nullable text, `'{}'::jsonb` for NOT NULL jsonb. */
  empty: 'NULL' | "'{}'::jsonb" | "'[]'::jsonb";
}

interface ScrubPolicy {
  table:   string;
  /** Timestamp column the window is measured against. */
  col:     string;
  columns: ScrubColumn[];
  envDays: string;
  defaultDays: number;
  /** Extra row filter (a fixed SQL predicate from this file, never user input). */
  where?: string;
  /** A timestamp column stamped with now() when the row is scrubbed. */
  stamp?: string;
}

export const RETENTION_POLICIES: RetentionPolicy[] = [
  { table: 'ai_logs',                      col: 'created_at',  envDays: 'AI_LOGS_RETENTION_DAYS',              defaultDays: 30  },
  { table: 'post_stats_snapshots',         col: 'captured_at', envDays: 'POST_SNAPSHOTS_RETENTION_DAYS',       defaultDays: 90  },
  { table: 'channel_stats_snapshots',      col: 'captured_at', envDays: 'CHANNEL_SNAPSHOTS_RETENTION_DAYS',    defaultDays: 90  },
  { table: 'meta_follower_history',        col: 'snapshot_at', envDays: 'META_HISTORY_RETENTION_DAYS',         defaultDays: 365 },
  { table: 'tracked_post_metrics_history', col: 'snapshot_at', envDays: 'TRACKED_POST_HISTORY_RETENTION_DAYS', defaultDays: 180 },
  { table: 'tracked_subs_history',         col: 'snapshot_at', envDays: 'TRACKED_SUBS_HISTORY_RETENTION_DAYS',  defaultDays: 365 },
  // Legacy strategy run traces (steps live inline as jsonb).
  { table: 'strategy_runs',                col: 'started_at',  envDays: 'STRATEGY_RUNS_RETENTION_DAYS',        defaultDays: 90  },
  // Editor traces: per-step input/output is the bulky part; the run summary
  // (tokens/cost/status) is kept longer for cost history. Steps go first.
  { table: 'editor_run_steps',             col: 'created_at',  envDays: 'EDITOR_RUN_STEPS_RETENTION_DAYS',     defaultDays: 30  },
  { table: 'editor_runs',                  col: 'started_at',  envDays: 'EDITOR_RUNS_RETENTION_DAYS',          defaultDays: 180 },
];

export const SCRUB_POLICIES: ScrubPolicy[] = [
  // Tracked/competitor post bodies: metrics stay, text goes after 30 d.
  { table: 'tracked_posts',       col: 'posted_at',       envDays: 'TRACKED_POST_TEXT_RETENTION_DAYS',      defaultDays: 30,
    columns: [{ name: 'text', empty: 'NULL' }] },
  // Private DM content (privacy): keep the thread row (peer dedup, category,
  // score, fields) but drop the message bodies and replies.
  { table: 'agent_dm_threads',    col: 'last_message_at', envDays: 'AGENT_DM_TEXT_RETENTION_DAYS',          defaultDays: 90,
    columns: [
      { name: 'last_text',   empty: 'NULL' },
      { name: 'draft_reply', empty: 'NULL' },
      { name: 'sent_reply',  empty: 'NULL' },
    ] },
  { table: 'agent_opportunities', col: 'created_at',      envDays: 'AGENT_OPPORTUNITY_TEXT_RETENTION_DAYS', defaultDays: 90,
    columns: [{ name: 'message_text', empty: 'NULL' }] },
  // Discovery: the full marketplace payload is only needed while the candidate
  // is fresh; every re-discovery rewrites it anyway. NOT NULL → reset to '{}'.
  { table: 'candidate_channels',  col: 'last_seen_at',    envDays: 'CANDIDATE_RAW_PAYLOAD_RETENTION_DAYS',  defaultDays: 30,
    columns: [{ name: 'raw_payload', empty: "'{}'::jsonb" }] },
  // Landing leads (spec 026 FR-011): a lost or spam lead keeps its row (status, contact
  // for dedup history, dates) but loses the message and the resource links after 180 d.
  { table: 'landing_leads',       col: 'updated_at',      envDays: 'LANDING_LEAD_PURGE_DAYS',               defaultDays: 180,
    where: "status IN ('lost','spam')", stamp: 'purged_at',
    columns: [{ name: 'message', empty: 'NULL' }, { name: 'resources', empty: "'[]'::jsonb" }] },
];

/** UPDATE that blanks a scrub policy's columns on rows past the window that still hold data. */
export function scrubSql(p: ScrubPolicy): string {
  const set   = [...p.columns.map(c => `${c.name} = ${c.empty}`), ...(p.stamp ? [`${p.stamp} = now()`] : [])].join(', ');
  const dirty = p.columns.map(c => `${c.name} IS DISTINCT FROM ${c.empty}`).join(' OR ');
  const extra = p.where ? ` AND (${p.where})` : '';
  return `UPDATE ${p.table} SET ${set} WHERE ${p.col} < now() - ($1 * interval '1 day')${extra} AND (${dirty})`;
}

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

  /**
   * Run every delete policy, then every scrub policy, once. Returns per-table
   * affected-row counts (deleted or scrubbed). A failing table (e.g. not
   * migrated yet) is logged and skipped; the rest still run.
   */
  async pruneOnce(): Promise<Array<{ table: string; deleted: number }>> {
    if (!this.enabled()) {
      this.logger.log('Retention disabled (set RETENTION_ENABLED=true to prune) — nothing deleted');
      return [];
    }

    const results: Array<{ table: string; deleted: number }> = [];
    const run = async (table: string, sql: string, days: number, verb: string) => {
      try {
        const { rowCount } = await this.pool.query(sql, [days]);
        const n = rowCount ?? 0;
        if (n > 0) this.logger.log(`${verb} ${n} rows in ${table} (older than ${days}d)`);
        results.push({ table, deleted: n });
      } catch (err: any) {
        this.logger.warn(`Retention on ${table} failed: ${err.message}`);
      }
    };

    for (const p of RETENTION_POLICIES) {
      const days = this.days(p.envDays, p.defaultDays);
      if (days <= 0) continue; // 0/negative disables this table
      await run(p.table, `DELETE FROM ${p.table} WHERE ${p.col} < now() - ($1 * interval '1 day')`, days, 'Pruned');
    }
    for (const p of SCRUB_POLICIES) {
      const days = this.days(p.envDays, p.defaultDays);
      if (days <= 0) continue;
      await run(p.table, scrubSql(p), days, 'Scrubbed text of');
    }
    return results;
  }
}
