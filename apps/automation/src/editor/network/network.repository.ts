import type { Pool } from 'pg';
import type { Playbook } from './playbook';

export type PlaybookStatus = 'draft' | 'pending_owner' | 'active' | 'superseded' | 'rejected';

export interface PlaybookRow {
  id:        string;
  agentId:   string;
  version:   number;
  status:    PlaybookStatus;
  brief:     string | null;
  body:      Playbook;
  review:    unknown;
  rationale: string | null;
  createdBy: 'orchestrator' | 'owner';
  createdAt: Date;
  decidedAt: Date | null;
}

const toPlaybook = (r: any): PlaybookRow => ({
  id: r.id, agentId: r.agent_id, version: Number(r.version), status: r.status, brief: r.brief ?? null, body: r.body,
  review: r.review ?? null, rationale: r.rationale ?? null, createdBy: r.created_by, createdAt: r.created_at, decidedAt: r.decided_at ?? null,
});

export const IDEA_STATUSES = ['new', 'accepted', 'needs_revision', 'rejected', 'planned', 'used', 'expired'] as const;
export type IdeaStatus = typeof IDEA_STATUSES[number];
export type IdeaOrigin = 'orchestrator' | 'series' | 'directive' | 'owner' | 'trend';

export interface IdeaVariant { resource_ref: string; format: string; note?: string }

export interface IdeaRow {
  id:         string;
  agentId:    string;
  title:      string;
  angle:      string | null;
  sources:    string[];
  variants:   IdeaVariant[];
  why:        string | null;
  evidence:   unknown;
  origin:     IdeaOrigin;
  originRef:  string | null;
  expiresAt:  Date;
  status:     IdeaStatus;
  revisions:  number;
  review:     any;
  createdAt:  Date;
  updatedAt:  Date;
}

