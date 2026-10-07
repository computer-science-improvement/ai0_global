import type { Pool } from 'pg';
import { ContentLedger, specRefs } from '../../data/content-ledger';
import type { PlannedSlot } from '../roles/plan-rules';

export type SlotStatus =
  | 'planned' | 'running' | 'published' | 'shadowed' | 'skipped' | 'failed'
  // Spec 031 (approval mode): written and waiting for the owner / approved, published at its time / never approved in time.
  | 'awaiting_approval' | 'approved' | 'expired';

export interface EditorSlot {
  id:              string;
  planId:          string;
  channelKey:      string;
  scheduledAt:     Date;
  kind:            'content' | 'reserved';
  format:          string;
  topic:           string;
  angle:           string | null;
  sourceHints:     string[];
  isExperiment:    boolean;
  status:          SlotStatus;
  attempts:        number;
  runId:           string | null;
  publishedPostId: number | null;
  postSpec:        unknown;
  renderedPreview: string | null;
  error:           string | null;
  /** Non-Telegram target of a network slot (`<platform>:<id>`, spec 019/020); null = the channel itself. */
  resourceRef?:    string | null;
  /** The pool idea the slot realises (spec 020). */
  ideaId?:         string | null;
  /** Promo between own resources (spec 022). */
  promo?:          Record<string, unknown> | null;
  createdAt?:      Date;
  // ── approval mode (spec 031); present only when set ──
  approvedAt?:        Date | null;
  ownerEdited?:       boolean;
  rejectReason?:      string | null;
  /** Telegram: { messages, primary }; platform: { platform, rendered } — exactly what is approved and sent. */
  renderMessages?:    ApprovalRender | null;
  preparedMedia?:     { slideUrls?: string[]; longreadUrl?: string } | null;
  lintWarnings?:      string[] | null;
  freshnessDeadline?: Date | null;
  replacesSlotId?:    string | null;
  platformPostId?:    number | null;
  // ── independent resources (spec 024); present only when set ──
  /** unique / duplicate / adapt; null = a pre-024 or single-channel slot. */
  treatment?:         'unique' | 'duplicate' | 'adapt' | null;
  treatmentReason?:   string | null;
  /** The unique slot a duplicate / adapt slot is made from. */
  derivedFromSlotId?: string | null;
  /** A derived slot's non-slot source and the agent's format notes (`{ key?, format_notes?, via? }`). */
  sourcePost?:        DerivedSourceRef | null;
}

/** editor_slots.source_post of a derived slot (spec 024). */
export interface DerivedSourceRef {
  /** `slot:<uuid>`, `pp:<platform_posts.id>` or `tg:<published_posts.id>`. */
  key?:          string;
  format_notes?: string | null;
  /** 'repurpose' for slots made by repurpose_post (kept across a re-plan of the day). */
  via?:          'plan' | 'repurpose';
}

/** A content decision of a plan (spec 024 FR-006): one per (idea, resource). */
export interface PlanDecisionInput {
  ideaId:      string;
  resourceRef: string;
  decision:    'unique' | 'duplicate' | 'adapt' | 'skip';
  reason:      string;
  reasonCode:  string | null;
  slotIndex:   number | null;
  decidedBy:   'planner' | 'system';
}

/** The stored payload of a written approval-mode post (render_messages). */
export type ApprovalRender =
  | { kind: 'telegram'; messages: unknown[]; primary: number }
  | { kind: 'platform'; platform: string; rendered: Record<string, unknown> }
  // Spec 022 repost in approval mode: a native forward of an own post, sent after approval.
  | { kind: 'forward'; fromKey: string; messageId: number };

/** Rationale of a plan created only to hold reserved (ad) slots; the planner still plans that day. */
export const RESERVED_ONLY_RATIONALE = 'reserved only';

