import type { Pool } from 'pg';
import type { Agent } from './agent.types';
import { telegramKeysOfScope } from './scope-kpi';

/** A slot the probe re-writes with the old and the new skill text. */
export interface ProbeSlotRef {
  slotId:     string;
  channelKey: string;
  topic:      string;
  format:     string;
}

/**
 * What a skill is about, read from its name: `format-<x>` matters to slots of that format, `platform-<p>` to slots of that
 * platform. Slots that match come first; the rest follow (a skill about everything gets the newest posts).
 */
export function skillRelevance(name: string): { format: string | null; platform: string | null } {
  const f = /^format-(.+)$/.exec(name);
  const p = /^platform-(.+)$/.exec(name);
  return { format: f ? f[1].replace(/-/g, '_') : null, platform: p ? p[1] : null };
}

/**
 * Spec 059 step 1: the most recent published or approved content slots of the agent's scope that the probe can re-run
 * (a fixed topic, written fresh — not a live slot, a duplicate / adapt or a promo). `[]` = nothing to probe on.
 */
export async function pickProbeSlots(
  pool: Pick<Pool, 'query'>, agent: Pick<Agent, 'scope' | 'scopeId'>, skillName: string, limit: number, now = new Date(),
): Promise<ProbeSlotRef[]> {
  const keys = await telegramKeysOfScope(pool, agent);
  const refs = agent.scope === 'resource' && agent.scopeId ? [agent.scopeId] : [];
  if (!keys.length && !refs.length) return [];
  const rel = skillRelevance(skillName);
  const { rows } = await pool.query(
    `SELECT s.id, s.channel_key, s.topic, s.format
       FROM editor_slots s
      WHERE s.kind = 'content' AND s.status IN ('published', 'approved')
        AND s.topic_mode IS DISTINCT FROM 'live' AND COALESCE(s.treatment, 'unique') = 'unique' AND s.promo IS NULL
        AND s.scheduled_at <= $5 AND (s.channel_key = ANY($1::text[]) OR s.resource_ref = ANY($2::text[]))
      ORDER BY (CASE WHEN ($3::text IS NOT NULL AND replace(s.format, '-', '_') = $3)
                       OR ($4::text IS NOT NULL AND COALESCE(split_part(s.resource_ref, ':', 1), 'telegram') = $4) THEN 0 ELSE 1 END),
               s.scheduled_at DESC
      LIMIT $6`,
    [keys, refs, rel.format, rel.platform, now, limit]);
  return rows.map((r) => ({ slotId: r.id, channelKey: r.channel_key, topic: r.topic, format: r.format }));
}
