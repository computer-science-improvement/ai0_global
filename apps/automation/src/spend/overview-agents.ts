import type { Pool } from 'pg';
import { KYIV_DAY_START_SQL } from '../common/ai/usage/llm-budget.service';

export const AGENT_MODES = ['off', 'shadow', 'approve', 'live'] as const;
export type AgentMode = typeof AGENT_MODES[number];

/** Start of the Kyiv day 6 days ago: the 7-day window including today. */
const KYIV_7D_START_SQL = `((date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') - interval '6 days') AT TIME ZONE 'Europe/Kyiv')`;

export interface AgentsOverview {
  generatedAt: string;
  agents: { total: number; byMode: Record<AgentMode, number>; paused: number };
  runs: {
    today: number; d7: number;
    ok7d: number; finished7d: number; disabled7d: number; errors7d: number; budgetExceeded7d: number;
    /** ok / (finished − disabled) over 7 days; null without finished runs. */
    successRate7d: number | null;
  };
  posts: {
    today: { published: number; shadowed: number };
    d7:    { published: number; shadowed: number };
    awaitingApproval: number;
  };
  directives: { open: number; awaitingOwner: number; applied30d: number; worked30d: number };
}

const n = (v: unknown) => Number(v ?? 0);

/** Success rate per FR-009: ok / (finished − disabled); null when nothing counts. */
export function successRate(ok: number, finished: number, disabled: number): number | null {
  const base = finished - disabled;
  return base > 0 ? Math.round((ok / base) * 1000) / 10 : null;
}

/**
 * Agent activity for the Overview "Agents" card (spec 029 FR-009): root agents by
 * mode (off / shadow / approve / live, spec 031) and paused, editor runs today and
 * over 7 Kyiv days, posts published vs shadowed vs waiting for approval, and the
 * MANAGER's directives. Posts count editor slots plus platform posts written
 * outside a slot, so a platform post that follows its slot is not counted twice.
 */
export class OverviewAgentsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async load(now: Date = new Date()): Promise<AgentsOverview> {
    const [agents, runs, slots, plat, waiting, directives] = await Promise.all([
      this.pool.query(
        `SELECT mode, (status = 'paused' OR (paused_until IS NOT NULL AND paused_until > now())) AS paused, COUNT(*)::int AS n
           FROM agents WHERE parent_id IS NULL GROUP BY 1, 2`),
      this.pool.query(
        `SELECT (COUNT(*) FILTER (WHERE started_at >= ${KYIV_DAY_START_SQL}))::int AS today,
                COUNT(*)::int AS d7,
                (COUNT(*) FILTER (WHERE status = 'ok'))::int AS ok,
                (COUNT(*) FILTER (WHERE status <> 'running'))::int AS finished,
                (COUNT(*) FILTER (WHERE status = 'disabled'))::int AS disabled,
                (COUNT(*) FILTER (WHERE status IN ('error', 'max_steps')))::int AS errors,
                (COUNT(*) FILTER (WHERE status = 'budget_exceeded'))::int AS budget
           FROM editor_runs WHERE started_at >= ${KYIV_7D_START_SQL}`),
      this.pool.query(
        `SELECT status, (COUNT(*) FILTER (WHERE scheduled_at >= ${KYIV_DAY_START_SQL}))::int AS today, COUNT(*)::int AS d7
           FROM editor_slots
          WHERE status IN ('published', 'shadowed') AND scheduled_at >= ${KYIV_7D_START_SQL} AND scheduled_at <= now() + interval '1 day'
          GROUP BY 1`),
      this.pool.query(
        `SELECT status, (COUNT(*) FILTER (WHERE posted_at >= ${KYIV_DAY_START_SQL}))::int AS today, COUNT(*)::int AS d7
           FROM platform_posts
          WHERE slot_id IS NULL AND status IN ('published', 'shadowed') AND posted_at >= ${KYIV_7D_START_SQL}
          GROUP BY 1`),
      this.pool.query(
        `SELECT (SELECT COUNT(*) FROM editor_slots WHERE status = 'awaiting_approval')::int
              + (SELECT COUNT(*) FROM platform_posts WHERE status = 'awaiting_approval' AND slot_id IS NULL)::int AS n`),
      this.pool.query(
        `SELECT (COUNT(*) FILTER (WHERE status IN ('new', 'awaiting_owner', 'contested', 'accepted')))::int AS open,
                (COUNT(*) FILTER (WHERE status IN ('awaiting_owner', 'contested')))::int AS awaiting,
                (COUNT(*) FILTER (WHERE applied_at >= now() - interval '30 days'))::int AS applied,
                (COUNT(*) FILTER (WHERE outcome = 'worked' AND updated_at >= now() - interval '30 days'))::int AS worked
           FROM agent_directives WHERE NOT shadow`),
    ]);

    const byMode = Object.fromEntries(AGENT_MODES.map((m) => [m, 0])) as Record<AgentMode, number>;
    let total = 0;
    let paused = 0;
    for (const r of agents.rows) {
      total += n(r.n);
      if (r.paused) paused += n(r.n);
      if ((AGENT_MODES as readonly string[]).includes(r.mode)) byMode[r.mode as AgentMode] += n(r.n);
    }
    const ru = runs.rows[0] ?? {};
    const posts = { today: { published: 0, shadowed: 0 }, d7: { published: 0, shadowed: 0 } };
    for (const r of [...slots.rows, ...plat.rows]) {
      const k = r.status as 'published' | 'shadowed';
      posts.today[k] += n(r.today);
      posts.d7[k] += n(r.d7);
    }
    const d = directives.rows[0] ?? {};
    return {
      generatedAt: now.toISOString(),
      agents: { total, byMode, paused },
      runs: {
        today: n(ru.today), d7: n(ru.d7), ok7d: n(ru.ok), finished7d: n(ru.finished), disabled7d: n(ru.disabled),
        errors7d: n(ru.errors), budgetExceeded7d: n(ru.budget), successRate7d: successRate(n(ru.ok), n(ru.finished), n(ru.disabled)),
      },
      posts: { ...posts, awaitingApproval: n(waiting.rows[0]?.n) },
      directives: { open: n(d.open), awaitingOwner: n(d.awaiting), applied30d: n(d.applied), worked30d: n(d.worked) },
    };
  }
}