export interface ReserveSlotInput {
  channelKey:  string;
  planDate:    string;
  scheduledAt: Date;
  format:      string;
  topic:       string;
  /** Traceability, e.g. ['ad_order:<uuid>']. */
  sourceHints: string[];
  /** Snapshot of the approved creative; published as-is. */
  postSpec:    unknown;
  /** Spec 022: a promo between own resources (written by the agent at its time). */
  promo?:      Record<string, unknown> | null;
  /** Spec 022: the promo is posted on another resource of the network. */
  resourceRef?: string | null;
}

export function rowToSlot(r: any): EditorSlot {
  return {
    id: r.id, planId: r.plan_id, channelKey: r.channel_key, scheduledAt: new Date(r.scheduled_at),
    kind: r.kind, format: r.format, topic: r.topic, angle: r.angle ?? null, sourceHints: r.source_hints ?? [],
    isExperiment: !!r.is_experiment, status: r.status, attempts: Number(r.attempts), runId: r.run_id ?? null,
    publishedPostId: r.published_post_id == null ? null : Number(r.published_post_id),
    postSpec: r.post_spec ?? null, renderedPreview: r.rendered_preview ?? null, error: r.error ?? null,
    ...(r.resource_ref ? { resourceRef: r.resource_ref } : {}),
    ...(r.idea_id ? { ideaId: r.idea_id } : {}),
    ...(r.promo ? { promo: r.promo } : {}),
    ...(r.created_at ? { createdAt: new Date(r.created_at) } : {}),
    ...(r.approved_at ? { approvedAt: new Date(r.approved_at) } : {}),
    ...(r.owner_edited ? { ownerEdited: true } : {}),
    ...(r.reject_reason ? { rejectReason: r.reject_reason } : {}),
    ...(r.render_messages ? { renderMessages: r.render_messages } : {}),
    ...(r.prepared_media ? { preparedMedia: r.prepared_media } : {}),
    ...(r.lint_warnings ? { lintWarnings: r.lint_warnings } : {}),
    ...(r.freshness_deadline ? { freshnessDeadline: new Date(r.freshness_deadline) } : {}),
    ...(r.replaces_slot_id ? { replacesSlotId: r.replaces_slot_id } : {}),
    ...(r.platform_post_id != null ? { platformPostId: Number(r.platform_post_id) } : {}),
    ...(r.treatment ? { treatment: r.treatment } : {}),
    ...(r.treatment_reason ? { treatmentReason: r.treatment_reason } : {}),
    ...(r.derived_from_slot_id ? { derivedFromSlotId: r.derived_from_slot_id } : {}),
    ...(r.source_post ? { sourcePost: r.source_post } : {}),
  };
}

/** Rationale of a plan created by repurpose_post before the day was planned; the planner still plans that day (spec 024). */
export const REPURPOSE_RATIONALE = 'repurpose';

/** A placeholder plan (reserved slots or repurposed posts only): the scheduler still runs the planner for its day. */
export function isPlaceholderPlan(rationale: string | null | undefined): boolean {
  return rationale === RESERVED_ONLY_RATIONALE || rationale === REPURPOSE_RATIONALE;
}

/** Statuses of a source slot that still may publish: its derived slots wait (spec 024 FR-007). */
export const SOURCE_PENDING = ['planned', 'running', 'awaiting_approval', 'approved'] as const;
/** SQL guard for claiming a content slot: a derived slot is due only once its source finished (published, shadowed, failed…). */
const DERIVED_READY = `(s.derived_from_slot_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM editor_slots src WHERE src.id = s.derived_from_slot_id AND src.status IN ('planned','running','awaiting_approval','approved')))`;

export interface EditorPlan {
  id:         string;
  channelKey: string;
  planDate:   string;
  status:     'active' | 'superseded';
  rationale:  string | null;
  runId:      string | null;
  createdAt:  Date;
  slots:      EditorSlot[];
}

export interface SlotStatusCount {
  channelKey: string;
  planDate:   string;
  status:     SlotStatus;
  n:          number;
}

