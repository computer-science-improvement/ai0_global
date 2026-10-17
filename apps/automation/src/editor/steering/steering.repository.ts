import type { Pool } from 'pg';
import { PENDING_STATUSES, type SourcePost, type SteeringPromptRule, type SteeringRule, type SteeringSet, type SteeringStatus } from './steering.types';

/** steering_sets (081, spec 045). */

const toSet = (r: any): SteeringSet => ({
  id: r.id, targetRef: r.target_ref, channelKey: r.channel_key ?? null, sourceRef: r.source_ref, sourceTitle: r.source_title ?? null,
  status: r.status, reason: r.reason ?? null, retryAt: r.retry_at ?? null, posts: r.posts ?? [], metrics: r.metrics ?? null,
  summary: r.summary ?? null, rules: r.rules ?? [], runId: r.run_id ?? null, costUsd: Number(r.cost_usd ?? 0),
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, activatedAt: r.activated_at ?? null,
});

/** Closed sets keep ids, dates and numbers of the reference posts, not their text (third-party content). */
export function withoutTexts(posts: readonly SourcePost[]): SourcePost[] {
  return posts.map((p) => ({ ...p, text: '' }));
}

export class SteeringRepository {
  constructor(private readonly pool: Pool) {}

  /** The set being made for (target, source), if any (queued … ready). */
  async pending(targetRef: string, sourceRef: string): Promise<SteeringSet | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM steering_sets WHERE target_ref = $1 AND source_ref = $2 AND status = ANY($3) LIMIT 1`,
      [targetRef, sourceRef, PENDING_STATUSES]);
    return rows[0] ? toSet(rows[0]) : null;
  }

  /** Queue an analysis; a concurrent twin hits the partial unique index and gets the existing set back. */
  async enqueue(i: { targetRef: string; channelKey: string | null; sourceRef: string; createdBy: string }): Promise<{ set: SteeringSet; created: boolean }> {
    const { rows } = await this.pool.query(
      `INSERT INTO steering_sets (target_ref, channel_key, source_ref, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING *`, [i.targetRef, i.channelKey, i.sourceRef, i.createdBy]);
    if (rows[0]) return { set: toSet(rows[0]), created: true };
    const existing = await this.pending(i.targetRef, i.sourceRef);
    if (!existing) throw new Error('steering set conflict without a pending set');
    return { set: existing, created: false };
  }

  async get(id: string): Promise<SteeringSet | null> {
    const { rows } = await this.pool.query(`SELECT * FROM steering_sets WHERE id = $1`, [id]);
    return rows[0] ? toSet(rows[0]) : null;
  }

  /** Newest first; closed analyses older than the newest per (target, source) are left out unless `all`. */
  async list(o: { targetRef?: string | null; limit?: number } = {}): Promise<SteeringSet[]> {
    const { rows } = o.targetRef
      ? await this.pool.query(`SELECT * FROM steering_sets WHERE target_ref = $1 ORDER BY created_at DESC LIMIT $2`, [o.targetRef, o.limit ?? 100])
      : await this.pool.query(`SELECT * FROM steering_sets ORDER BY created_at DESC LIMIT $1`, [o.limit ?? 100]);
    return rows.map(toSet);
  }

  async activeFor(targetRef: string): Promise<SteeringSet[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM steering_sets WHERE target_ref = $1 AND status = 'active' ORDER BY activated_at, created_at`, [targetRef]);
    return rows.map(toSet);
  }

  /** The rules the target's agent follows: enabled, without a conflict, of active sets. */
  async promptRules(targetRef: string): Promise<SteeringPromptRule[]> {
    return (await this.activeFor(targetRef)).flatMap((s) => s.rules
      .filter((r) => r.enabled && !r.conflict)
      .map((r) => ({ source: s.sourceTitle ? `${refName(s.sourceRef)} «${s.sourceTitle}»` : refName(s.sourceRef), kind: r.kind, text: r.text })));
  }

  /** Reference texts of the target's active sets (the copy guard). */
  async activeTexts(targetRef: string): Promise<Array<{ source: string; key: string; text: string }>> {
    return (await this.activeFor(targetRef)).flatMap((s) => s.posts.filter((p) => p.text).map((p) => ({ source: refName(s.sourceRef), key: p.key, text: p.text })));
  }

  /** Claim the oldest queued set whose retry time has passed (`collecting`). */
  async claimNext(now: Date): Promise<SteeringSet | null> {
    const { rows } = await this.pool.query(
      `UPDATE steering_sets SET status = 'collecting', updated_at = now()
        WHERE id = (
          SELECT id FROM steering_sets
           WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= $1)
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [now]);
    return rows[0] ? toSet(rows[0]) : null;
  }

  /** Sets left `collecting` / `analyzing` by a restart go back to the queue. */
  async requeueStuck(olderThan: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE steering_sets SET status = 'queued', updated_at = now()
        WHERE status IN ('collecting','analyzing') AND updated_at < $1`, [olderThan]);
    return rowCount ?? 0;
  }

  async update(id: string, p: Partial<{
    status: SteeringStatus; reason: string | null; retryAt: Date | null; sourceTitle: string | null; posts: SourcePost[];
    metrics: unknown; summary: string | null; rules: SteeringRule[]; runId: string | null; costUsd: number; activatedAt: Date | null;
  }>, o: { from?: readonly SteeringStatus[] } = {}): Promise<SteeringSet | null> {
    const cols: Record<string, unknown> = {
      status: p.status, reason: p.reason, retry_at: p.retryAt, source_title: p.sourceTitle,
      posts: p.posts === undefined ? undefined : JSON.stringify(p.posts),
      metrics: p.metrics === undefined ? undefined : JSON.stringify(p.metrics),
      summary: p.summary, rules: p.rules === undefined ? undefined : JSON.stringify(p.rules),
      run_id: p.runId, cost_usd: p.costUsd, activated_at: p.activatedAt,
    };
    const set: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(cols)) {
      if (v === undefined) continue;
      vals.push(v);
      set.push(`${k} = $${vals.length}`);
    }
    // `from`: only while the set is still in one of these statuses (the worker never overwrites an owner's Discard).
    let where = 'id = $1';
    if (o.from) { vals.push([...o.from]); where += ` AND status = ANY($${vals.length})`; }
    const { rows } = await this.pool.query(
      `UPDATE steering_sets SET ${[...set, 'updated_at = now()'].join(', ')} WHERE ${where} RETURNING *`, vals);
    return rows[0] ? toSet(rows[0]) : null;
  }

  /**
   * Activate a ready set (or resume a paused one): the target's other active / paused sets of the same source become `superseded` (their texts
   * dropped), in one transaction under a per-target lock; refused when the target already has `max` active sets of other
   * sources.
   */
  async activate(id: string, max: number): Promise<{ set: SteeringSet } | { error: 'not_found' | 'not_ready' | 'too_many_active' }> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [row] } = await c.query(`SELECT * FROM steering_sets WHERE id = $1`, [id]);
      if (!row) { await c.query('ROLLBACK'); return { error: 'not_found' }; }
      if (row.status !== 'ready' && row.status !== 'paused') { await c.query('ROLLBACK'); return { error: 'not_ready' }; }
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`steering:${row.target_ref}`]);
      const { rows: [{ n }] } = await c.query(
        `SELECT count(*)::int AS n FROM steering_sets WHERE target_ref = $1 AND status = 'active' AND source_ref <> $2`,
        [row.target_ref, row.source_ref]);
      if (n >= max) { await c.query('ROLLBACK'); return { error: 'too_many_active' }; }
      const { rows: old } = await c.query(
        `SELECT id, posts FROM steering_sets WHERE target_ref = $1 AND source_ref = $2 AND status IN ('active','paused') AND id <> $3`,
        [row.target_ref, row.source_ref, id]);
      for (const o of old) {
        await c.query(`UPDATE steering_sets SET status = 'superseded', posts = $2, updated_at = now() WHERE id = $1`,
          [o.id, JSON.stringify(withoutTexts(o.posts ?? []))]);
      }
      const { rows: [done] } = await c.query(
        `UPDATE steering_sets SET status = 'active', activated_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [id]);
      await c.query('COMMIT');
      return { set: toSet(done) };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** The cost of one analysis: the average of the last 20 analysed sets, else of the last 20 ok onboarder runs; null before any. */
  async estimateUsd(): Promise<number | null> {
    const own = await this.pool.query(
      `SELECT avg(cost_usd)::float AS avg FROM (
         SELECT cost_usd FROM steering_sets WHERE run_id IS NOT NULL AND cost_usd > 0 ORDER BY created_at DESC LIMIT 20) t`);
    const runs = own.rows[0]?.avg != null ? own : await this.pool.query(
      `SELECT avg(cost_usd)::float AS avg FROM (
         SELECT cost_usd FROM editor_runs WHERE role = 'onboarder' AND status = 'ok' ORDER BY started_at DESC LIMIT 20) r`);
    const avg = runs.rows[0]?.avg;
    return avg == null ? null : Math.round(Number(avg) * 10_000) / 10_000;
  }
}

/** `telegram:@ref` → `@ref`; other refs as they are. */
export function refName(ref: string): string {
  return ref.startsWith('telegram:') ? ref.slice('telegram:'.length) : ref;
}
