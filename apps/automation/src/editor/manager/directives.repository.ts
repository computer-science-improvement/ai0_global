import type { Pool } from 'pg';

export const DIRECTIVE_KINDS = ['advice', 'task', 'format_shift', 'frequency', 'repost', 'cross_promo', 'pause_series', 'experiment', 'pause_resource', 'strategy'] as const;
export type DirectiveKind = typeof DIRECTIVE_KINDS[number];
export const DIRECTIVE_STATUSES = ['new', 'awaiting_owner', 'accepted', 'rejected', 'applied', 'evaluated', 'expired', 'canceled', 'contested', 'declined', 'failed'] as const;
export type DirectiveStatus = typeof DIRECTIVE_STATUSES[number];
export type DirectiveBinding = 'directive' | 'advice';
export type DirectiveOutcome = 'worked' | 'no_effect' | 'hurt' | 'inconclusive';
export const KPI_METRICS = ['views_per_post', 'engagement_rate', 'posts', 'followers_growth', 'transitions', 'revenue'] as const;
export type KpiMetric = typeof KPI_METRICS[number];

export interface Expected { metric: KpiMetric; direction: 'up' | 'down'; min_change_pct: number; resource_ref?: string }

export interface Directive {
  id:            string;
  fromAgentId:   string | null;
  toAgentId:     string;
  kind:          DirectiveKind;
  /** Spec 025: 'directive' must be carried out (or contested); 'advice' may be declined. */
  binding:       DirectiveBinding;
  structural:    boolean;
  body:          string;
  params:        Record<string, unknown>;
  rationale:     string;
  evidence:      unknown;
  expected:      Expected | null;
  reviewAt:      Date | null;
  status:        DirectiveStatus;
  resolution:    string | null;
  reasonKind:    string | null;
  ownerDecision: string | null;
  outcome:       DirectiveOutcome | null;
  outcomeDetail: any;
  deliveredAt:   Date | null;
  appliedAt:     Date | null;
  runId:         string | null;
  shadow:        boolean;
  /** Spec 025 FR-009: the executor's diff (before/after), stored before it is applied. */
  change:        any;
  execAttempts:  number;
  execError:     string | null;
  /** Spec 025: how the change was observed in plans and publishing (adherence, contest check, self-report). */
  verification:  any;
  verifiedAt:    Date | null;
  contestedAt:   Date | null;
  createdAt:     Date;
  updatedAt:     Date;
}

