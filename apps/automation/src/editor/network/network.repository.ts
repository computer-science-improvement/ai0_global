import type { Pool } from 'pg';
import { ChannelMode, effectiveMode } from '../card';
import { localDate } from '../roles/time';
import type { Playbook } from './playbook';

/**
 * Network modes (spec 024 FR-002): `independent` — every member is its own
 * resource and the orchestrator decides what each publishes; `legacy_duplicate`
 * — the pre-024 mirror behaviour for groups the owner has not converted.
 */
export const NETWORK_MODES = ['independent', 'legacy_duplicate'] as const;
export type NetworkMode = typeof NETWORK_MODES[number];
/** Pre-024 names, accepted for one release (logged as deprecated). */
export const NETWORK_MODE_ALIASES: Record<string, NetworkMode> = { orchestrated: 'independent', mirror: 'legacy_duplicate' };

/** What the automatic-duplication gate looks at (spec 024 FR-003). */
export interface AutoDuplicateState {
  mode:             string;
  /** The anchor card's mode; null when the anchor has no editor card. */
  cardMode:         ChannelMode | null;
  /** The anchor orchestrator's mode; null when the anchor has no orchestrator. */
  orchestratorMode: ChannelMode | null;
  orchestratorPaused: boolean;
  hasPlaybook:      boolean;
}

/**
 * The gate itself: automatic duplication stops only when the network is
 * `independent` AND the anchor orchestrator runs `live` (orchestrator ∧ card,
 * not paused) AND it has an active playbook. Everything else keeps it on, so
 * no resource goes silent (020 FR-010).
 */
export function autoDuplicateRaw(s: AutoDuplicateState): boolean {
  if (s.mode !== 'independent' || !s.hasPlaybook) return true;
  if (!s.cardMode || !s.orchestratorMode || s.orchestratorPaused) return true;
  return effectiveMode(s.orchestratorMode, s.cardMode) !== 'live';
}

function safeLocalDate(now: Date, tz: string | null): string {
  try { return localDate(now, tz || 'Europe/Kyiv'); } catch { return localDate(now, 'Europe/Kyiv'); }
}

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
  createdBy: 'orchestrator' | 'owner' | 'migration';
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

/** content_decisions (061): one decision per (idea or source, resource). */
export interface ContentDecisionRow {
  id:          string;
  agentId:     string;
  ideaId:      string | null;
  sourceKey:   string | null;
  resourceRef: string;
  decision:    'unique' | 'duplicate' | 'adapt' | 'skip';
  reason:      string;
  reasonCode:  string | null;
  slotId:      string | null;
  decidedBy:   'planner' | 'orchestrator' | 'executor' | 'owner' | 'system';
  runId:       string | null;
  createdAt:   Date;
}

