// apps/automation/src/config/landing-pulse.service.ts
// Spec 026 FR-004: live proof that agents run the network, for the public landing.
//
// One read-only statement (2 s statement timeout) computes every number; the result
// is cached in-process for 300 s. When a refresh fails, the last good value is served
// for up to 1 h after it was computed, then the endpoint answers 503 (the page hides
// the strip). After a failure the next attempt waits 30 s, so a down DB is not hit by
// every visitor.
//
// The payload is aggregate counts only: no ids, handles, names, costs or personal data.
//
// Counting rules (last 7 days unless noted):
//   agentPosts      published_posts.strategy_type = 'editor' (Telegram; approval-mode posts
//                   included, spec 031) + platform_posts published, platform <> 'telegram'
//                   (Telegram rows mirror published_posts), agent_id IS NOT NULL.
//                   Shadowed posts never count.
//   allPosts        every published_posts row (strategies, ads, chat drafts, editor) + every
//                   published non-Telegram platform_posts row.
//   autonomyShare   round(100 * agentPosts / allPosts); 0 with no posts.
//   platforms       per platform with ≥ 1 published post: {platform, posts, agentPosts}.
//   agentRuns       editor_runs status 'ok' with an agent_id.
//   skippedByAgents editor_slots skipped by an agent's own decision ("skipped by agent: …").
//   directivesFiled agent_directives created, excluding shadow ones.
//   managerReviews  manager_reviews with verdict continue or directives (not 'skipped').
//   ideasReviewed   content_ideas reviewed by the idea reviewer (reviewed_by set) and updated.
//   ownerDecisions  owner approvals and declines: directives (owner_decision approved/declined),
//                   playbooks (decided_at), agent_actions (no longer pending).
//   lastAgentPostAt the newest agent post (any time), truncated to the minute.
// Agents: orchestrators count as live in mode live or approve (approve publishes after the
// owner's OK); paused agents count as off. rolesActive lists the role kinds (planner, executor,
// …) with ≥ 1 successful run in the window.
import { ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

export type PulseAgentMode = 'off' | 'shadow' | 'live';
export type PulsePlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';

export interface LandingPulse {
  agents: {
    orchestratorsLive:   number;
    orchestratorsShadow: number;
    /** Role kinds with a successful run in the window, in hierarchy order. */
    rolesActive:         string[];
    manager:             PulseAgentMode;
  };
  last7d: {
    agentPosts:      number;
    allPosts:        number;
    autonomyShare:   number;
    platforms:       Array<{ platform: PulsePlatform; posts: number; agentPosts: number }>;
    agentRuns:       number;
    skippedByAgents: number;
    directivesFiled: number;
    managerReviews:  number;
    ideasReviewed:   number;
    ownerDecisions:  number;
  };
  /** ISO time of the newest agent post, truncated to the minute; null when there is none. */
  lastAgentPostAt: string | null;
  claims: { managerLive: boolean };
  /** When these numbers were computed (ISO, to the second). */
  generatedAt: string;
  /** True when a refresh failed and an older value is served. */
  stale: boolean;
}

/** The raw numbers before gating (what the SQL returns). */
export type PulseNumbers = Omit<LandingPulse, 'claims' | 'generatedAt' | 'stale'>;

const ROLE_ORDER = ['planner', 'ideator', 'idea_reviewer', 'executor', 'reviewer'];
const PLATFORM_ORDER: PulsePlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube'];

/**
 * Claim gating (FR-004/FR-005). The headline "run by AI agents" is not gated (owner
 * decision 2026-10-06); the page hides any proof tile whose number is zero. The only
 * gated claim is that the MANAGER steers the network: it must be live AND have reviewed
 * the network at least once in the window.
 */
export function gateClaims(n: PulseNumbers): LandingPulse['claims'] {
  return { managerLive: n.agents.manager === 'live' && n.last7d.managerReviews > 0 };
}

export function autonomyShare(agentPosts: number, allPosts: number): number {
  if (allPosts <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((100 * agentPosts) / allPosts)));
}

/** agents.mode → the public three-state mode (approve publishes after the owner's OK: live). */
export function publicMode(mode: string | null | undefined, status: string | null | undefined): PulseAgentMode {
  if (!mode || status === 'paused') return 'off';
  if (mode === 'live' || mode === 'approve') return 'live';
  if (mode === 'shadow') return 'shadow';
  return 'off';
}