export interface SlotResultPatch {
  status?:          SlotStatus;
  runId?:           string | null;
  publishedPostId?: number | null;
  postSpec?:        unknown;
  renderedPreview?: string | null;
  error?:           string | null;
  scheduledAt?:     Date;
  // spec 031
  renderMessages?:    ApprovalRender | null;
  preparedMedia?:     { slideUrls?: string[]; longreadUrl?: string } | null;
  lintWarnings?:      string[] | null;
  freshnessDeadline?: Date | null;
  platformPostId?:    number | null;
}

export class EditorPlansRepository {
  /** Spec 023 FR-010: every dedup question goes to the content ledger. */
  private readonly ledger: ContentLedger;

  constructor(private readonly pool: Pool) {
    this.ledger = new ContentLedger(pool);
  }

  async getActivePlan(channelKey: string, planDate: string): Promise<{ id: string; rationale: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, rationale FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`,
      [channelKey, planDate]);
    return rows[0] ?? null;
  }

  /** Reserved (ad) slots of the day — fixed points the planner must plan around. */
  async reservedSlots(channelKey: string, from: Date, to: Date): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE channel_key = $1 AND kind = 'reserved'
          AND status IN ('planned','running') AND scheduled_at >= $2 AND scheduled_at < $3 ORDER BY scheduled_at`,
      [channelKey, from, to]);
    return rows.map(rowToSlot);
  }

  /**
   * Put a reserved (paid ad) slot into the day's active plan. When the day has
   * no plan yet, a plan with RESERVED_ONLY_RATIONALE is created; the scheduler
   * still runs the planner for such a day and createPlan moves the reserved
   * slot into the real plan.
   */
  async reserveSlot(i: ReserveSlotInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3)
         ON CONFLICT (channel_key, plan_date) WHERE status = 'active' DO NOTHING`,
        [i.channelKey, i.planDate, RESERVED_ONLY_RATIONALE]);
      const plan = await client.query(
        `SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' FOR UPDATE`,
        [i.channelKey, i.planDate]);
      const { rows } = await client.query(
        i.promo
          ? `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, post_spec, promo, resource_ref)
             VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7, $8, $9) RETURNING id`
          : `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, post_spec)
             VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7) RETURNING id`,
        [plan.rows[0].id, i.channelKey, i.scheduledAt, i.format, i.topic, JSON.stringify(i.sourceHints), JSON.stringify(i.postSpec),
          ...(i.promo ? [JSON.stringify(i.promo), i.resourceRef ?? null] : [])]);
      await client.query('COMMIT');
      return rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Atomically move due reserved (ad) slots planned → running. Executed by code, never by the LLM. */
  async claimDueReserved(now: Date, limit: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM editor_slots
           WHERE status = 'planned' AND kind = 'reserved' AND scheduled_at <= $1
           ORDER BY scheduled_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [now, limit]);
    return rows.map(rowToSlot);
  }

  /**
   * Replace the day's plan atomically: old active plan → superseded, its
   * still-planned content slots → skipped, reserved slots move to the new plan.
   */
  async createPlan(channelKey: string, planDate: string, rationale: string, runId: string | null, slots: PlannedSlot[]): Promise<string> {
    return this.replacePlan(channelKey, planDate, rationale, runId, async (client, planId) => {
      for (const s of slots) {
        await client.query(
          s.ideaId
            ? `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, angle, source_hints, is_experiment, idea_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
            : `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, angle, source_hints, is_experiment)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [planId, channelKey, s.scheduledAt, s.format, s.topic, s.angle, JSON.stringify(s.sourceHints), s.isExperiment, ...(s.ideaId ? [s.ideaId] : [])]);
      }
    });
  }

  /** One transaction: supersede the day's active plan, move its reserved slots, insert the new slots. */
  private async replacePlan(
    channelKey: string, planDate: string, rationale: string, runId: string | null,
    insertSlots: (client: { query: Pool['query'] }, planId: string) => Promise<void>,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query(
        `UPDATE editor_plans SET status = 'superseded' WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' RETURNING id`,
        [channelKey, planDate]);
      const { rows } = await client.query(
        `INSERT INTO editor_plans (channel_key, plan_date, rationale, run_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [channelKey, planDate, rationale, runId && /^[0-9a-f-]{36}$/i.test(runId) ? runId : null]);
      const planId: string = rows[0].id;
      for (const o of old.rows) {
        // Spec 024: posts the agent repurposed into this day are its own decisions, not the old plan's — they move along.
        await client.query(
          `UPDATE editor_slots SET plan_id = $2, updated_at = now()
            WHERE plan_id = $1 AND kind = 'content' AND status = 'planned' AND source_post->>'via' = 'repurpose'`, [o.id, planId]);
        // Unwritten slots and (spec 031) posts still waiting for approval go with the old plan; approved ones stay.
        const dropped = await client.query(
          `UPDATE editor_slots SET status = 'skipped', error = 'superseded by a new plan', updated_at = now()
            WHERE plan_id = $1 AND status IN ('planned','awaiting_approval') AND kind = 'content' RETURNING platform_post_id`, [o.id]);
        const waitingRows = dropped.rows.map((r: any) => r.platform_post_id).filter((x: unknown) => x != null);
        if (waitingRows.length) {
          await client.query(`UPDATE platform_posts SET status = 'canceled', error = 'superseded' WHERE id = ANY($1::bigint[]) AND status = 'awaiting_approval'`, [waitingRows]);
        }
        await client.query(`UPDATE editor_slots SET plan_id = $2, updated_at = now() WHERE plan_id = $1 AND kind = 'reserved'`, [o.id, planId]);
      }
      await insertSlots(client as any, planId);
      await client.query('COMMIT');
      return planId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A network day plan (spec 020): the anchor channel's plan holds slots for
   * every resource of the network; non-Telegram slots carry resource_ref.
   * Supersedes the day's active plan exactly like createPlan.
   */
  async createNetworkPlan(
    channelKey: string, planDate: string, rationale: string, runId: string | null,
    slots: Array<{
      resourceRef: string; scheduledAt: Date; format: string; topic: string; angle: string | null; ideaId: string | null; sourceHints: string[];
      // spec 024
      treatment?: 'unique' | 'duplicate' | 'adapt'; treatmentReason?: string | null; fromIndex?: number | null; formatNotes?: string | null;
    }>,
    decisions: PlanDecisionInput[] = [],
    agentId: string | null = null,
  ): Promise<string> {
    return this.replacePlan(channelKey, planDate, rationale, runId, async (client, planId) => {
      // Sources first: a derived slot points at its source's row (spec 024 FR-006; no chains, so one pass each).
      const ids: Array<string | null> = slots.map(() => null);
      const order = [...slots.keys()].sort((a, b) => Number(slots[a].fromIndex != null) - Number(slots[b].fromIndex != null));
      for (const k of order) {
        const s = slots[k];
        const isAnchor = s.resourceRef === `telegram:${channelKey}`;
        const derived = s.fromIndex != null && (s.treatment === 'duplicate' || s.treatment === 'adapt');
        const { rows } = await client.query(
          `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, angle, source_hints, is_experiment, resource_ref, idea_id,
                                     treatment, treatment_reason, derived_from_slot_id, source_post)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [planId, channelKey, s.scheduledAt, s.format, s.topic, s.angle, JSON.stringify(s.sourceHints), isAnchor ? null : s.resourceRef, s.ideaId,
            s.treatment ?? null, s.treatmentReason ?? null, derived ? ids[s.fromIndex!] : null,
            derived ? JSON.stringify({ via: 'plan', ...(s.formatNotes ? { format_notes: s.formatNotes } : {}) }) : null]);
        ids[k] = rows[0].id;
      }
      if (!decisions.length || !agentId) return;
      // A re-plan of the day replaces this planner's earlier decisions; repurpose_post / owner decisions stay (unique index wins).
      for (const d of decisions) {
        await client.query(
          `INSERT INTO content_decisions (agent_id, idea_id, resource_ref, decision, reason, reason_code, slot_id, decided_by, run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (idea_id, resource_ref) WHERE idea_id IS NOT NULL DO UPDATE
             SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, reason_code = EXCLUDED.reason_code, slot_id = EXCLUDED.slot_id,
                 decided_by = EXCLUDED.decided_by, run_id = EXCLUDED.run_id, created_at = now()
           WHERE content_decisions.decided_by IN ('planner','system')`,
          [agentId, d.ideaId, d.resourceRef, d.decision, d.reason.slice(0, 300) || '—', d.reasonCode, d.slotIndex == null ? null : ids[d.slotIndex],
            d.decidedBy, runId && /^[0-9a-f-]{36}$/i.test(runId) ? runId : null]);
      }
    });
  }

  /**
   * Spec 024 FR-008 (repurpose_post): put derived slots into the anchor's
   * active plan of their date (a plan with REPURPOSE_RATIONALE when the day
   * has none yet) and record one decision per target, in one transaction.
   * A decision that already exists (planner, another call) → null, nothing written.
   */
  async createRepurpose(i: {
    channelKey: string; agentId: string; callId: string; decidedBy: 'orchestrator' | 'planner' | 'executor' | 'owner'; runId: string | null;
    sourceKey: string; ideaId: string | null;
    targets: Array<{
      resourceRef: string; planDate: string; scheduledAt: Date; format: string; topic: string; treatment: 'duplicate' | 'adapt';
      reason: string; derivedFromSlotId: string | null; formatNotes: string | null;
    }>;
  }): Promise<Array<{ id: string; resourceRef: string; scheduledAt: Date }> | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out: Array<{ id: string; resourceRef: string; scheduledAt: Date }> = [];
      for (const t of i.targets) {
        await client.query(
          `INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3)
           ON CONFLICT (channel_key, plan_date) WHERE status = 'active' DO NOTHING`, [i.channelKey, t.planDate, REPURPOSE_RATIONALE]);
        const plan = await client.query(
          `SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' FOR UPDATE`, [i.channelKey, t.planDate]);
        const isAnchor = t.resourceRef === `telegram:${i.channelKey}`;
        const { rows } = await client.query(
          `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, source_hints, is_experiment, resource_ref, idea_id,
                                     treatment, treatment_reason, derived_from_slot_id, source_post)
           VALUES ($1, $2, $3, $4, $5, '[]', false, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [plan.rows[0].id, i.channelKey, t.scheduledAt, t.format, t.topic.slice(0, 300), isAnchor ? null : t.resourceRef, i.ideaId,
            t.treatment, t.reason, t.derivedFromSlotId,
            JSON.stringify({ via: 'repurpose', key: i.sourceKey, ...(t.formatNotes ? { format_notes: t.formatNotes } : {}) })]);
        const dec = await client.query(
          `INSERT INTO content_decisions (agent_id, idea_id, source_key, resource_ref, decision, reason, slot_id, decided_by, run_id, call_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING id`,
          [i.agentId, i.ideaId, i.sourceKey, t.resourceRef, t.treatment, t.reason, rows[0].id, i.decidedBy,
            i.runId && /^[0-9a-f-]{36}$/i.test(i.runId) ? i.runId : null, i.callId]);
        if (!dec.rows.length) { await client.query('ROLLBACK'); return null; }
        out.push({ id: rows[0].id, resourceRef: t.resourceRef, scheduledAt: t.scheduledAt });
      }
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Atomically move due content slots planned → running (single-instance safe, and multi-instance safe too). */
  async claimDue(now: Date, limit: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT s.id FROM editor_slots s
           WHERE s.status = 'planned' AND s.kind = 'content' AND s.scheduled_at <= $1 AND ${DERIVED_READY}
           ORDER BY s.scheduled_at
           LIMIT $2
           FOR UPDATE OF s SKIP LOCKED)
        RETURNING *`,
      [now, limit]);
    return rows.map(rowToSlot);
  }

  /**
   * Spec 031 write-ahead: planned content slots of the given channels due
   * before `until`, oldest first. The scheduler decides per slot whether its
   * write time has come and claims it with claimSlot (atomic).
   */
  async plannedBefore(channelKeys: string[], until: Date, limit = 50): Promise<EditorSlot[]> {
    if (!channelKeys.length) return [];
    const { rows } = await this.pool.query(
      `SELECT s.* FROM editor_slots s WHERE s.status = 'planned' AND s.kind = 'content' AND s.channel_key = ANY($1::text[]) AND s.scheduled_at <= $2
          AND ${DERIVED_READY}
        ORDER BY s.scheduled_at LIMIT $3`, [channelKeys, until, limit]);
    return rows.map(rowToSlot);
  }

  /**
   * Spec 031 FR-009: planned promo slots (spec 022 reposts and cross-promo) of
   * approval-mode channels due before `until`; they are written ahead like
   * content slots so the owner can approve them in time.
   */
  async plannedPromoBefore(channelKeys: string[], until: Date, limit = 20): Promise<EditorSlot[]> {
    if (!channelKeys.length) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE status = 'planned' AND kind = 'reserved' AND promo IS NOT NULL
          AND channel_key = ANY($1::text[]) AND scheduled_at <= $2
        ORDER BY scheduled_at LIMIT $3`, [channelKeys, until, limit]);
    return rows.map(rowToSlot);
  }

  /** Claim ONE planned promo slot ahead of its time (planned → running, attempts+1), like claimDueReserved. */
  async claimPromoSlot(id: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'planned' AND kind = 'reserved' AND promo IS NOT NULL
        RETURNING *`, [id]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Planned slots that are more than `maxLateMs` overdue are skipped instead of posted late. */
  async skipStale(now: Date, maxLateMs: number): Promise<number> {
    // Spec 024 FR-007: a derived slot whose source never got out in time names why.
    const derived = await this.pool.query(
      `UPDATE editor_slots d SET status = 'skipped', error = 'source_not_published', updated_at = now()
        WHERE d.status = 'planned' AND d.kind = 'content' AND d.scheduled_at < $1
          AND EXISTS (SELECT 1 FROM editor_slots src WHERE src.id = d.derived_from_slot_id
                         AND src.status IN ('planned','running','awaiting_approval','approved'))`,
      [new Date(now.getTime() - maxLateMs)]);
    const { rowCount } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', error = 'stale: missed its time window', updated_at = now()
        WHERE status = 'planned' AND kind = 'content' AND scheduled_at < $1`,
      [new Date(now.getTime() - maxLateMs)]);
    return (rowCount ?? 0) + (derived?.rowCount ?? 0);
  }

  /** Slots stuck in running (process crash mid-run) → failed. */
  async sweepStuck(now: Date, stuckMs: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'failed', error = COALESCE(error, 'stuck in running (crash?)'), updated_at = now()
        WHERE status = 'running' AND updated_at < $1 RETURNING *`,
      [new Date(now.getTime() - stuckMs)]);
    await this.pool.query(
      `UPDATE editor_runs SET status = 'error', error = COALESCE(error, 'stuck (swept)'), finished_at = now()
        WHERE status = 'running' AND started_at < $1`,
      [new Date(now.getTime() - stuckMs)]);
    return rows.map(rowToSlot);
  }

  /**
   * Owner "run now" (006): claim ONE planned content slot regardless of its
   * time. Same transition as claimDue (planned → running, attempts+1), so the
   * scheduler can never run it a second time.
   */
  async claimSlot(id: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'planned' AND kind = 'content'
        RETURNING *`, [id]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Owner skip (006): only a slot that is still planned can be skipped. */
  async skipPlannedSlot(id: string, reason: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', error = $2, updated_at = now()
        WHERE id = $1 AND status = 'planned'
        RETURNING *`, [id, reason]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Plans of one date (active first), each with its slots. */
  async listPlans(planDate: string, channelKey?: string | null): Promise<EditorPlan[]> {
    const { rows: plans } = await this.pool.query(
      `SELECT id, channel_key, plan_date::text AS plan_date, status, rationale, run_id, created_at FROM editor_plans
        WHERE plan_date = $1 AND ($2::text IS NULL OR channel_key = $2)
        ORDER BY channel_key, (status = 'active') DESC, created_at DESC`,
      [planDate, channelKey ?? null]);
    if (!plans.length) return [];
    const { rows: slots } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE plan_id = ANY($1::uuid[]) ORDER BY scheduled_at`, [plans.map((p) => p.id)]);
    const byPlan = new Map<string, EditorSlot[]>();
    for (const r of slots) {
      const s = rowToSlot(r);
      byPlan.set(s.planId, [...(byPlan.get(s.planId) ?? []), s]);
    }
    return plans.map((p) => ({
      id: p.id, channelKey: p.channel_key, planDate: p.plan_date, status: p.status, rationale: p.rationale ?? null,
      runId: p.run_id ?? null, createdAt: p.created_at, slots: byPlan.get(p.id) ?? [],
    }));
  }

  /** Slot counts per status of every active plan dated on or after `sinceDate`. */
  async slotStatusCounts(sinceDate: string): Promise<SlotStatusCount[]> {
    const { rows } = await this.pool.query(
      `SELECT p.channel_key, p.plan_date::text AS plan_date, s.status, COUNT(*)::int AS n
         FROM editor_plans p JOIN editor_slots s ON s.plan_id = p.id
        WHERE p.status = 'active' AND p.plan_date >= $1
        GROUP BY 1, 2, 3`, [sinceDate]);
    return rows.map((r) => ({ channelKey: r.channel_key, planDate: r.plan_date, status: r.status, n: Number(r.n) }));
  }

  async getSlot(id: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_slots WHERE id = $1`, [id]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  async listSlots(channelKey: string, planId: string): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE channel_key = $1 AND plan_id = $2 ORDER BY scheduled_at`, [channelKey, planId]);
    return rows.map(rowToSlot);
  }

  async updateSlot(id: string, p: SlotResultPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (p.status !== undefined)          add('status', p.status);
    if (p.runId !== undefined)           add('run_id', p.runId);
    if (p.publishedPostId !== undefined) add('published_post_id', p.publishedPostId);
    if (p.postSpec !== undefined)        add('post_spec', p.postSpec === null ? null : JSON.stringify(p.postSpec));
    if (p.renderedPreview !== undefined) add('rendered_preview', p.renderedPreview);
    if (p.error !== undefined)           add('error', p.error);
    if (p.scheduledAt !== undefined)     add('scheduled_at', p.scheduledAt);
    if (p.renderMessages !== undefined)  add('render_messages', p.renderMessages === null ? null : JSON.stringify(p.renderMessages));
    if (p.preparedMedia !== undefined)   add('prepared_media', p.preparedMedia === null ? null : JSON.stringify(p.preparedMedia));
    if (p.lintWarnings !== undefined)    add('lint_warnings', p.lintWarnings === null ? null : JSON.stringify(p.lintWarnings));
    if (p.freshnessDeadline !== undefined) add('freshness_deadline', p.freshnessDeadline);
    if (p.platformPostId !== undefined)  add('platform_post_id', p.platformPostId);
    if (!sets.length) return;
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING channel_key, resource_ref`, params);
    // Spec 023 FR-010: a shadow preview holds its sources on the resource for 7 days.
    if (p.status === 'shadowed' && p.postSpec && rows?.[0]) {
      await this.ledger.recordRefs(specRefs(p.postSpec as any), {
        resourceRef: rows[0].resource_ref ?? rows[0].channel_key, origin: 'editor', status: 'shadowed', slotId: id,
      });
    }
  }

  /** How many of the channel's most recent finished slots failed in a row. */
  async consecutiveFailures(channelKey: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT status FROM editor_slots WHERE channel_key = $1 AND status IN ('published','shadowed','skipped','failed')
        ORDER BY updated_at DESC LIMIT 5`, [channelKey]);
    let n = 0;
    for (const r of rows) { if (r.status === 'failed') n++; else break; }
    return n;
  }

  // ── facts the publish guards need (all channels' publications, any source) ──

  async countPublishedSince(channelKey: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM published_posts WHERE channel_id = $1 AND posted_at >= $2`, [channelKey, since]);
    return rows[0]?.n ?? 0;
  }

  async lastPostAt(channelKey: string): Promise<Date | null> {
    const { rows } = await this.pool.query(`SELECT MAX(posted_at) AS at FROM published_posts WHERE channel_id = $1`, [channelKey]);
    return rows[0]?.at ? new Date(rows[0].at) : null;
  }

  /**
   * Dedup through the content ledger (spec 023 FR-010; the editor, the chat and the reserved path share it):
   * the source / library item was published on the channel (for ever, or within the dataset's reuse
   * window), is held by a shadow preview of the last 7 days, is error-marked anywhere, or (spec 031) a post
   * waits for approval or is approved with it. `excludeSlotId` leaves out the slot being re-checked itself.
   * A data:// ref and its legacy library:// ref name the same row (spec 032 FR-011).
   */
  async sourceAlreadyPosted(channelKey: string, sourceUrl: string, excludeSlotId: string | null = null): Promise<boolean> {
    return this.ledger.used(channelKey, sourceUrl, { waiting: true, excludeSlotId });
  }

  /** The chat's dedup (spec 010 → 023 FR-010): the same ledger rules, without the waiting posts. */
  async sourceUsed(channelKey: string, sourceUrl: string): Promise<boolean> {
    return this.ledger.used(channelKey, sourceUrl);
  }

  /** Recent texts for the similarity guard; waiting and approved posts count too (spec 031). */
  async recentTexts(channelKey: string, excludeSlotId: string | null = null): Promise<string[]> {
    const { rows } = await this.pool.query(
      `(SELECT COALESCE(rendered_preview, topic) AS text FROM editor_slots
         WHERE channel_key = $1 AND status IN ('published','shadowed','awaiting_approval','approved')
           AND ($2::uuid IS NULL OR id <> $2) ORDER BY updated_at DESC LIMIT 60)
       UNION ALL
       (SELECT title AS text FROM published_posts
         WHERE channel_id = $1 AND title IS NOT NULL AND editor_slot_id IS NULL ORDER BY posted_at DESC LIMIT 60)`,
      [channelKey, excludeSlotId]);
    return rows.map((r) => String(r.text ?? ''));
  }

  async insertPublication(i: {
    channelKey: string; messageId: number; sourceUrl: string | null; title: string; tags: string[]; format: string; slotId: string | null;
    /** 'editor' for agent posts, 'ad' for reserved sponsored posts, 'chat' for posts from the editor chat (010). */
    strategyType?: 'editor' | 'ad' | 'chat';
    /** Every source ref of the post (library item and source URL); `sourceUrl` keeps only one. */
    refs?: Array<string | null | undefined>;
  }): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO published_posts (channel_id, message_id, source_url, title, strategy_type, tags, format, editor_slot_id)
       VALUES ($1, $2, $3, $4, $8, $5, $6, $7)
       ON CONFLICT (channel_id, message_id) DO UPDATE SET editor_slot_id = EXCLUDED.editor_slot_id
       RETURNING id`,
      [i.channelKey, i.messageId, i.sourceUrl, i.title, i.tags, i.format, i.slotId, i.strategyType ?? 'editor']);
    const postId = Number(rows[0].id);
    // Spec 023 FR-010: the publication goes into the content ledger (best-effort: the post is already out).
    await this.ledger.recordRefs([i.sourceUrl, ...(i.refs ?? [])], {
      resourceRef: i.channelKey, status: 'published', publishedPostId: postId, slotId: i.slotId,
      origin: i.strategyType === 'chat' ? 'chat' : i.strategyType === 'ad' ? 'manual' : 'editor',
    });
    return postId;
  }
}