const toIdea = (r: any): IdeaRow => ({
  id: r.id, agentId: r.agent_id, title: r.title, angle: r.angle ?? null, sources: r.sources ?? [], variants: r.variants ?? [],
  why: r.why ?? null, evidence: r.evidence ?? null, origin: r.origin, originRef: r.origin_ref ?? null, expiresAt: r.expires_at,
  status: r.status, revisions: Number(r.revisions ?? 0), review: r.review ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

type Q = Pick<Pool, 'query'>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** playbooks + content_ideas (052). */
export class NetworkRepository {
  constructor(private readonly pool: Q) {}

  // ── playbooks ─────────────────────────────────────────────────────────────

  async activePlaybook(agentId: string): Promise<PlaybookRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM playbooks WHERE agent_id = $1 AND status = 'active'`, [agentId]);
    return rows[0] ? toPlaybook(rows[0]) : null;
  }

  async pendingPlaybook(agentId: string): Promise<PlaybookRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM playbooks WHERE agent_id = $1 AND status = 'pending_owner' ORDER BY version DESC LIMIT 1`, [agentId]);
    return rows[0] ? toPlaybook(rows[0]) : null;
  }

  async playbook(id: string): Promise<PlaybookRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM playbooks WHERE id = $1`, [id]);
    return rows[0] ? toPlaybook(rows[0]) : null;
  }

  async playbookHistory(agentId: string, limit = 30): Promise<PlaybookRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM playbooks WHERE agent_id = $1 ORDER BY version DESC LIMIT $2`, [agentId, limit]);
    return rows.map(toPlaybook);
  }

  /**
   * Insert a new version. `active` supersedes the current active one (and any
   * pending draft); `pending_owner` supersedes an older pending draft.
   */
  async insertPlaybook(p: { agentId: string; status: 'pending_owner' | 'active'; brief: string | null; body: Playbook; review?: unknown; rationale: string | null; createdBy: 'orchestrator' | 'owner'; runId?: string | null }): Promise<PlaybookRow> {
    const { rows: v } = await this.pool.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM playbooks WHERE agent_id = $1`, [p.agentId]);
    if (p.status === 'active') {
      await this.pool.query(`UPDATE playbooks SET status = 'superseded', decided_at = now() WHERE agent_id = $1 AND status IN ('active','pending_owner')`, [p.agentId]);
    } else {
      await this.pool.query(`UPDATE playbooks SET status = 'superseded', decided_at = now() WHERE agent_id = $1 AND status = 'pending_owner'`, [p.agentId]);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO playbooks (agent_id, version, status, brief, body, review, rationale, created_by, run_id, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $3 = 'active' THEN now() END) RETURNING *`,
      [p.agentId, Number(v[0].v), p.status, p.brief, JSON.stringify(p.body), p.review == null ? null : JSON.stringify(p.review), p.rationale, p.createdBy, UUID_RE.test(p.runId ?? "") ? p.runId : null]);
    return toPlaybook(rows[0]);
  }

  async setPlaybookReview(id: string, review: unknown): Promise<void> {
    await this.pool.query(`UPDATE playbooks SET review = $2 WHERE id = $1`, [id, JSON.stringify(review)]);
  }

  /** Owner decision on a pending version. */
  async decidePlaybook(id: string, approve: boolean): Promise<PlaybookRow | null> {
    const pb = await this.playbook(id);
    if (!pb || pb.status !== 'pending_owner') return null;
    if (approve) {
      await this.pool.query(`UPDATE playbooks SET status = 'superseded', decided_at = now() WHERE agent_id = $1 AND status = 'active'`, [pb.agentId]);
    }
    const { rows } = await this.pool.query(
      `UPDATE playbooks SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending_owner' RETURNING *`, [id, approve ? 'active' : 'rejected']);
    return rows[0] ? toPlaybook(rows[0]) : null;
  }

  // ── ideas ─────────────────────────────────────────────────────────────────

  async addIdea(i: { agentId: string; title: string; angle?: string | null; sources: string[]; variants: IdeaVariant[]; why?: string | null; evidence?: unknown; origin: IdeaOrigin; originRef?: string | null; expiresAt: Date; status?: IdeaStatus }): Promise<IdeaRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO content_ideas (agent_id, title, angle, sources, variants, why, evidence, origin, origin_ref, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [i.agentId, i.title, i.angle ?? null, JSON.stringify(i.sources), JSON.stringify(i.variants), i.why ?? null,
        i.evidence == null ? null : JSON.stringify(i.evidence), i.origin, i.originRef ?? null, i.expiresAt, i.status ?? 'new']);
    return toIdea(rows[0]);
  }

  async idea(id: string): Promise<IdeaRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM content_ideas WHERE id = $1`, [id]);
    return rows[0] ? toIdea(rows[0]) : null;
  }

  async listIdeas(agentId: string, statuses: IdeaStatus[] | null, limit = 100): Promise<IdeaRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM content_ideas WHERE agent_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        ORDER BY created_at DESC LIMIT $3`, [agentId, statuses, limit]);
    return rows.map(toIdea);
  }

  async updateIdea(id: string, p: { status?: IdeaStatus; review?: unknown; reviewedBy?: string | null; title?: string; angle?: string | null; sources?: string[]; variants?: IdeaVariant[]; bumpRevision?: boolean }): Promise<IdeaRow | null> {
    const { rows } = await this.pool.query(
      `UPDATE content_ideas SET
         status = COALESCE($2, status), review = COALESCE($3, review), reviewed_by = COALESCE($4, reviewed_by),
         title = COALESCE($5, title), angle = COALESCE($6, angle), sources = COALESCE($7, sources), variants = COALESCE($8, variants),
         revisions = revisions + CASE WHEN $9 THEN 1 ELSE 0 END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, p.status ?? null, p.review === undefined ? null : JSON.stringify(p.review), p.reviewedBy ?? null, p.title ?? null, p.angle ?? null,
        p.sources ? JSON.stringify(p.sources) : null, p.variants ? JSON.stringify(p.variants) : null, !!p.bumpRevision]);
    return rows[0] ? toIdea(rows[0]) : null;
  }

  async expireIdeas(agentId: string, now: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE content_ideas SET status = 'expired', updated_at = now()
        WHERE agent_id = $1 AND status IN ('new','accepted','needs_revision') AND expires_at < $2`, [agentId, now]);
    return rowCount ?? 0;
  }

  /** Mark an idea used once none of its planned slots is still pending. */
  async settleIdea(ideaId: string): Promise<void> {
    await this.pool.query(
      `UPDATE content_ideas SET status = 'used', updated_at = now()
        WHERE id = $1 AND status = 'planned'
          AND NOT EXISTS (SELECT 1 FROM editor_slots WHERE idea_id = $1 AND status IN ('planned','running'))`, [ideaId]);
  }

  /** Rejections by reason code in the last 14 days (avoid-pattern learning). */
  async rejectionCount(agentId: string, reasonCode: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM content_ideas
        WHERE agent_id = $1 AND status = 'rejected' AND review->>'reason_code' = $2 AND updated_at > now() - interval '14 days'`, [agentId, reasonCode]);
    return Number(rows[0]?.n ?? 0);
  }

  // ── network ───────────────────────────────────────────────────────────────

  async groupOfChannel(channelKey: string): Promise<{ id: string; name: string; mode: 'mirror' | 'orchestrated' } | null> {
    const { rows } = await this.pool.query(
      `SELECT g.id, g.name, g.mode FROM tracked_channels t JOIN meta_account_groups g ON g.id = t.group_id
        WHERE t.channel_key = $1 LIMIT 1`, [channelKey]);
    return rows[0] ? { id: rows[0].id, name: rows[0].name, mode: rows[0].mode } : null;
  }

  async setGroupMode(groupId: string, mode: 'mirror' | 'orchestrated'): Promise<void> {
    await this.pool.query(`UPDATE meta_account_groups SET mode = $2 WHERE id = $1`, [groupId, mode]);
  }

  /** Every resource of a group: its Telegram channel, Meta accounts and TikTok accounts. */
  async groupResources(groupId: string): Promise<Array<{ ref: string; platform: string; title: string | null }>> {
    const { rows } = await this.pool.query(
      `SELECT 'telegram:' || channel_key AS ref, 'telegram' AS platform, title FROM tracked_channels WHERE group_id = $1 AND channel_key IS NOT NULL
       UNION ALL
       SELECT platform || ':' || id, platform, COALESCE(display_name, username) FROM meta_accounts WHERE group_id = $1 AND active
       UNION ALL
       SELECT 'tiktok:' || id, 'tiktok', COALESCE(display_name, username) FROM tiktok_accounts WHERE group_id = $1 AND active`, [groupId]);
    return rows.map((r) => ({ ref: r.ref, platform: r.platform, title: r.title ?? null }));
  }

  /** Titles/excerpts of the network's posts in the last `days` (idea dedup). */
  async recentExcerpts(refs: string[], days: number): Promise<string[]> {
    if (!refs.length) return [];
    const { rows } = await this.pool.query(
      `SELECT COALESCE(excerpt, '') AS t FROM network_posts WHERE resource_ref = ANY($1::text[]) AND posted_at >= now() - ($2 || ' days')::interval`,
      [refs, String(days)]);
    return rows.map((r) => String(r.t)).filter(Boolean);
  }
}