export const PULSE_SQL = `
WITH w AS (SELECT now() - interval '7 days' AS since),
posts AS (
  SELECT 'telegram'::text AS platform, (p.strategy_type = 'editor') AS by_agent
    FROM published_posts p, w WHERE p.posted_at >= w.since
  UNION ALL
  SELECT pp.platform, (pp.agent_id IS NOT NULL)
    FROM platform_posts pp, w
   WHERE pp.posted_at >= w.since AND pp.status = 'published' AND pp.platform <> 'telegram'
),
per_platform AS (
  SELECT platform, count(*)::int AS posts, (count(*) FILTER (WHERE by_agent))::int AS agent_posts
    FROM posts GROUP BY platform
),
orch AS (
  SELECT
    (count(*) FILTER (WHERE status = 'active' AND mode IN ('live','approve')))::int AS live,
    (count(*) FILTER (WHERE status = 'active' AND mode = 'shadow'))::int            AS shadow
  FROM agents WHERE kind = 'orchestrator' AND parent_id IS NULL
)
SELECT
  (SELECT live FROM orch)   AS orchestrators_live,
  (SELECT shadow FROM orch) AS orchestrators_shadow,
  (SELECT COALESCE(array_agg(DISTINCT a.kind), '{}')
     FROM editor_runs r JOIN agents a ON a.id = r.agent_id, w
    WHERE r.started_at >= w.since AND r.status = 'ok' AND a.parent_id IS NOT NULL) AS roles_active,
  (SELECT mode FROM agents WHERE kind = 'manager' AND parent_id IS NULL ORDER BY created_at LIMIT 1)   AS manager_mode,
  (SELECT status FROM agents WHERE kind = 'manager' AND parent_id IS NULL ORDER BY created_at LIMIT 1) AS manager_status,
  (SELECT COALESCE(sum(agent_posts), 0)::int FROM per_platform) AS agent_posts,
  (SELECT COALESCE(sum(posts), 0)::int FROM per_platform)       AS all_posts,
  (SELECT COALESCE(json_agg(json_build_object('platform', platform, 'posts', posts, 'agentPosts', agent_posts)), '[]'::json)
     FROM per_platform) AS platforms,
  (SELECT count(*)::int FROM editor_runs r, w
    WHERE r.started_at >= w.since AND r.status = 'ok' AND r.agent_id IS NOT NULL) AS agent_runs,
  (SELECT count(*)::int FROM editor_slots s, w
    WHERE s.updated_at >= w.since AND s.status = 'skipped' AND s.error LIKE 'skipped by agent:%') AS skipped_by_agents,
  (SELECT count(*)::int FROM agent_directives d, w WHERE d.created_at >= w.since AND NOT d.shadow) AS directives_filed,
  (SELECT count(*)::int FROM manager_reviews m, w WHERE m.created_at >= w.since AND m.verdict <> 'skipped') AS manager_reviews,
  (SELECT count(*)::int FROM content_ideas i, w WHERE i.updated_at >= w.since AND i.reviewed_by IS NOT NULL) AS ideas_reviewed,
  ( (SELECT count(*) FROM agent_directives d, w
      WHERE d.updated_at >= w.since AND d.owner_decision IN ('approved','declined'))
  + (SELECT count(*) FROM playbooks p, w WHERE p.decided_at >= w.since)
  + (SELECT count(*) FROM agent_actions x, w WHERE x.updated_at >= w.since AND x.status <> 'pending')
  )::int AS owner_decisions,
  date_trunc('minute', GREATEST(
    (SELECT max(posted_at) FROM published_posts WHERE strategy_type = 'editor'),
    (SELECT max(posted_at) FROM platform_posts
      WHERE status = 'published' AND platform <> 'telegram' AND agent_id IS NOT NULL)
  )) AS last_agent_post_at
`;

