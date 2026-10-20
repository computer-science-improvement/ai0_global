import type { Pool } from 'pg';
import { KYIV_DAY_START_SQL } from '../../common/ai/usage/llm-budget.service';
import { RUN_ERROR_STATUSES } from './unit-state';

/**
 * Spec 056 FR-001: the batched queries behind the map snapshot. Each answers for all agents / resources at once
 * (the page polls every 5 s, so there is never a query per agent). A missing table or column (an older database)
 * answers an empty result. Post text is never selected: a slot is named by its topic only.
 */

type Q = Pick<Pool, 'query'>;

/** The ref a slot publishes on: its resource, else the anchor Telegram channel. */
const REF = `COALESCE(s.resource_ref, 'telegram:' || s.channel_key)`;
const ERROR_STATUSES_SQL = RUN_ERROR_STATUSES.map((s) => `'${s}'`).join(', ');

const iso = (v: unknown): Date | null => (v ? new Date(v as string) : null);

async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err: any) {
    if (err?.code === '42P01' || err?.code === '42703') return fallback; // an older database
    throw err;
  }
}

export interface RunningRun { agentId: string; role: string; startedAt: Date; topic: string | null }
export interface LastRun { agentId: string; role: string; status: string; error: string | null; finishedAt: Date | null }
export interface SlotFacts {
  ref: string;
  awaiting: number; awaitingSince: Date | null; postsToday: number;
  runningAt: Date | null; runningTopic: string | null;
  dueAt: Date | null; dueTopic: string | null;
  failedAt: Date | null; failedError: string | null;
}
export interface LevelRow { ref: string; clean: number; pass: number; rejected: number }
export interface RawEvent { id: string; at: Date; kind: string; agentId?: string | null; ref?: string | null; toRef?: string | null; topic?: string | null; extra?: string | null }
export interface RawRoad { from: string; to: string; kind: 'promo' | 'repost' | 'duplicate'; count: number; lastAt: Date | null }
export interface DirectiveWait { handle: string; count: number }
export interface LaunchWait { id: string; channelKey: string; targetRef: string; status: string; handle: string | null; since: Date }
export interface HealthRow { ref: string; state: string; detail: string | null; muted: boolean }

export class MapQueries {
  constructor(private readonly pool: Q) {}

  /** Networks: the group and the Telegram channel at its centre (the anchor). */
  networks() {
    return safe([] as Array<{ id: string; name: string; anchorRef: string | null }>, async () => {
      const { rows } = await this.pool.query(
        `SELECT g.id::text, g.name,
                (SELECT 'telegram:' || t.channel_key FROM tracked_channels t WHERE t.group_id = g.id AND t.channel_key IS NOT NULL
                  ORDER BY t.is_mine DESC, t.channel_key LIMIT 1) AS anchor
           FROM meta_account_groups g ORDER BY g.name, g.id`);
      return rows.map((r) => ({ id: r.id as string, name: r.name as string, anchorRef: (r.anchor as string | null) ?? null }));
    });
  }

  /** The card mode of every channel (what runs and publishing follow). */
  channelModes() {
    return safe(new Map<string, string>(), async () => {
      const { rows } = await this.pool.query(`SELECT channel_key, mode FROM editor_channels`);
      return new Map(rows.map((r) => [`telegram:${r.channel_key}`, r.mode as string]));
    });
  }

