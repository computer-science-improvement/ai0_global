import type { Pool } from 'pg';
import { rowToSlot, type EditorSlot } from '../../editor/repo/editor-plans.repository';

/**
 * Read queries of the connector's tools (spec 103 §7): plain SQL over the tables the dashboard reads, no writes, no LLM.
 * Everything a row carries as free text (titles, errors, notes) is untrusted: the tools cut it and name it in
 * `untrusted_fields`.
 */

export const OPEN_STATUSES = ['planned', 'running', 'awaiting_approval', 'approved'] as const;
export const CLOSED_STATUSES = ['published', 'shadowed', 'skipped', 'failed', 'expired'] as const;

export interface ScheduleRow {
  id:            string;
  channelKey:    string;
  scheduledAt:   Date;
  status:        string;
  kind:          'content' | 'reserved';
  format:        string;
  topic:         string;
  /** The written post's title, when there is one. */
  title:         string | null;
  createdVia:    string | null;
  lockedBy:      string | null;
  resourceRef:   string | null;
  scheduleRuleId: string | null;
  promo:         boolean;
  slo:           boolean;
  hints:         string[];
  /** The channel's card mode (null without a card). */
  mode:          string | null;
  /** A legacy scheduled_publications row (the old composer path). */
  legacy:        boolean;
}

export interface ScheduleQuery { channel: string | null; from: Date; to: Date; includeClosed: boolean; limit: number }

export interface SlotDetail {
  slot:      EditorSlot;
  planDate:  string | null;
  runs:      Array<{ id: string; role: string; status: string; costUsd: number; startedAt: Date }>;
  published: { messageId: number; postedAt: Date } | null;
}

export interface ClosedGroup { channelKey: string; status: string; error: string | null; n: number; last: Date }
export interface InboxRow { id: number; severity: string; kind: string; title: string; refType: string | null; refId: string | null; createdAt: Date }
export interface ApprovalRow { id: string; channelKey: string; status: string; scheduledAt: Date; topic: string }
export interface PauseRow { kind: 'series' | 'resource'; channelKey: string | null; label: string; reason: string; since: Date }
export interface ReadinessRow { channelKey: string; blockers: Array<{ code: string; detail: string; severity: string }> }

export interface LogQuery { channel: string | null; since: Date; until: Date; level: 'info' | 'warn' | 'error' | null; kinds: string[] | null; limit: number }
export interface LogRow { at: Date; level: 'info' | 'warn' | 'error'; kind: string; channelKey: string | null; title: string; ref: string | null }

export interface RecentPost { messageId: number; title: string | null; postedAt: Date; strategyType: string | null; format: string | null; sourceUrl: string | null }

export interface ChannelFacts { nextPostAt: Date | null; approvalsWaiting: number }

/** What the read tools use; a fake in unit tests, `PgConnectorQueries` in production. */
export interface ConnectorQueries {
  schedule(q: ScheduleQuery): Promise<{ rows: ScheduleRow[]; truncated: boolean }>;
  slotDetail(id: string): Promise<SlotDetail | null>;
  channelFacts(keys: string[], now: Date): Promise<Record<string, ChannelFacts>>;
  /** Next open posts of a channel, soonest first. */
  upcoming(channel: string, now: Date, limit: number): Promise<ScheduleRow[]>;
  closedGroups(channel: string | null, since: Date): Promise<ClosedGroup[]>;
  inbox(channel: string | null, limit: number): Promise<InboxRow[]>;
  approvals(channel: string | null, now: Date): Promise<ApprovalRow[]>;
  pauses(channel: string | null): Promise<PauseRow[]>;
  readiness(channel: string | null): Promise<ReadinessRow[]>;
  logs(q: LogQuery): Promise<LogRow[]>;
  recentPosts(channel: string, limit: number): Promise<RecentPost[]>;
}

const scheduleRow = (r: any): ScheduleRow => ({
  id: r.id, channelKey: r.channel_key, scheduledAt: new Date(r.scheduled_at), status: r.status, kind: r.kind, format: r.format,
  topic: r.topic, title: r.title ?? null, createdVia: r.created_via ?? null, lockedBy: r.locked_by ?? null, resourceRef: r.resource_ref ?? null,
  scheduleRuleId: r.schedule_rule_id ?? null, promo: !!r.has_promo, slo: !!r.has_slo, hints: Array.isArray(r.source_hints) ? r.source_hints.map(String) : [],
  mode: r.mode ?? null, legacy: !!r.legacy,
});

