/**
 * Spec 090 FR-010: the log of decisions the system made because the owner stayed silent, and their undo.
 *
 * Writers call `record` and never fail their own path on a log error (the table may be missing before migration 103):
 * `record` logs and returns null. Undo is dispatched by `undo.kind` to a handler registered by the module that owns the
 * change (pauses, playbooks, sources, fixes, directives), so this file knows no domain.
 */
import type { Pool } from 'pg';

export type DecisionAction = 'applied' | 'dropped' | 'resumed' | 'failed' | 'undone';

/** How to reverse a decision. `kind` picks the handler; the rest is the handler's own payload. */
export interface UndoRecord { kind: string; [k: string]: unknown }

export interface AutonomyDecision {
  id:         number;
  gate:       string;
  refType:    string;
  refId:      string;
  channelKey: string | null;
  action:     DecisionAction;
  summary:    string;
  undo:       UndoRecord | null;
  decidedAt:  Date;
  undoneAt:   Date | null;
  undoneBy:   string | null;
}

export interface NewDecision {
  gate:        string;
  refType:     string;
  refId:       string;
  channelKey?: string | null;
  action:      DecisionAction;
  /** One English line (dashboard, report). */
  summary:     string;
  undo?:       UndoRecord | null;
  at?:         Date;
}

const toDecision = (r: any): AutonomyDecision => ({
  id: Number(r.id), gate: r.gate, refType: r.ref_type, refId: r.ref_id, channelKey: r.channel_key ?? null, action: r.action,
  summary: r.summary, undo: r.undo ?? null, decidedAt: new Date(r.decided_at), undoneAt: r.undone_at ? new Date(r.undone_at) : null,
  undoneBy: r.undone_by ?? null,
});

/** The gate family: `directive:frequency` → `directive`. */
export const gateFamily = (gate: string): string => (gate.includes(':') ? gate.slice(0, gate.indexOf(':')) : gate);

export class AutonomyDecisionsRepository {
  constructor(private readonly pool: Pool, private readonly log: (m: string) => void = () => {}) {}

  /** Log one decision. Never throws: returns the id, or null when the write failed (logged). */
  async record(d: NewDecision): Promise<number | null> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO autonomy_decisions (gate, ref_type, ref_id, channel_key, action, summary, undo, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now())) RETURNING id`,
        [d.gate, d.refType, d.refId, d.channelKey ?? null, d.action, d.summary.slice(0, 500),
          d.undo ? JSON.stringify(d.undo) : null, d.at ?? null]);
      return Number(rows[0].id);
    } catch (err: any) {
      this.log(`autonomy decision not logged (${d.gate} ${d.refType}:${d.refId}): ${err?.message ?? err}`);
      return null;
    }
  }

  async get(id: number): Promise<AutonomyDecision | null> {
    const { rows } = await this.pool.query(`SELECT * FROM autonomy_decisions WHERE id = $1`, [id]);
    return rows[0] ? toDecision(rows[0]) : null;
  }

  /** Newest first. */
  async list(o: { channelKey?: string | null; since?: Date; limit?: number } = {}): Promise<AutonomyDecision[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM autonomy_decisions
        WHERE ($1::text IS NULL OR channel_key = $1) AND ($2::timestamptz IS NULL OR decided_at >= $2)
        ORDER BY decided_at DESC, id DESC LIMIT $3`,
      [o.channelKey ?? null, o.since ?? null, Math.min(Math.max(o.limit ?? 100, 1), 500)]);
    return rows.map(toDecision);
  }

  /** The newest decision about one object (the owner-bot sweep reads it to word a closed card). */
  async latestFor(refType: string, refId: string): Promise<AutonomyDecision | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM autonomy_decisions WHERE ref_type = $1 AND ref_id = $2 ORDER BY decided_at DESC, id DESC LIMIT 1`, [refType, refId]);
    return rows[0] ? toDecision(rows[0]) : null;
  }

  /** Counts per gate family and action in [since, until) (the daily and weekly reports). */
  async counts(since: Date, until: Date): Promise<Array<{ family: string; action: DecisionAction; n: number }>> {
    const { rows } = await this.pool.query(
      `SELECT split_part(gate, ':', 1) AS family, action, count(*)::int AS n FROM autonomy_decisions
        WHERE decided_at >= $1 AND decided_at < $2 GROUP BY 1, 2 ORDER BY 1, 2`, [since, until]);
    return rows.map((r: any) => ({ family: r.family, action: r.action, n: Number(r.n) }));
  }

  /** Mark a decision undone (only once). Returns false when it was already undone or does not exist. */
  async markUndone(id: number, by: string, at: Date = new Date()): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE autonomy_decisions SET undone_at = $3, undone_by = $2 WHERE id = $1 AND undone_at IS NULL`, [id, by, at]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Release a claim made by `markUndone` when the undo itself failed. */
  async releaseUndone(id: number): Promise<void> {
    await this.pool.query(`UPDATE autonomy_decisions SET undone_at = NULL, undone_by = NULL WHERE id = $1`, [id]);
  }
}

export type UndoHandler = (undo: UndoRecord, ctx: { decision: AutonomyDecision; by: string }) => Promise<void>;

export type UndoResult =
  | { ok: true; decision: AutonomyDecision }
  | { ok: false; error: 'not_found' | 'no_undo' | 'already_undone' | 'no_handler' | 'failed'; message?: string };

/** Spec 090 FR-010: undo by `undo.kind`. Modules register their handler at wiring time. */
export class AutonomyUndo {
  private readonly handlers = new Map<string, UndoHandler>();

  constructor(private readonly repo: AutonomyDecisionsRepository) {}

  register(kind: string, handler: UndoHandler): void {
    if (this.handlers.has(kind)) throw new Error(`duplicate undo handler ${kind}`);
    this.handlers.set(kind, handler);
  }

  has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  /** Whether the dashboard should offer Undo for this decision. */
  canUndo(d: AutonomyDecision): boolean {
    return !!d.undo && !d.undoneAt && d.action !== 'undone' && this.handlers.has(d.undo.kind);
  }

  async undo(id: number, by: string): Promise<UndoResult> {
    const d = await this.repo.get(id);
    if (!d) return { ok: false, error: 'not_found' };
    if (d.undoneAt) return { ok: false, error: 'already_undone' };
    if (!d.undo) return { ok: false, error: 'no_undo' };
    const h = this.handlers.get(d.undo.kind);
    if (!h) return { ok: false, error: 'no_handler' };
    // Claim first, so two clicks never run the handler twice; a failed handler releases the claim.
    if (!(await this.repo.markUndone(id, by))) return { ok: false, error: 'already_undone' };
    try {
      await h(d.undo, { decision: d, by });
    } catch (err: any) {
      await this.repo.releaseUndone(id);
      return { ok: false, error: 'failed', message: String(err?.message ?? err).slice(0, 300) };
    }
    await this.repo.record({ gate: d.gate, refType: d.refType, refId: d.refId, channelKey: d.channelKey, action: 'undone',
      summary: `Undone by ${by}: ${d.summary}`.slice(0, 500) });
    return { ok: true, decision: (await this.repo.get(id)) ?? d };
  }
}
