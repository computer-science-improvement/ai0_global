import type { Pool } from 'pg';
import type { BoundDataset, SetupSection } from './setup-analysis';
import type { Playbook } from '../network/playbook';

/** Days of the content ledger that count a dataset as the channel's own. */
export const BOUND_DATASET_DAYS = 90;

/**
 * Spec 047 FR-007: the datasets a resource publishes from — library sources of its series in the playbook and datasets
 * with published rows in its content ledger (last BOUND_DATASET_DAYS days), with their entity.
 */
export async function boundDatasets(pool: Pick<Pool, 'query'>, resourceRef: string, playbook: Playbook | null): Promise<BoundDataset[]> {
  const tables = [...new Set((playbook?.series ?? [])
    .filter((s) => s.resource_ref === resourceRef && s.source?.kind === 'library')
    .map((s) => (s.source as { table: string }).table))];
  const { rows } = await pool.query(
    `SELECT s.key, s.entity FROM data_schemas s
      WHERE s.key = ANY($2::text[])
         OR s.key IN (SELECT split_part(substr(l.source_ref, 8), '/', 1) FROM content_ledger l
                       WHERE l.resource_ref = $1 AND l.status = 'published' AND l.source_ref LIKE 'data://%'
                         AND l.used_at > now() - make_interval(days => $3))
      ORDER BY s.key`, [resourceRef, tables, BOUND_DATASET_DAYS]);
  return rows.map((r) => ({ key: String(r.key), entity: String(r.entity ?? 'item') }));
}

/** channel_setup_proposals (080, spec 042 FR-005). */

export const OPEN_STATUSES = ['queued', 'collecting', 'analyzing', 'ready'] as const;
export type ProposalStatus =
  | typeof OPEN_STATUSES[number]
  | 'applied' | 'partially_applied' | 'discarded' | 'superseded' | 'failed' | 'no_access' | 'too_few_posts' | 'expired';
export type SectionState = 'pending' | 'applied' | 'skipped';

export interface SetupProposal {
  id:            string;
  channelKey:    string;
  resourceRef:   string;
  agentId:       string | null;
  status:        ProposalStatus;
  reason:        string | null;
  retryAt:       Date | null;
  postIds:       string[];
  metrics:       unknown;
  sections:      Record<string, unknown> | null;
  sectionStatus: Partial<Record<SetupSection, SectionState>>;
  baseline:      Record<string, unknown> | null;
  runId:         string | null;
  costUsd:       number;
  createdBy:     string;
  createdAt:     Date;
  updatedAt:     Date;
  appliedAt:     Date | null;
}

const toProposal = (r: any): SetupProposal => ({
  id: r.id, channelKey: r.channel_key, resourceRef: r.resource_ref, agentId: r.agent_id ?? null, status: r.status,
  reason: r.reason ?? null, retryAt: r.retry_at ?? null, postIds: r.post_ids ?? [], metrics: r.metrics ?? null,
  sections: r.sections ?? null, sectionStatus: r.section_status ?? {}, baseline: r.baseline ?? null, runId: r.run_id ?? null,
  costUsd: Number(r.cost_usd ?? 0), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  appliedAt: r.applied_at ?? null,
});