const SLOT_COLS = `s.id, s.channel_key, s.scheduled_at, s.status, s.kind, s.format, s.topic, s.post_spec->>'title' AS title, s.created_via, s.locked_by,
       s.resource_ref, s.schedule_rule_id, (s.promo IS NOT NULL) AS has_promo, (s.slo IS NOT NULL) AS has_slo, s.source_hints, c.mode, false AS legacy`;

export class PgConnectorQueries implements ConnectorQueries {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async schedule(q: ScheduleQuery) {
    const statuses = q.includeClosed ? [...OPEN_STATUSES, ...CLOSED_STATUSES] : [...OPEN_STATUSES];
    const { rows } = await this.pool.query(
      `SELECT ${SLOT_COLS}
         FROM editor_slots s LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
        WHERE s.scheduled_at >= $1 AND s.scheduled_at < $2 AND ($3::text IS NULL OR s.channel_key = $3) AND s.status = ANY($4::text[])
        ORDER BY s.scheduled_at LIMIT $5`,
      [q.from, q.to, q.channel, statuses, q.limit + 1]);
    const out = rows.map(scheduleRow);
    // The old composer's one-off posts (scheduled_publications) are in the same list: the editor never reads them.
    const legacyStatuses = q.includeClosed ? ['pending', 'sending', 'sent', 'failed', 'canceled'] : ['pending', 'sending'];
    try {
      const { rows: legacy } = await this.pool.query(
        `SELECT 'legacy:' || p.id::text AS id, COALESCE(t.channel_key, t.username, '?') AS channel_key, p.scheduled_at,
                CASE p.status WHEN 'pending' THEN 'planned' WHEN 'sending' THEN 'running' WHEN 'sent' THEN 'published' ELSE p.status END AS status,
                'reserved' AS kind, p.media_type AS format, left(p.text, 200) AS topic, NULL AS title, NULL AS created_via, NULL AS locked_by,
                NULL AS resource_ref, NULL AS schedule_rule_id, false AS has_promo, false AS has_slo, '[]'::jsonb AS source_hints, NULL AS mode, true AS legacy
           FROM scheduled_publications p JOIN tracked_channels t ON t.id = p.channel_id
          WHERE p.scheduled_at >= $1 AND p.scheduled_at < $2 AND p.status = ANY($3::text[])
            AND ($4::text IS NULL OR t.channel_key = $4 OR t.username = ltrim($4, '@'))
          ORDER BY p.scheduled_at LIMIT $5`,
        [q.from, q.to, legacyStatuses, q.channel, q.limit + 1]);
      out.push(...legacy.map(scheduleRow));
    } catch { /* an install without the legacy table or columns shows the editor's list only */ }
    out.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    return { rows: out.slice(0, q.limit), truncated: out.length > q.limit };
  }

