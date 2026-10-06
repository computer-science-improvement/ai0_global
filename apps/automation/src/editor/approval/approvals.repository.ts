import type { Pool } from 'pg';
import { rowToSlot, type EditorSlot } from '../repo/editor-plans.repository';
import { dropWaitingPosts } from '../repo/editor-channels.repository';

/** A waiting / approved post with what the owner's card shows next to it. */
export interface ApprovalItem extends EditorSlot {
  planDate:       string;
  planRationale:  string | null;
  channelTitle:   string | null;
  timezone:       string;
  holdHours:      number;
  idea:           { id: string; title: string; angle: string | null; why: string | null } | null;
  updatedAt:      Date;
}

export interface ApprovalFilter {
  status?:   Array<'awaiting_approval' | 'approved' | 'expired'>;
  /** The anchor channel: every resource of its network (all its slots). */
  channel?:  string | null;
  /** The plan date (YYYY-MM-DD in the resource zone): a day's batch. */
  planDate?: string | null;
  /** A channel key (@chan) or a resource ref (telegram:@chan, instagram:123). */
  resource?: string | null;
  from?:     Date | null;
  to?:       Date | null;
  ideaId?:   string | null;
  limit?:    number;
}

const APPROVAL_STATUSES = ['awaiting_approval', 'approved'] as const;

function toItem(r: any): ApprovalItem {
  return {
    ...rowToSlot(r),
    planDate: r.plan_date, planRationale: r.plan_rationale ?? null, channelTitle: r.channel_title ?? null,
    timezone: r.timezone ?? 'Europe/Kyiv', holdHours: Number(r.approval_hold_hours ?? 6),
    idea: r.idea_title ? { id: r.idea_id, title: r.idea_title, angle: r.idea_angle ?? null, why: r.idea_why ?? null } : null,
    updatedAt: new Date(r.updated_at),
  };
}

const SELECT_ITEM = `
  SELECT s.*, p.plan_date::text AS plan_date, p.rationale AS plan_rationale, c.title AS channel_title, c.timezone,
         c.approval_hold_hours, i.title AS idea_title, i.angle AS idea_angle, i.why AS idea_why
    FROM editor_slots s
    JOIN editor_plans p ON p.id = s.plan_id
    LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
    LEFT JOIN content_ideas i ON i.id = s.idea_id`;

/**
 * Approval mode (spec 031) storage: the owner's single-flight decisions, the
 * publisher's claim of approved posts, expiry and the batch-alert dedupe.
 * Every decision is one conditional UPDATE, so two tabs can never both win.
 */