export class ChannelSetupRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Queue a run for a channel: its open proposal (queued … ready) becomes `superseded` first, in one transaction —
   * the partial unique index allows one open proposal per channel.
   */
  async enqueue(channelKey: string, createdBy = 'owner'): Promise<SetupProposal> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`channel-setup:${channelKey}`]);
      await c.query(
        `UPDATE channel_setup_proposals SET status = 'superseded', updated_at = now()
          WHERE channel_key = $1 AND status = ANY($2)`, [channelKey, OPEN_STATUSES]);
      const { rows } = await c.query(
        `INSERT INTO channel_setup_proposals (channel_key, resource_ref, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [channelKey, `telegram:${channelKey}`, createdBy]);
      await c.query('COMMIT');
      return toProposal(rows[0]);
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async get(id: string): Promise<SetupProposal | null> {
    const { rows } = await this.pool.query(`SELECT * FROM channel_setup_proposals WHERE id = $1`, [id]);
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async list(channelKey?: string | null, limit = 50): Promise<SetupProposal[]> {
    const { rows } = channelKey
      ? await this.pool.query(`SELECT * FROM channel_setup_proposals WHERE channel_key = $1 ORDER BY created_at DESC LIMIT $2`, [channelKey, limit])
      : await this.pool.query(`SELECT * FROM channel_setup_proposals ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows.map(toProposal);
  }

  /** The newest proposal per channel. */
  async latestByChannel(): Promise<Map<string, SetupProposal>> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (channel_key) * FROM channel_setup_proposals ORDER BY channel_key, created_at DESC`);
    return new Map(rows.map((r: any) => [r.channel_key, toProposal(r)]));
  }

  /**
   * Claim the oldest queued proposal whose retry time has passed (`collecting`); null when none. SKIP LOCKED keeps two
   * workers (two app instances) from taking the same one.
   */
  async claimNext(now: Date): Promise<SetupProposal | null> {
    const { rows } = await this.pool.query(
      `UPDATE channel_setup_proposals SET status = 'collecting', updated_at = now()
        WHERE id = (
          SELECT id FROM channel_setup_proposals
           WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= $1)
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [now]);
    return rows[0] ? toProposal(rows[0]) : null;
  }

  /** Proposals left `collecting` / `analyzing` by a restart go back to the queue. */
  async requeueStuck(olderThan: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE channel_setup_proposals SET status = 'queued', updated_at = now()
        WHERE status IN ('collecting','analyzing') AND updated_at < $1`, [olderThan]);
    return rowCount ?? 0;
  }

  /**
   * Spec 057: `ready` / `partially_applied` proposals untouched for `ttlDays` become `expired`; their pending sections
   * are skipped (as `discard` does), the applied ones stay. 0 days (or less) = never. One statement, idempotent.
   */
  async expireStale(now: Date, ttlDays: number, sections: readonly string[]): Promise<SetupProposal[]> {
    if (!(ttlDays > 0)) return [];
    const { rows } = await this.pool.query(
      `UPDATE channel_setup_proposals SET status = 'expired', updated_at = $1,
              section_status = section_status || COALESCE((
                SELECT jsonb_object_agg(s, 'skipped'::text) FROM unnest($3::text[]) AS s
                 WHERE sections IS NOT NULL AND COALESCE(section_status->>s, 'pending') = 'pending'), '{}'::jsonb)
        WHERE status IN ('ready','partially_applied') AND updated_at < $1::timestamptz - make_interval(days => $2::int)
        RETURNING *`, [now, Math.floor(ttlDays), [...sections]]);
    return rows.map(toProposal).sort((a, b) => a.channelKey.localeCompare(b.channelKey));
  }

  async update(id: string, p: Partial<{
    status: ProposalStatus; reason: string | null; retryAt: Date | null; agentId: string | null; postIds: string[];
    metrics: unknown; sections: unknown; sectionStatus: Partial<Record<SetupSection, SectionState>>; baseline: unknown;
    runId: string | null; costUsd: number; appliedAt: Date | null;
  }>): Promise<SetupProposal | null> {
    const cols: Record<string, unknown> = {
      status: p.status, reason: p.reason, retry_at: p.retryAt, agent_id: p.agentId, post_ids: p.postIds,
      metrics: p.metrics === undefined ? undefined : JSON.stringify(p.metrics),
      sections: p.sections === undefined ? undefined : JSON.stringify(p.sections),
      section_status: p.sectionStatus === undefined ? undefined : JSON.stringify(p.sectionStatus),
      baseline: p.baseline === undefined ? undefined : JSON.stringify(p.baseline),
      run_id: p.runId, cost_usd: p.costUsd, applied_at: p.appliedAt,
    };
    const set: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      vals.push(v);
      set.push(`${k} = $${vals.length}`);
    }
    const { rows } = await this.pool.query(
      `UPDATE channel_setup_proposals SET ${[...set, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`, vals);
    return rows[0] ? toProposal(rows[0]) : null;
  }
}