/** Row (as pg returns it) → the public numbers. Exported for unit tests. */
export function toPulseNumbers(r: Record<string, any>): PulseNumbers {
  const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
  const roles = (Array.isArray(r.roles_active) ? r.roles_active : [])
    .filter((k: unknown): k is string => typeof k === 'string' && ROLE_ORDER.includes(k))
    .sort((a: string, b: string) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
  const platforms = (Array.isArray(r.platforms) ? r.platforms : [])
    .filter((p: any) => p && PLATFORM_ORDER.includes(p.platform))
    .map((p: any) => ({ platform: p.platform as PulsePlatform, posts: int(p.posts), agentPosts: int(p.agentPosts) }))
    .sort((a: { platform: PulsePlatform }, b: { platform: PulsePlatform }) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
  const agentPosts = int(r.agent_posts);
  const allPosts = int(r.all_posts);
  const last = r.last_agent_post_at ? new Date(r.last_agent_post_at) : null;
  return {
    agents: {
      orchestratorsLive:   int(r.orchestrators_live),
      orchestratorsShadow: int(r.orchestrators_shadow),
      rolesActive:         roles,
      manager:             publicMode(r.manager_mode, r.manager_status),
    },
    last7d: {
      agentPosts,
      allPosts,
      autonomyShare:   autonomyShare(agentPosts, allPosts),
      platforms,
      agentRuns:       int(r.agent_runs),
      skippedByAgents: int(r.skipped_by_agents),
      directivesFiled: int(r.directives_filed),
      managerReviews:  int(r.manager_reviews),
      ideasReviewed:   int(r.ideas_reviewed),
      ownerDecisions:  int(r.owner_decisions),
    },
    lastAgentPostAt: last && !Number.isNaN(last.getTime()) ? truncMinute(last).toISOString() : null,
  };
}

function truncMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

export interface LandingPulseOptions {
  ttlMs?:            number;
  staleMaxMs?:       number;
  retryAfterErrorMs?: number;
  statementTimeoutMs?: number;
  now?:              () => number;
  log?:              (msg: string) => void;
}

type PoolLike = Pick<Pool, 'connect'>;

export class LandingPulseService {
  private cache: { at: number; value: Omit<LandingPulse, 'stale'> } | null = null;
  private lastErrorAt: number | null = null;
  private inflight: Promise<Omit<LandingPulse, 'stale'>> | null = null;
  private readonly ttlMs: number;
  private readonly staleMaxMs: number;
  private readonly retryAfterErrorMs: number;
  private readonly statementTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly pool: PoolLike, private readonly opts: LandingPulseOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.staleMaxMs = opts.staleMaxMs ?? 3_600_000;
    this.retryAfterErrorMs = opts.retryAfterErrorMs ?? 30_000;
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  /** Seconds a client may cache the current answer (FR-004: 300). */
  get maxAgeSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }

  async get(): Promise<LandingPulse> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return { ...this.cache.value, stale: false };

    const recentError = this.lastErrorAt !== null && t - this.lastErrorAt < this.retryAfterErrorMs;
    if (!recentError) {
      try {
        const value = await this.refresh();
        return { ...value, stale: false };
      } catch (err: any) {
        this.lastErrorAt = this.now();
        this.opts.log?.(`landing pulse refresh failed: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
    if (this.cache && this.now() - this.cache.at <= this.staleMaxMs) return { ...this.cache.value, stale: true };
    throw new ServiceUnavailableException({ error: 'pulse_unavailable' });
  }

  private refresh(): Promise<Omit<LandingPulse, 'stale'>> {
    // One query at a time, however many visitors arrive while it runs.
    this.inflight ??= this.compute()
      .then((numbers) => {
        const at = this.now();
        const value = { ...numbers, claims: gateClaims(numbers), generatedAt: new Date(Math.floor(at / 1000) * 1000).toISOString() };
        this.cache = { at, value };
        this.lastErrorAt = null;
        return value;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** The numbers from the DB: READ ONLY, statement_timeout, always rolled back. */
  async compute(): Promise<PulseNumbers> {
    const work = (async () => {
      const client: PoolClient = await this.pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${Math.floor(this.statementTimeoutMs)}`);
        const { rows } = await client.query(PULSE_SQL);
        return toPulseNumbers(rows[0] ?? {});
      } finally {
        try { await client.query('ROLLBACK'); } catch { /* a broken connection */ }
        client.release();
      }
    })();
    // A pool that cannot hand out a connection must not hang the request either.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pulse timed out')), this.statementTimeoutMs + 1_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      work.catch(() => undefined);
    }
  }
}