const toDirective = (r: any): Directive => ({
  id: r.id, fromAgentId: r.from_agent_id ?? null, toAgentId: r.to_agent_id, kind: r.kind, binding: r.binding ?? (r.kind === 'advice' ? 'advice' : 'directive'),
  structural: !!r.structural, body: r.body,
  params: r.params ?? {}, rationale: r.rationale, evidence: r.evidence ?? null, expected: r.expected ?? null, reviewAt: r.review_at ?? null,
  status: r.status, resolution: r.resolution ?? null, reasonKind: r.reason_kind ?? null, ownerDecision: r.owner_decision ?? null,
  outcome: r.outcome ?? null, outcomeDetail: r.outcome_detail ?? null, deliveredAt: r.delivered_at ?? null, appliedAt: r.applied_at ?? null,
  runId: r.run_id ?? null, shadow: !!r.shadow, change: r.change ?? null, execAttempts: Number(r.exec_attempts ?? 0), execError: r.exec_error ?? null,
  verification: r.verification ?? null, verifiedAt: r.verified_at ?? null, contestedAt: r.contested_at ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN: DirectiveStatus[] = ['new', 'awaiting_owner', 'accepted', 'applied', 'contested'];

type Q = Pick<Pool, 'query'>;

/** agent_directives, manager_reviews and agent_memory (053). */
export class DirectivesRepository {
  constructor(private readonly pool: Q) {}

  async insert(d: {
    fromAgentId: string | null; toAgentId: string; kind: DirectiveKind; binding?: DirectiveBinding; structural: boolean; body: string; params: Record<string, unknown>;
    rationale: string; evidence: unknown; expected: Expected | null; reviewAt: Date | null; status: 'new' | 'awaiting_owner'; runId?: string | null; shadow: boolean;
    /** Spec 025: outcome_detail at filing ({at_filing: {metric, value}, admission}) — the escalation baseline. */
    outcomeDetail?: unknown; change?: unknown;
  }): Promise<Directive> {
    const binding = d.binding ?? (d.kind === 'advice' ? 'advice' : 'directive');
    const { rows } = await this.pool.query(
      `INSERT INTO agent_directives (from_agent_id, to_agent_id, kind, structural, body, params, rationale, evidence, expected, review_at, status, run_id, shadow, binding, outcome_detail, change)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [d.fromAgentId, d.toAgentId, d.kind, d.structural, d.body, JSON.stringify(d.params), d.rationale, JSON.stringify(d.evidence ?? null),
        d.expected ? JSON.stringify(d.expected) : null, d.reviewAt, d.status, UUID_RE.test(d.runId ?? '') ? d.runId : null, d.shadow, binding,
        d.outcomeDetail == null ? null : JSON.stringify(d.outcomeDetail), d.change == null ? null : JSON.stringify(d.change)]);
    return toDirective(rows[0]);
  }

  async get(id: string): Promise<Directive | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agent_directives WHERE id = $1`, [id]);
    return rows[0] ? toDirective(rows[0]) : null;
  }

  async list(f: { status?: DirectiveStatus[] | null; toAgentId?: string | null; limit?: number; binding?: DirectiveBinding | null; kinds?: DirectiveKind[] | null; verified?: boolean | null } = {}): Promise<Directive[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_directives WHERE ($1::text[] IS NULL OR status = ANY($1::text[])) AND ($2::uuid IS NULL OR to_agent_id = $2)
          AND ($4::text IS NULL OR binding = $4) AND ($5::text[] IS NULL OR kind = ANY($5::text[]))
          AND ($6::boolean IS NULL OR (verified_at IS NOT NULL) = $6)
        ORDER BY created_at DESC LIMIT $3`,
      [f.status ?? null, f.toAgentId ?? null, f.limit ?? 100, f.binding ?? null, f.kinds?.length ? f.kinds : null, f.verified ?? null]);
    return rows.map(toDirective);
  }

  /** Open binding directives of a target (spec 025 FR-003: at most 2). Shadow rows count only against shadow filings. */
  async countOpenBinding(toAgentId: string, shadow: boolean): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_directives WHERE to_agent_id = $1 AND binding = 'directive' AND status = ANY($2::text[]) AND shadow = $3`,
      [toAgentId, OPEN, shadow]);
    return Number(rows[0]?.n ?? 0);
  }

  /** The latest advice of a kind to a target declined since `since` (spec 025 FR-003 escalation basis). */
  async lastDeclinedAdvice(toAgentId: string, kind: DirectiveKind, since: Date): Promise<Directive | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_directives WHERE to_agent_id = $1 AND kind = $2 AND binding = 'advice' AND status = 'declined' AND updated_at >= $3 AND NOT shadow
        ORDER BY updated_at DESC LIMIT 1`, [toAgentId, kind, since]);
    return rows[0] ? toDirective(rows[0]) : null;
  }

  async openFor(toAgentId: string, kind: DirectiveKind): Promise<Directive | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_directives WHERE to_agent_id = $1 AND kind = $2 AND status = ANY($3::text[]) AND NOT shadow LIMIT 1`, [toAgentId, kind, OPEN]);
    return rows[0] ? toDirective(rows[0]) : null;
  }

  async lastRejected(toAgentId: string, kind: DirectiveKind): Promise<Date | null> {
    const { rows } = await this.pool.query(
      `SELECT max(updated_at) AS at FROM agent_directives WHERE to_agent_id = $1 AND kind = $2 AND status = 'rejected'`, [toAgentId, kind]);
    return rows[0]?.at ?? null;
  }

  async countForRun(runId: string): Promise<number> {
    if (!UUID_RE.test(runId)) return 0;
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM agent_directives WHERE run_id = $1`, [runId]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Delivered-to-orchestrator directives: status new, not shadow (spec 021 FR-006). */
  async inbox(toAgentId: string): Promise<Directive[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_directives WHERE to_agent_id = $1 AND status = 'new' AND NOT shadow ORDER BY created_at`, [toAgentId]);
    return rows.map(toDirective);
  }

  async markDelivered(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(`UPDATE agent_directives SET delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
  }

  async update(id: string, p: Partial<{ status: DirectiveStatus; resolution: string | null; reasonKind: string | null; ownerDecision: string; outcome: DirectiveOutcome; outcomeDetail: unknown; appliedAt: Date; reviewAt: Date; shadow: boolean }>, onlyIf?: DirectiveStatus[]): Promise<Directive | null> {
    if (p.shadow !== undefined) await this.pool.query(`UPDATE agent_directives SET shadow = $2 WHERE id = $1`, [id, p.shadow]);
    const { rows } = await this.pool.query(
      `UPDATE agent_directives SET
         status = COALESCE($2, status), resolution = COALESCE($3, resolution), reason_kind = COALESCE($4, reason_kind),
         owner_decision = COALESCE($5, owner_decision), outcome = COALESCE($6, outcome), outcome_detail = COALESCE($7, outcome_detail),
         applied_at = COALESCE($8, applied_at), review_at = COALESCE($9, review_at), updated_at = now()
       WHERE id = $1 AND ($10::text[] IS NULL OR status = ANY($10::text[])) RETURNING *`,
      [id, p.status ?? null, p.resolution ?? null, p.reasonKind ?? null, p.ownerDecision ?? null, p.outcome ?? null,
        p.outcomeDetail === undefined ? null : JSON.stringify(p.outcomeDetail), p.appliedAt ?? null, p.reviewAt ?? null, onlyIf ?? null]);
    return rows[0] ? toDirective(rows[0]) : null;
  }

  /** Orchestrators with directives waiting longer than `minAgeMs` and not yet delivered (event runs). */
  async undeliveredTargets(minAgeMs: number): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT to_agent_id FROM agent_directives
        WHERE status = 'new' AND NOT shadow AND delivered_at IS NULL AND created_at < now() - ($1 || ' milliseconds')::interval`, [String(minAgeMs)]);
    return rows.map((r) => r.to_agent_id);
  }

  async expireUnresolved(maxAgeMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_directives SET status = 'expired', resolution = 'not resolved within 24 h', updated_at = now()
        WHERE status = 'new' AND (
          (delivered_at IS NOT NULL AND delivered_at < now() - ($1 || ' milliseconds')::interval)
          OR (delivered_at IS NULL AND created_at < now() - ($1 || ' milliseconds')::interval * 2))`, [String(maxAgeMs)]);
    return rowCount ?? 0;
  }

  async awaitingOwnerOlderThan(ms: number): Promise<Directive[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_directives WHERE status = 'awaiting_owner' AND NOT shadow AND created_at < now() - ($1 || ' milliseconds')::interval`, [String(ms)]);
    return rows.map(toDirective);
  }

  async dueForEvaluation(now: Date): Promise<Directive[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_directives WHERE status = 'applied' AND review_at IS NOT NULL AND review_at <= $1 ORDER BY review_at`, [now]);
    return rows.map(toDirective);
  }

  /** Accepted (not promo) directives of an agent are applied once its orchestration run has finished. */
  async applyAccepted(toAgentId: string, except: DirectiveKind[]): Promise<Directive[]> {
    const { rows } = await this.pool.query(
      `UPDATE agent_directives SET status = 'applied', applied_at = now(), updated_at = now()
        WHERE to_agent_id = $1 AND status = 'accepted' AND NOT shadow AND NOT (kind = ANY($2::text[])) RETURNING *`, [toAgentId, except]);
    return rows.map(toDirective);
  }

  /** Other directives applied to the same agent on the same metric in a window (confounders). */
  async overlapping(d: Directive): Promise<number> {
    if (!d.expected) return 0;
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_directives
        WHERE id <> $1 AND to_agent_id = $2 AND status IN ('applied','evaluated') AND expected->>'metric' = $3
          AND applied_at BETWEEN $4::timestamptz - interval '7 days' AND $5`,
      [d.id, d.toAgentId, d.expected.metric, d.appliedAt ?? d.createdAt, d.reviewAt ?? new Date()]);
    return Number(rows[0]?.n ?? 0);
  }

  // ── manager reviews + memory ──────────────────────────────────────────────

  async addReview(r: { runId?: string | null; verdict: 'continue' | 'directives' | 'skipped'; summary: string; digestHash: string | null; directiveIds?: string[] }): Promise<void> {
    await this.pool.query(
      `INSERT INTO manager_reviews (run_id, verdict, summary, digest_hash, directive_ids) VALUES ($1, $2, $3, $4, $5)`,
      [UUID_RE.test(r.runId ?? '') ? r.runId : null, r.verdict, r.summary, r.digestHash, r.directiveIds ?? []]);
  }

  async lastReview(): Promise<{ verdict: string; digestHash: string | null; createdAt: Date } | null> {
    const { rows } = await this.pool.query(`SELECT verdict, digest_hash, created_at FROM manager_reviews ORDER BY created_at DESC LIMIT 1`);
    return rows[0] ? { verdict: rows[0].verdict, digestHash: rows[0].digest_hash ?? null, createdAt: rows[0].created_at } : null;
  }

  async reviews(limit = 50): Promise<Array<{ id: string; verdict: string; summary: string; directiveIds: string[]; createdAt: Date }>> {
    const { rows } = await this.pool.query(`SELECT * FROM manager_reviews ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows.map((r) => ({ id: r.id, verdict: r.verdict, summary: r.summary, directiveIds: r.directive_ids ?? [], createdAt: r.created_at }));
  }

  async addMemory(agentId: string, kind: 'insight' | 'rule' | 'avoid', text: string, evidence: unknown, by: 'reviewer' | 'owner' | 'system'): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_memory (agent_id, kind, text, evidence, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [agentId, kind, text.slice(0, 400), evidence == null ? null : JSON.stringify(evidence), by]);
  }

  async memory(agentId: string, limit = 30): Promise<Array<{ id: number; kind: string; text: string; createdBy: string; createdAt: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_memory WHERE agent_id = $1 AND active ORDER BY (created_by = 'owner') DESC, created_at DESC LIMIT $2`, [agentId, limit]);
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, text: r.text, createdBy: r.created_by, createdAt: r.created_at }));
  }

  /** Structural directives dropped by owner timeout in a row (the "owner is not responding" lesson). */
  async droppedInARow(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT owner_decision FROM agent_directives WHERE structural AND NOT shadow AND owner_decision IS NOT NULL ORDER BY updated_at DESC LIMIT 10`);
    let n = 0;
    for (const r of rows) { if (r.owner_decision === 'timeout_dropped') n++; else break; }
    return n;
  }
}