const toDecision = (r: any): ContentDecisionRow => ({
  id: r.id, agentId: r.agent_id, ideaId: r.idea_id ?? null, sourceKey: r.source_key ?? null, resourceRef: r.resource_ref,
  decision: r.decision, reason: r.reason, reasonCode: r.reason_code ?? null, slotId: r.slot_id ?? null, decidedBy: r.decided_by,
  runId: r.run_id ?? null, createdAt: r.created_at,
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
  async insertPlaybook(p: { agentId: string; status: 'pending_owner' | 'active'; brief: string | null; body: Playbook; review?: unknown; rationale: string | null; createdBy: 'orchestrator' | 'owner' | 'migration'; runId?: string | null }): Promise<PlaybookRow> {
    // One transaction: never leave a network without an active playbook. An orchestrator's minor change keeps
    // the owner's pending draft (it is decided separately); an owner edit supersedes it (owner precedence).
    const conn = (this.pool as Partial<Pool>).connect ? await (this.pool as Pool).connect() : null;
    const q = conn ?? this.pool;
    try {
      if (conn) await conn.query('BEGIN');
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`playbook:${p.agentId}`]).catch(() => {});
      const { rows: v } = await q.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM playbooks WHERE agent_id = $1`, [p.agentId]);
      const supersede = p.status === 'active'
        ? (p.createdBy === 'owner' ? ['active', 'pending_owner'] : ['active'])
        : ['pending_owner'];
      await q.query(`UPDATE playbooks SET status = 'superseded', decided_at = now() WHERE agent_id = $1 AND status = ANY($2::text[])`, [p.agentId, supersede]);
      const { rows } = await q.query(
        `INSERT INTO playbooks (agent_id, version, status, brief, body, review, rationale, created_by, run_id, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $3 = 'active' THEN now() END) RETURNING *`,
        [p.agentId, Number(v[0].v), p.status, p.brief, JSON.stringify(p.body), p.review == null ? null : JSON.stringify(p.review), p.rationale, p.createdBy, UUID_RE.test(p.runId ?? "") ? p.runId : null]);
      if (conn) await conn.query('COMMIT');
      return toPlaybook(rows[0]);
    } catch (err) {
      if (conn) await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn?.release();
    }
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

  /**
   * Ideas left `planned` with no pending slot (replanned, skipped as stale, paused):
   * used when any slot of theirs went out, otherwise back to the pool.
   */
  async releaseStalePlanned(agentId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE content_ideas i SET updated_at = now(),
              status = CASE WHEN EXISTS (SELECT 1 FROM editor_slots s WHERE s.idea_id = i.id AND s.status IN ('published','shadowed')) THEN 'used' ELSE 'accepted' END
        WHERE i.agent_id = $1 AND i.status = 'planned'
          AND NOT EXISTS (SELECT 1 FROM editor_slots s WHERE s.idea_id = i.id AND s.status IN ('planned','running'))`, [agentId]);
    return rowCount ?? 0;
  }

  /** Rejections by reason code in the last 14 days (avoid-pattern learning). */
  async rejectionCount(agentId: string, reasonCode: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM content_ideas
        WHERE agent_id = $1 AND status = 'rejected' AND review->>'reason_code' = $2 AND updated_at > now() - interval '14 days'`, [agentId, reasonCode]);
    return Number(rows[0]?.n ?? 0);
  }

  // ── content decisions (spec 024) ─────────────────────────────────────────

  /** (idea → resources) decided by repurpose_post, the executor or the owner — a re-plan keeps them. */
  async decidedElsewhere(ideaIds: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (!ideaIds.length) return out;
    const { rows } = await this.pool.query(
      `SELECT idea_id, resource_ref FROM content_decisions
        WHERE idea_id = ANY($1::uuid[]) AND decided_by NOT IN ('planner','system')`, [ideaIds]);
    for (const r of rows) {
      if (!out.has(r.idea_id)) out.set(r.idea_id, new Set());
      out.get(r.idea_id)!.add(r.resource_ref);
    }
    return out;
  }

  /** The decisions of an agent (newest first), for the plan view and explain_decision. */
  async decisions(agentId: string, o: { ideaIds?: string[]; since?: Date; limit?: number } = {}): Promise<ContentDecisionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM content_decisions WHERE agent_id = $1
          AND ($2::uuid[] IS NULL OR idea_id = ANY($2::uuid[])) AND ($3::timestamptz IS NULL OR created_at >= $3)
        ORDER BY created_at DESC LIMIT $4`, [agentId, o.ideaIds ?? null, o.since ?? null, o.limit ?? 200]);
    return rows.map(toDecision);
  }

  // ── network ───────────────────────────────────────────────────────────────

  async groupOfChannel(channelKey: string): Promise<{ id: string; name: string; mode: NetworkMode } | null> {
    const { rows } = await this.pool.query(
      `SELECT g.id, g.name, g.mode FROM tracked_channels t JOIN meta_account_groups g ON g.id = t.group_id
        WHERE t.channel_key = $1 LIMIT 1`, [channelKey]);
    return rows[0] ? { id: rows[0].id, name: rows[0].name, mode: NETWORK_MODE_ALIASES[rows[0].mode] ?? rows[0].mode } : null;
  }

  /** Today's gate is pinned first, so a mode change takes effect at the anchor's next plan day (FR-003). */
  async setGroupMode(groupId: string, mode: NetworkMode, now: Date = new Date()): Promise<void> {
    await this.autoDuplicateActive(groupId, now);
    await this.pool.query(`UPDATE meta_account_groups SET mode = $2 WHERE id = $1`, [groupId, mode]);
  }

  /** The gate inputs of a group: its mode, the anchor card and orchestrator, the playbook, today's pin. */
  async autoDuplicateState(groupId: string): Promise<(AutoDuplicateState & { tz: string | null; pinnedDay: string | null; pinned: boolean | null }) | null> {
    const { rows } = await this.pool.query(
      `SELECT g.mode, g.auto_duplicate_day::text AS pinned_day, g.auto_duplicate AS pinned,
              ec.mode AS card_mode, ec.timezone, a.mode AS orch_mode, a.status AS orch_status, a.paused_until,
              EXISTS (SELECT 1 FROM playbooks p WHERE p.agent_id = a.id AND p.status = 'active') AS has_playbook
         FROM meta_account_groups g
         LEFT JOIN LATERAL (SELECT channel_key FROM tracked_channels t WHERE t.group_id = g.id AND t.channel_key IS NOT NULL
                             ORDER BY t.channel_key LIMIT 1) anchor ON true
         LEFT JOIN editor_channels ec ON ec.channel_key = anchor.channel_key
         LEFT JOIN agents a ON a.parent_id IS NULL AND a.kind = 'orchestrator' AND a.scope = 'resource'
                           AND a.scope_id = 'telegram:' || anchor.channel_key
        WHERE g.id = $1`, [groupId]);
    const r = rows[0];
    if (!r) return null;
    const pausedUntil = r.paused_until ? new Date(r.paused_until) : null;
    return {
      mode: NETWORK_MODE_ALIASES[r.mode] ?? r.mode, cardMode: r.card_mode ?? null, orchestratorMode: r.orch_mode ?? null,
      orchestratorPaused: r.orch_status === 'paused' || (!!pausedUntil && pausedUntil.getTime() > Date.now()),
      hasPlaybook: !!r.has_playbook, tz: r.timezone ?? null, pinnedDay: r.pinned_day ?? null, pinned: r.pinned ?? null,
    };
  }

  /**
   * One gate for automatic duplication (spec 024 FR-003), used by
   * EditorCrossPoster and GroupFanOutService. The value is pinned for the
   * anchor's local plan day on first use (the scheduler touches it every tick),
   * so a change of mode, agent mode or playbook takes effect the next plan day
   * and daily caps are not double-counted. Unknown group → true.
   */
  async autoDuplicateActive(groupId: string, now: Date = new Date()): Promise<boolean> {
    const s = await this.autoDuplicateState(groupId);
    if (!s) return true;
    const day = safeLocalDate(now, s.tz);
    if (s.pinnedDay === day && s.pinned != null) return s.pinned;
    const raw = autoDuplicateRaw(s);
    const { rows } = await this.pool.query(
      `UPDATE meta_account_groups SET auto_duplicate_day = $2::date, auto_duplicate = $3
        WHERE id = $1 AND (auto_duplicate_day IS DISTINCT FROM $2::date OR auto_duplicate IS NULL) RETURNING auto_duplicate`,
      [groupId, day, raw]);
    if (rows[0]) return rows[0].auto_duplicate !== false;
    const again = await this.pool.query(`SELECT auto_duplicate FROM meta_account_groups WHERE id = $1`, [groupId]);
    return again.rows[0]?.auto_duplicate ?? raw;
  }

  /** The gate of a channel's network; a channel outside any group always duplicates (its own crosspost targets). */
  async autoDuplicateActiveForChannel(channelKey: string, now: Date = new Date()): Promise<boolean> {
    const g = await this.groupOfChannel(channelKey);
    return g ? this.autoDuplicateActive(g.id, now) : true;
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
