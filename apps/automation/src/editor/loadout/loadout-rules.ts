import type { Pool } from 'pg';
import type { RulesView } from './loadout-view';

type Q = Pick<Pool, 'query'>;

export const EMPTY_RULES: RulesView = { ownerRules: 0, memory: 0, steeringSets: 0, playbookRules: 0, chars: 0 };

/**
 * What the channel's rules weigh for its agents (spec 054 FR-004, read-only): the owner's rules (memory rows of kind
 * rule / avoid by the owner), the other active memory, the enabled steering rules of the resource's active sets, and the
 * rules of the orchestrator's active playbook. They are per channel and bind every agent on it.
 */
export async function rulesSummary(pool: Q, o: { channelKey: string | null; resourceRef: string | null; orchestratorId: string | null }): Promise<RulesView> {
  if (!o.channelKey && !o.resourceRef && !o.orchestratorId) return { ...EMPTY_RULES };
  const mem = o.channelKey
    ? await pool.query(
      `SELECT (created_by = 'owner' AND kind IN ('rule','avoid')) AS owner_rule, count(*)::int AS n, COALESCE(sum(length(text)), 0)::int AS chars
         FROM editor_channel_memory WHERE channel_key = $1 AND active GROUP BY 1`, [o.channelKey])
    : { rows: [] as any[] };
  const steer = o.resourceRef
    ? await pool.query(
      `SELECT count(DISTINCT s.id)::int AS sets, count(r.v)::int AS n, COALESCE(sum(length(r.v->>'text')), 0)::int AS chars
         FROM steering_sets s
         LEFT JOIN LATERAL jsonb_array_elements(s.rules) AS r(v)
           ON COALESCE((r.v->>'enabled')::boolean, false) AND r.v->>'conflict' IS NULL
        WHERE s.target_ref = $1 AND s.status = 'active'`, [o.resourceRef])
    : { rows: [] as any[] };
  const book = o.orchestratorId
    ? await pool.query(
      `SELECT count(r.v)::int AS n, COALESCE(sum(length(r.v)), 0)::int AS chars
         FROM playbooks p, jsonb_array_elements_text(COALESCE(p.body->'rules', '[]'::jsonb)) AS r(v)
        WHERE p.agent_id = $1 AND p.status = 'active'`, [o.orchestratorId])
    : { rows: [] as any[] };

  const owner = mem.rows.find((r) => r.owner_rule);
  const rest = mem.rows.find((r) => !r.owner_rule);
  const s = steer.rows[0] ?? { sets: 0, n: 0, chars: 0 };
  const b = book.rows[0] ?? { n: 0, chars: 0 };
  return {
    ownerRules: owner?.n ?? 0,
    memory: rest?.n ?? 0,
    steeringSets: s.sets,
    playbookRules: b.n,
    chars: (owner?.chars ?? 0) + (rest?.chars ?? 0) + s.chars + b.chars,
  };
}