  async slotDetail(id: string): Promise<SlotDetail | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const { rows } = await this.pool.query(
      `SELECT s.*, p.plan_date::text AS plan_date FROM editor_slots s LEFT JOIN editor_plans p ON p.id = s.plan_id WHERE s.id = $1`, [id]);
    if (!rows[0]) return null;
    const slot = rowToSlot(rows[0]);
    const { rows: runs } = await this.pool.query(
      `SELECT id, role, status, cost_usd, started_at FROM editor_runs WHERE slot_id = $1 ORDER BY started_at DESC LIMIT 10`, [id]);
    let published: SlotDetail['published'] = null;
    if (slot.publishedPostId != null) {
      const { rows: pp } = await this.pool.query(`SELECT message_id, posted_at FROM published_posts WHERE id = $1`, [slot.publishedPostId]);
      if (pp[0]) published = { messageId: Number(pp[0].message_id), postedAt: new Date(pp[0].posted_at) };
    }
    return {
      slot, planDate: rows[0].plan_date ?? null, published,
      runs: runs.map((r) => ({ id: r.id, role: r.role, status: r.status, costUsd: Number(r.cost_usd), startedAt: new Date(r.started_at) })),
    };
  }

  async channelFacts(keys: string[], now: Date): Promise<Record<string, ChannelFacts>> {
    const out: Record<string, ChannelFacts> = Object.fromEntries(keys.map((k) => [k, { nextPostAt: null, approvalsWaiting: 0 }]));
    if (!keys.length) return out;
    const { rows } = await this.pool.query(
      `SELECT channel_key, MIN(scheduled_at) FILTER (WHERE status IN ('planned','approved','awaiting_approval') AND scheduled_at >= $2) AS next_at,
              COUNT(*) FILTER (WHERE status = 'awaiting_approval')::int AS waiting
         FROM editor_slots WHERE channel_key = ANY($1::text[]) AND resource_ref IS NULL AND kind IN ('content', 'reserved') GROUP BY channel_key`,
      [keys, now]);
    for (const r of rows) out[r.channel_key] = { nextPostAt: r.next_at ? new Date(r.next_at) : null, approvalsWaiting: Number(r.waiting) };
    return out;
  }

  async upcoming(channel: string, now: Date, limit: number): Promise<ScheduleRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${SLOT_COLS} FROM editor_slots s LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
        WHERE s.channel_key = $1 AND s.scheduled_at >= $2 AND s.status = ANY($3::text[]) ORDER BY s.scheduled_at LIMIT $4`,
      [channel, now, [...OPEN_STATUSES], limit]);
    return rows.map(scheduleRow);
  }

  async closedGroups(channel: string | null, since: Date): Promise<ClosedGroup[]> {
    const { rows } = await this.pool.query(
      `SELECT channel_key, status, error, COUNT(*)::int AS n, MAX(updated_at) AS last
         FROM editor_slots
        WHERE status IN ('skipped', 'failed', 'expired') AND kind = 'content' AND updated_at >= $1 AND ($2::text IS NULL OR channel_key = $2)
          AND COALESCE(error, '') !~ '^(superseded by a new plan|mode_changed|draft canceled|skipped by owner|skipped by the owner|rescheduled from the chat|canceled from the chat|rejected by owner)'
        GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 40`, [since, channel]);
    return rows.map((r) => ({ channelKey: r.channel_key, status: r.status, error: r.error ?? null, n: Number(r.n), last: new Date(r.last) }));
  }

  async inbox(channel: string | null, limit: number): Promise<InboxRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, severity, kind, title, ref_type, ref_id, created_at FROM agent_inbox
        WHERE read_at IS NULL AND severity IN ('action', 'critical')
          AND ($1::text IS NULL OR ref_id = $1 OR ref_id LIKE $1 || '%' OR title ILIKE '%' || $1 || '%')
        ORDER BY (severity = 'critical') DESC, created_at DESC LIMIT $2`, [channel, limit]);
    return rows.map((r) => ({ id: Number(r.id), severity: r.severity, kind: r.kind, title: r.title, refType: r.ref_type ?? null, refId: r.ref_id ?? null, createdAt: new Date(r.created_at) }));
  }

  async approvals(channel: string | null, now: Date): Promise<ApprovalRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, channel_key, status, scheduled_at, topic FROM editor_slots
        WHERE kind = 'content' AND resource_ref IS NULL AND ($1::text IS NULL OR channel_key = $1)
          AND ((status = 'awaiting_approval' AND scheduled_at < $2::timestamptz + interval '24 hours')
            OR (status = 'expired' AND updated_at >= $2::timestamptz - interval '24 hours'))
        ORDER BY scheduled_at LIMIT 40`, [channel, now]);
    return rows.map((r) => ({ id: r.id, channelKey: r.channel_key, status: r.status, scheduledAt: new Date(r.scheduled_at), topic: r.topic }));
  }

  async pauses(channel: string | null): Promise<PauseRow[]> {
    const out: PauseRow[] = [];
    try {
      const { rows } = await this.pool.query(
        `SELECT channel_key, label, reason, paused_at FROM series_pauses WHERE resumed_at IS NULL AND ($1::text IS NULL OR channel_key = $1) ORDER BY paused_at DESC LIMIT 20`, [channel]);
      for (const r of rows) out.push({ kind: 'series', channelKey: r.channel_key, label: r.label, reason: r.reason, since: new Date(r.paused_at) });
    } catch { /* table missing */ }
    try {
      const { rows } = await this.pool.query(
        `SELECT resource_ref, reason, starts_at FROM resource_pauses
          WHERE lifted_at IS NULL AND until > now() AND ($1::text IS NULL OR resource_ref = $1 OR resource_ref = 'telegram:' || $1) ORDER BY starts_at DESC LIMIT 20`, [channel]);
      for (const r of rows) out.push({ kind: 'resource', channelKey: String(r.resource_ref).replace(/^telegram:/, ''), label: r.resource_ref, reason: r.reason, since: new Date(r.starts_at) });
    } catch { /* table missing */ }
    return out;
  }

  async readiness(channel: string | null): Promise<ReadinessRow[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT channel_key, findings FROM channel_readiness WHERE blockers > 0 AND ($1::text IS NULL OR channel_key = $1) ORDER BY channel_key LIMIT 40`, [channel]);
      return rows.map((r) => ({
        channelKey: r.channel_key,
        blockers: (Array.isArray(r.findings) ? r.findings : []).filter((f: any) => f?.severity === 'error').slice(0, 5)
          .map((f: any) => ({ code: String(f.code ?? ''), detail: String(f.detail ?? ''), severity: 'error' })),
      }));
    } catch { return []; }
  }

  async logs(q: LogQuery): Promise<LogRow[]> {
    const want = (k: string) => !q.kinds || q.kinds.includes(k);
    const parts: string[] = [];
    // $1 since, $2 until, $3 channel
    if (want('run')) {
      parts.push(`SELECT started_at AS at, CASE WHEN status IN ('error','budget_exceeded','max_steps','no_terminal') THEN 'error' WHEN status = 'disabled' THEN 'warn' ELSE 'info' END AS level,
                         'run' AS kind, channel_key, role || ' run: ' || status || COALESCE(' - ' || left(error, 160), '') AS title, id::text AS ref
                    FROM editor_runs WHERE started_at >= $1 AND started_at < $2 AND ($3::text IS NULL OR channel_key = $3)`);
    }
    if (want('slot')) {
      parts.push(`SELECT updated_at AS at, CASE status WHEN 'failed' THEN 'error' WHEN 'skipped' THEN 'warn' WHEN 'expired' THEN 'warn' ELSE 'info' END AS level,
                         'slot' AS kind, channel_key, status || ': ' || left(COALESCE(NULLIF(error, ''), topic), 160) AS title, id::text AS ref
                    FROM editor_slots WHERE updated_at >= $1 AND updated_at < $2 AND status IN ('published','shadowed','skipped','failed','expired','awaiting_approval','approved')
                     AND ($3::text IS NULL OR channel_key = $3)`);
    }
    if (want('publish')) {
      parts.push(`SELECT posted_at AS at, 'info' AS level, 'publish' AS kind, channel_id AS channel_key, 'published: ' || left(COALESCE(title, ''), 160) AS title,
                         channel_id || '/' || message_id::text AS ref
                    FROM published_posts WHERE posted_at >= $1 AND posted_at < $2 AND ($3::text IS NULL OR channel_id = $3)`);
    }
    if (want('inbox')) {
      parts.push(`SELECT created_at AS at, CASE severity WHEN 'critical' THEN 'error' WHEN 'action' THEN 'warn' ELSE 'info' END AS level, 'inbox' AS kind,
                         NULL::text AS channel_key, left(title, 200) AS title, id::text AS ref
                    FROM agent_inbox WHERE created_at >= $1 AND created_at < $2 AND $3::text IS NULL`);
    }
    if (want('decision')) {
      parts.push(`SELECT decided_at AS at, CASE action WHEN 'failed' THEN 'error' ELSE 'info' END AS level, 'decision' AS kind, channel_key,
                         action || ': ' || left(summary, 160) AS title, id::text AS ref
                    FROM autonomy_decisions WHERE decided_at >= $1 AND decided_at < $2 AND ($3::text IS NULL OR channel_key = $3)`);
    }
    if (!parts.length) return [];
    const levelOk = q.level ? `WHERE level = $4` : '';
    const sql = `SELECT * FROM (${parts.join(' UNION ALL ')}) u ${levelOk} ORDER BY at DESC LIMIT ${q.level ? '$5' : '$4'}`;
    const params: unknown[] = [q.since, q.until, q.channel];
    if (q.level) params.push(q.level);
    params.push(q.limit + 1);
    let rows: any[];
    try {
      ({ rows } = await this.pool.query(sql, params));
    } catch {
      // A table of an optional source (decisions) may be missing: retry without it.
      const trimmed = parts.filter((p) => !p.includes('autonomy_decisions'));
      if (trimmed.length === parts.length || !trimmed.length) throw new Error('logs query failed');
      ({ rows } = await this.pool.query(`SELECT * FROM (${trimmed.join(' UNION ALL ')}) u ${levelOk} ORDER BY at DESC LIMIT ${q.level ? '$5' : '$4'}`, params));
    }
    return rows.map((r) => ({ at: new Date(r.at), level: r.level, kind: r.kind, channelKey: r.channel_key ?? null, title: r.title, ref: r.ref ?? null }));
  }

  async recentPosts(channel: string, limit: number): Promise<RecentPost[]> {
    const { rows } = await this.pool.query(
      `SELECT message_id, title, posted_at, strategy_type, format, source_url FROM published_posts WHERE channel_id = $1 ORDER BY posted_at DESC LIMIT $2`, [channel, limit]);
    return rows.map((r) => ({
      messageId: Number(r.message_id), title: r.title ?? null, postedAt: new Date(r.posted_at), strategyType: r.strategy_type ?? null, format: r.format ?? null, sourceUrl: r.source_url ?? null,
    }));
  }
}