  /** Each agent's run in progress (started within 30 minutes), with the slot topic it works on. */
  runningRuns() {
    return safe([] as RunningRun[], async () => {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT ON (r.agent_id) r.agent_id::text AS agent_id, r.role, r.started_at, s.topic
           FROM editor_runs r LEFT JOIN editor_slots s ON s.id = r.slot_id
          WHERE r.status = 'running' AND r.started_at > now() - interval '30 minutes' AND r.agent_id IS NOT NULL
          ORDER BY r.agent_id, r.started_at DESC`);
      return rows.map((r) => ({ agentId: r.agent_id, role: r.role, startedAt: new Date(r.started_at), topic: r.topic ?? null }));
    });
  }

  /** Each agent's newest run that finished within the last 2 hours. */
  lastRuns() {
    return safe([] as LastRun[], async () => {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT ON (agent_id) agent_id::text AS agent_id, role, status, error, finished_at
           FROM editor_runs
          WHERE agent_id IS NOT NULL AND status <> 'running' AND finished_at > now() - interval '2 hours'
          ORDER BY agent_id, finished_at DESC`);
      return rows.map((r) => ({ agentId: r.agent_id, role: r.role, status: r.status, error: r.error ?? null, finishedAt: iso(r.finished_at) }));
    });
  }

  /** Slot facts per resource: waiting, published today, running, due soon, failed in the last 2 hours. */
  slotFacts() {
    return safe([] as SlotFacts[], async () => {
      const { rows } = await this.pool.query(
        `SELECT ${REF} AS ref,
                count(*) FILTER (WHERE s.status = 'awaiting_approval')::int AS awaiting,
                min(s.updated_at) FILTER (WHERE s.status = 'awaiting_approval') AS awaiting_since,
                count(*) FILTER (WHERE s.status = 'published' AND s.updated_at >= ${KYIV_DAY_START_SQL})::int AS posts_today,
                max(s.updated_at) FILTER (WHERE s.status = 'running') AS running_at,
                (array_agg(s.topic ORDER BY s.updated_at DESC) FILTER (WHERE s.status = 'running'))[1] AS running_topic,
                min(s.scheduled_at) FILTER (WHERE s.status = 'approved' AND s.scheduled_at <= now() + interval '10 minutes') AS due_at,
                (array_agg(s.topic ORDER BY s.scheduled_at) FILTER (WHERE s.status = 'approved' AND s.scheduled_at <= now() + interval '10 minutes'))[1] AS due_topic,
                max(s.updated_at) FILTER (WHERE s.status = 'failed' AND s.updated_at > now() - interval '2 hours') AS failed_at,
                (array_agg(s.error ORDER BY s.updated_at DESC) FILTER (WHERE s.status = 'failed' AND s.updated_at > now() - interval '2 hours'))[1] AS failed_error
           FROM editor_slots s
          WHERE s.status IN ('awaiting_approval', 'running', 'approved') OR s.updated_at > now() - interval '30 hours'
          GROUP BY 1`);
      return rows.map((r) => ({
        ref: r.ref, awaiting: Number(r.awaiting), awaitingSince: iso(r.awaiting_since), postsToday: Number(r.posts_today),
        runningAt: iso(r.running_at), runningTopic: r.running_topic ?? null, dueAt: iso(r.due_at), dueTopic: r.due_topic ?? null,
        failedAt: iso(r.failed_at), failedError: r.failed_error ?? null,
      }));
    });
  }

  /** Per resource, 30 days: clean approvals, critic passes on published posts, owner rejections. */
  levelRows() {
    return safe([] as LevelRow[], async () => {
      const { rows } = await this.pool.query(
        `SELECT ${REF} AS ref,
                count(*) FILTER (WHERE s.approved_at > now() - interval '30 days' AND NOT s.owner_edited)::int AS clean,
                count(*) FILTER (WHERE s.status = 'published' AND s.critic->>'verdict' = 'pass')::int AS pass,
                count(*) FILTER (WHERE s.status = 'skipped' AND s.error = 'rejected by owner')::int AS rejected
           FROM editor_slots s
          WHERE s.updated_at > now() - interval '30 days'
          GROUP BY 1`);
      return rows.map((r) => ({ ref: r.ref, clean: Number(r.clean), pass: Number(r.pass), rejected: Number(r.rejected) }));
    });
  }

  /** Failed runs of the last 30 days per agent. */
  failedRuns() {
    return safe(new Map<string, number>(), async () => {
      const { rows } = await this.pool.query(
        `SELECT agent_id::text AS agent_id, count(*)::int AS n FROM editor_runs
          WHERE agent_id IS NOT NULL AND started_at > now() - interval '30 days' AND status IN (${ERROR_STATUSES_SQL})
          GROUP BY agent_id`);
      return new Map(rows.map((r) => [r.agent_id as string, Number(r.n)]));
    });
  }

  /** The health the checks stored per resource (resource_profiles). */
  resourceHealth() {
    return safe([] as HealthRow[], async () => {
      const { rows } = await this.pool.query(
        `SELECT resource_ref, resource_health->>'state' AS state, resource_health->>'detail' AS detail,
                (resource_health->>'dismissedAt') IS NOT NULL AS muted
           FROM resource_profiles WHERE resource_health IS NOT NULL`);
      return rows.map((r) => ({ ref: r.resource_ref, state: r.state ?? 'unknown', detail: r.detail ?? null, muted: !!r.muted }));
    });
  }

  /** Roads: cross-promo pairs, reposts and derived duplicates of the last 30 days. */
  roads() {
    return safe([] as RawRoad[], async () => {
      const out: RawRoad[] = [];
      const pairs = await this.pool.query(
        `SELECT source_ref, target_ref, count_30d, last_promo_at FROM promo_pairs WHERE count_30d > 0 AND last_promo_at > now() - interval '30 days'`);
      for (const r of pairs.rows) out.push({ from: r.source_ref, to: r.target_ref, kind: 'promo', count: Number(r.count_30d), lastAt: iso(r.last_promo_at) });
      const reposts = await this.pool.query(
        `SELECT s.promo->>'source_ref' AS source_ref, s.promo->>'target_ref' AS target_ref, count(*)::int AS n, max(s.updated_at) AS last_at
           FROM editor_slots s
          WHERE s.status = 'published' AND s.promo->>'kind' = 'repost' AND s.updated_at > now() - interval '30 days'
            AND s.promo->>'source_ref' IS NOT NULL AND s.promo->>'target_ref' IS NOT NULL
          GROUP BY 1, 2`);
      for (const r of reposts.rows) out.push({ from: r.source_ref, to: r.target_ref, kind: 'repost', count: Number(r.n), lastAt: iso(r.last_at) });
      const derived = await this.pool.query(
        `SELECT COALESCE(p.resource_ref, 'telegram:' || p.channel_key) AS from_ref, ${REF} AS to_ref, s.treatment, count(*)::int AS n, max(s.updated_at) AS last_at
           FROM editor_slots s JOIN editor_slots p ON p.id = s.derived_from_slot_id
          WHERE s.status = 'published' AND s.treatment IN ('duplicate', 'adapt') AND s.updated_at > now() - interval '30 days'
          GROUP BY 1, 2, 3`);
      for (const r of derived.rows) {
        if (r.from_ref === r.to_ref) continue;
        out.push({ from: r.from_ref, to: r.to_ref, kind: r.treatment === 'duplicate' ? 'duplicate' : 'repost', count: Number(r.n), lastAt: iso(r.last_at) });
      }
      return out;
    });
  }

  /** Subscribers that joined through tracked links in 30 days, per (source, target). */
  joins() {
    return safe(new Map<string, number>(), async () => {
      const { rows } = await this.pool.query(
        `SELECT l.source_ref, l.target_ref, COALESCE(sum(j.count), 0)::int AS n
           FROM tracked_links l JOIN link_joins j ON j.link_id = l.id
          WHERE j.joined_at > now() - interval '30 days'
          GROUP BY 1, 2`);
      return new Map(rows.map((r) => [`${r.source_ref}>${r.target_ref}`, Number(r.n)]));
    });
  }

  /** Directives that wait for the owner, per receiving agent. */
  directivesWaiting() {
    return safe([] as DirectiveWait[], async () => {
      const { rows } = await this.pool.query(
        `SELECT a.handle, count(*)::int AS n FROM agent_directives d JOIN agents a ON a.id = d.to_agent_id
          WHERE d.status IN ('awaiting_owner', 'contested') GROUP BY a.handle ORDER BY a.handle`);
      return rows.map((r) => ({ handle: r.handle as string, count: Number(r.n) }));
    });
  }

  /** Launches that wait for the owner: a ready plan, or a running one that proposed graduation. */
  launchesWaiting() {
    return safe([] as LaunchWait[], async () => {
      const { rows } = await this.pool.query(
        `SELECT l.id::text, l.channel_key, l.target_ref, l.status, l.updated_at, a.handle
           FROM channel_launches l LEFT JOIN agents a ON a.id = l.agent_id
          WHERE l.status = 'ready' OR (l.status = 'running' AND l.graduation->>'proposedAt' IS NOT NULL AND l.graduation->>'decidedAt' IS NULL)
          ORDER BY l.updated_at`);
      return rows.map((r) => ({ id: r.id, channelKey: r.channel_key, targetRef: r.target_ref, status: r.status, handle: r.handle ?? null, since: new Date(r.updated_at) }));
    });
  }

  // ── events of the last 24 hours (each source: the 30 newest) ─────────────────────────────────────────────

  runEvents() {
    return safe([] as RawEvent[], async () => {
      const { rows } = await this.pool.query(
        `SELECT r.id::text, r.agent_id::text AS agent_id, r.role, r.status, r.started_at, r.finished_at, r.channel_key, s.topic
           FROM editor_runs r LEFT JOIN editor_slots s ON s.id = r.slot_id
          WHERE r.started_at > now() - interval '24 hours'
          ORDER BY COALESCE(r.finished_at, r.started_at) DESC LIMIT 30`);
      const out: RawEvent[] = [];
      for (const r of rows) {
        const ref = r.channel_key ? `telegram:${r.channel_key}` : null;
        const base = { agentId: r.agent_id ?? null, ref, topic: r.topic ?? null, extra: r.role as string };
        if (r.status === 'running') out.push({ ...base, id: `run:${r.id}:start`, at: new Date(r.started_at), kind: 'run_started' });
        else if (r.status === 'ok') out.push({ ...base, id: `run:${r.id}:end`, at: new Date(r.finished_at ?? r.started_at), kind: 'run_finished' });
        else if ((RUN_ERROR_STATUSES as readonly string[]).includes(r.status)) {
          out.push({ ...base, id: `run:${r.id}:end`, at: new Date(r.finished_at ?? r.started_at), kind: 'run_failed', extra: `${r.role}|${r.status}` });
        }
      }
      return out;
    });
  }

  slotEvents() {
    return safe([] as RawEvent[], async () => {
      const { rows } = await this.pool.query(
        `SELECT s.id::text, s.status, s.topic, s.updated_at, s.approved_at, s.error, s.promo, ${REF} AS ref
           FROM editor_slots s
          WHERE (s.status = 'published' AND s.updated_at > now() - interval '24 hours')
             OR (s.status = 'failed' AND s.updated_at > now() - interval '24 hours')
             OR (s.status = 'skipped' AND s.error = 'rejected by owner' AND s.updated_at > now() - interval '24 hours')
             OR s.approved_at > now() - interval '24 hours'
          ORDER BY GREATEST(s.updated_at, COALESCE(s.approved_at, s.updated_at)) DESC LIMIT 90`);
      const out: RawEvent[] = [];
      for (const r of rows) {
        const base = { ref: r.ref as string, topic: r.topic as string };
        if (r.approved_at && Date.now() - new Date(r.approved_at).getTime() < 24 * 3_600_000) {
          out.push({ ...base, id: `slot:${r.id}:approved`, at: new Date(r.approved_at), kind: 'post_approved' });
        }
        if (r.status === 'published') {
          const p = r.promo as { source_ref?: string; target_ref?: string; kind?: string } | null;
          if (p?.source_ref && p?.target_ref) {
            out.push({ id: `slot:${r.id}:promo`, at: new Date(r.updated_at), kind: 'promo', ref: p.source_ref, toRef: p.target_ref, extra: p.kind ?? 'cross_promo' });
          } else out.push({ ...base, id: `slot:${r.id}:published`, at: new Date(r.updated_at), kind: 'post_published' });
        } else if (r.status === 'failed') {
          out.push({ ...base, id: `slot:${r.id}:failed`, at: new Date(r.updated_at), kind: 'post_failed', extra: r.error ?? null });
        } else if (r.status === 'skipped') {
          out.push({ ...base, id: `slot:${r.id}:rejected`, at: new Date(r.updated_at), kind: 'post_rejected' });
        }
      }
      return out;
    });
  }

  directiveEvents() {
    return safe([] as RawEvent[], async () => {
      const { rows } = await this.pool.query(
        `SELECT d.id::text, d.kind, d.created_at, d.to_agent_id::text AS agent_id FROM agent_directives d
          WHERE d.created_at > now() - interval '24 hours' ORDER BY d.created_at DESC LIMIT 30`);
      return rows.map((r): RawEvent => ({ id: `dir:${r.id}`, at: new Date(r.created_at), kind: 'directive', agentId: r.agent_id, extra: r.kind }));
    });
  }

  launchEvents() {
    return safe([] as RawEvent[], async () => {
      const { rows } = await this.pool.query(
        `SELECT l.id::text, l.channel_key, l.target_ref, l.started_at, l.graduated_at, l.agent_id::text AS agent_id FROM channel_launches l
          WHERE l.started_at > now() - interval '24 hours' OR l.graduated_at > now() - interval '24 hours'
          ORDER BY COALESCE(l.graduated_at, l.started_at) DESC LIMIT 30`);
      const out: RawEvent[] = [];
      for (const r of rows) {
        if (r.started_at && Date.now() - new Date(r.started_at).getTime() < 24 * 3_600_000) {
          out.push({ id: `launch:${r.id}:start`, at: new Date(r.started_at), kind: 'launch_started', agentId: r.agent_id ?? null, ref: r.target_ref, extra: r.channel_key });
        }
        if (r.graduated_at) out.push({ id: `launch:${r.id}:live`, at: new Date(r.graduated_at), kind: 'launch_graduated', agentId: r.agent_id ?? null, ref: r.target_ref, extra: r.channel_key });
      }
      return out;
    });
  }
}