export class ApprovalsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(id: string): Promise<ApprovalItem | null> {
    const { rows } = await this.pool.query(`${SELECT_ITEM} WHERE s.id = $1`, [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async list(f: ApprovalFilter = {}): Promise<ApprovalItem[]> {
    const status = f.status?.length ? f.status : [...APPROVAL_STATUSES];
    const res = f.resource?.trim() || null;
    const { rows } = await this.pool.query(
      `${SELECT_ITEM}
        WHERE s.status = ANY($1::text[])
          AND ($2::text IS NULL OR s.channel_key = $2 OR s.resource_ref = $2 OR ('telegram:' || s.channel_key = $2 AND s.resource_ref IS NULL))
          AND ($3::timestamptz IS NULL OR s.scheduled_at >= $3)
          AND ($4::timestamptz IS NULL OR s.scheduled_at < $4)
          AND ($5::uuid IS NULL OR s.idea_id = $5)
          AND ($7::text IS NULL OR s.channel_key = $7)
          AND ($8::date IS NULL OR p.plan_date = $8::date)
        ORDER BY s.channel_key, s.scheduled_at
        LIMIT $6`,
      [status, res, f.from ?? null, f.to ?? null, f.ideaId ?? null, Math.min(Math.max(f.limit ?? 300, 1), 1000),
        f.channel?.trim() || null, f.planDate ?? null]);
    return rows.map(toItem);
  }

  /** Posts waiting for the owner (the menu badge). */
  async waitingCount(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM editor_slots WHERE status = 'awaiting_approval'`);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Single-flight approve: only a waiting post can be approved; null when
   * someone decided first. `moveTo` moves a late post in the same statement,
   * so the publisher never sees it approved at its old, missed time.
   */
  async approve(id: string, moveTo: Date | null = null): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'approved', approved_at = now(), approved_by = 'owner', updated_at = now(),
              scheduled_at = COALESCE($2, scheduled_at)
        WHERE id = $1 AND status = 'awaiting_approval' RETURNING *`, [id, moveTo]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Times of the channel's other live slots near `at` (spacing check of a reschedule). */
  async busyTimes(channelKey: string, from: Date, to: Date, excludeId: string): Promise<Date[]> {
    const { rows } = await this.pool.query(
      `SELECT scheduled_at FROM editor_slots
        WHERE channel_key = $1 AND id <> $4 AND resource_ref IS NOT DISTINCT FROM (SELECT resource_ref FROM editor_slots WHERE id = $4)
          AND status IN ('planned','running','awaiting_approval','approved','published')
          AND scheduled_at >= $2 AND scheduled_at <= $3`, [channelKey, from, to, excludeId]);
    return rows.map((r) => new Date(r.scheduled_at));
  }

  /** An owner edit of a waiting platform post: its platform_posts row follows the slot. */
  async updateWaitingPlatformPost(id: number, caption: string, spec: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE platform_posts SET caption = $2, spec = $3 WHERE id = $1 AND status = 'awaiting_approval'`, [id, caption, JSON.stringify(spec)]);
  }

  /**
   * Single-flight edit-and-approve: a waiting post, or an approved one until
   * `lockBefore` (2 minutes before its time). The edited render replaces the
   * stored one; the post is approved and marked owner_edited.
   */
  async editAndApprove(id: string, p: {
    postSpec: unknown; renderedPreview: string; renderMessages: unknown; preparedMedia: unknown; lintWarnings: string[]; lockBefore: Date;
  }): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'approved', approved_at = now(), approved_by = 'owner', owner_edited = true,
              post_spec = $2, rendered_preview = $3, render_messages = $4, prepared_media = $5, lint_warnings = $6, error = NULL, updated_at = now()
        WHERE id = $1 AND (status = 'awaiting_approval' OR (status = 'approved' AND scheduled_at > $7)) RETURNING *`,
      [id, JSON.stringify(p.postSpec), p.renderedPreview, JSON.stringify(p.renderMessages), JSON.stringify(p.preparedMedia ?? {}),
        JSON.stringify(p.lintWarnings), p.lockBefore]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Move a waiting or approved post to a new time (validated by the service). */
  async reschedule(id: string, at: Date, lockBefore: Date): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET scheduled_at = $2, freshness_deadline = CASE WHEN freshness_deadline IS NULL THEN NULL ELSE $2::timestamptz + interval '30 minutes' END,
              updated_at = now()
        WHERE id = $1 AND (status = 'awaiting_approval' OR (status = 'approved' AND scheduled_at > $3)) RETURNING *`,
      [id, at, lockBefore]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Single-flight reject: the post becomes `skipped` with the owner's reason; its waiting platform row is canceled. */
  async reject(id: string, reason: string | null, lockBefore: Date): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', reject_reason = $2, error = 'rejected by owner', updated_at = now()
        WHERE id = $1 AND (status = 'awaiting_approval' OR (status = 'approved' AND scheduled_at > $3)) RETURNING *`,
      [id, reason, lockBefore]);
    const slot = rows[0] ? rowToSlot(rows[0]) : null;
    if (slot?.platformPostId) await this.cancelPlatformPosts([slot.platformPostId], 'rejected');
    return slot;
  }

  /** The one replacement a rejected post may get: a new planned slot at the same time (unique per rejected slot). */
  async insertReplacement(rejected: EditorSlot, note: string): Promise<string | null> {
    if (rejected.replacesSlotId) return null; // a replacement is never replaced again
    const { rows } = await this.pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, angle, source_hints, is_experiment, resource_ref, idea_id, replaces_slot_id)
       SELECT plan_id, channel_key, scheduled_at, 'content', format, topic, $2, source_hints, is_experiment, resource_ref, idea_id, id
         FROM editor_slots WHERE id = $1 AND kind = 'content'
       ON CONFLICT (replaces_slot_id) WHERE replaces_slot_id IS NOT NULL DO NOTHING
       RETURNING id`, [rejected.id, note.slice(0, 1000)]);
    return rows[0]?.id ?? null;
  }

  async cancelPlatformPosts(ids: number[], reason: string): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(
      `UPDATE platform_posts SET status = 'canceled', error = $2 WHERE id = ANY($1::bigint[]) AND status = 'awaiting_approval'`, [ids, reason]);
  }

  /**
   * The publisher's claim: approved posts whose time has come move to
   * `running`. Only a row with approved_at can ever be claimed — the safety
   * invariant of approval mode lives in this WHERE.
   */
  async claimApprovedDue(now: Date, limit: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', updated_at = now()
        WHERE id IN (
          SELECT id FROM editor_slots
           WHERE status = 'approved' AND approved_at IS NOT NULL AND scheduled_at <= $1
           ORDER BY scheduled_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
          AND approved_at IS NOT NULL
        RETURNING *`, [now, limit]);
    return rows.map(rowToSlot);
  }

  /**
   * FR-007: a post still waiting `approval_hold_hours` after its time (or past
   * its freshness deadline) expires and is never published by itself. An
   * approved post the publisher could not send within the same window
   * expires too, instead of going out hours late.
   */
  async expire(now: Date): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots s SET status = 'expired', updated_at = now(),
              error = CASE WHEN s.status = 'approved' THEN 'approved, but not published in time'
                           WHEN s.freshness_deadline IS NOT NULL AND s.freshness_deadline <= $1 THEN 'expired: past its freshness deadline'
                           ELSE 'expired: not approved in time' END
         FROM editor_channels c
        WHERE c.channel_key = s.channel_key AND s.status IN ('awaiting_approval','approved')
          AND ((s.status = 'awaiting_approval' AND s.freshness_deadline IS NOT NULL AND s.freshness_deadline <= $1)
               OR s.scheduled_at + make_interval(hours => c.approval_hold_hours) <= $1)
        RETURNING s.*`, [now]);
    const slots = rows.map(rowToSlot);
    await this.cancelPlatformPosts(slots.map((s) => s.platformPostId).filter((x): x is number => x != null), 'expired');
    return slots;
  }

  /** Channels that still have waiting or approved posts (the mode sweep checks their effective mode). */
  async channelsWithWaiting(): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT channel_key FROM editor_slots WHERE status IN ('awaiting_approval','approved')`);
    return rows.map((r) => r.channel_key);
  }

  dropWaiting(channelKey: string): Promise<number> {
    return dropWaitingPosts(this.pool, channelKey);
  }

  // ── facts the publisher re-checks at publish time ─────────────────────────

  /** Dedup after approval: the source went out on the channel while the post waited (published posts only). */
  async publishedSource(channelKey: string, ref: string, excludeSlotId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM published_posts WHERE channel_id = $1 AND source_url = $2 AND editor_slot_id IS DISTINCT FROM $3
       UNION ALL
       SELECT 1 FROM editor_slots WHERE channel_key = $1 AND status = 'published' AND id <> $3
          AND (post_spec->'source'->>'url' = $2 OR post_spec->>'library_ref' = $2)
       LIMIT 1`, [channelKey, ref, excludeSlotId]);
    return rows.length > 0;
  }

  /** Texts published on the channel recently (similarity re-check after approval). */
  async publishedTexts(channelKey: string, excludeSlotId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `(SELECT COALESCE(rendered_preview, topic) AS text FROM editor_slots
         WHERE channel_key = $1 AND status = 'published' AND id <> $2 AND updated_at > now() - interval '30 days'
         ORDER BY updated_at DESC LIMIT 60)
       UNION ALL
       (SELECT title AS text FROM published_posts
         WHERE channel_id = $1 AND title IS NOT NULL AND editor_slot_id IS NULL ORDER BY posted_at DESC LIMIT 60)`,
      [channelKey, excludeSlotId]);
    return rows.map((r) => String(r.text ?? ''));
  }

  // ── the owner's Telegram batch alert (T4) ─────────────────────────────────

  /** Batches (channel, plan date) with waiting posts and nothing of that day still being written. */
  async settledBatches(): Promise<Array<{ channelKey: string; batchDate: string; waiting: number; title: string | null }>> {
    const { rows } = await this.pool.query(
      `SELECT s.channel_key, p.plan_date::text AS batch_date, COUNT(*) FILTER (WHERE s.status = 'awaiting_approval')::int AS waiting,
              max(c.title) AS title
         FROM editor_slots s
         JOIN editor_plans p ON p.id = s.plan_id
         LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
        WHERE p.status = 'active' AND p.plan_date >= CURRENT_DATE - 1
          AND NOT EXISTS (SELECT 1 FROM approval_alerts a WHERE a.channel_key = s.channel_key AND a.batch_date = p.plan_date)
        GROUP BY 1, 2
       HAVING COUNT(*) FILTER (WHERE s.status = 'awaiting_approval') > 0
          AND COUNT(*) FILTER (WHERE s.status = 'running') = 0`);
    return rows.map((r) => ({ channelKey: r.channel_key, batchDate: r.batch_date, waiting: Number(r.waiting), title: r.title ?? null }));
  }

  /** Claim the alert of a batch once, across restarts: true only for the first caller. */
  async claimAlert(channelKey: string, batchDate: string, posts: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO approval_alerts (channel_key, batch_date, posts) VALUES ($1, $2, $3)
       ON CONFLICT (channel_key, batch_date) DO NOTHING RETURNING channel_key`, [channelKey, batchDate, posts]);
    return rows.length > 0;
  }

  async releaseAlert(channelKey: string, batchDate: string): Promise<void> {
    await this.pool.query(`DELETE FROM approval_alerts WHERE channel_key = $1 AND batch_date = $2`, [channelKey, batchDate]);
  }
}
