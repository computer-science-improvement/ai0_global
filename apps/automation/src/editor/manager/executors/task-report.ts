import type { Pool } from 'pg';
import { telegramKeyOf, type Agent } from '../../agents/agent.types';

/**
 * `report_directive_done` for a `task` (spec 025 FR-015): the row the orchestrator names must exist, belong to
 * it and be created after the directive was delivered. A skill counts when it was created or changed since.
 */
export const TASK_REF_TYPES = ['idea', 'slot', 'playbook', 'skill'] as const;
export type TaskRefType = typeof TASK_REF_TYPES[number];

export type TaskRefResult = { ok: true; at: Date } | { error: 'ref_not_found' | 'ref_not_yours' | 'ref_too_old'; details: string };

export function taskRefCheck(pool: Pick<Pool, 'query'>) {
  return async (type: TaskRefType, id: string, orch: Agent, since: Date): Promise<TaskRefResult> => {
    const anchor = telegramKeyOf(orch);
    // The comparison runs in SQL: timestamps keep their microseconds there (a JS Date would round both to ms).
    const q = {
      idea:     `SELECT agent_id::text AS owner, created_at AS at, created_at > $2 AS fresh FROM content_ideas WHERE id = $1`,
      slot:     `SELECT channel_key AS owner, created_at AS at, created_at > $2 AS fresh FROM editor_slots WHERE id = $1`,
      playbook: `SELECT agent_id::text AS owner, created_at AS at, created_at > $2 AS fresh FROM playbooks WHERE id = $1`,
      skill:    `SELECT agent_id::text AS owner, updated_at AS at, updated_at > $2 AS fresh FROM skills WHERE id = $1`,
    }[type];
    const { rows } = await pool.query(q, [id, since]);
    if (!rows[0]) return { error: 'ref_not_found', details: `${type} ${id} не знайдено` };
    const mine = type === 'slot' ? !!anchor && rows[0].owner === anchor : rows[0].owner === orch.id;
    if (!mine) return { error: 'ref_not_yours', details: `${type} ${id} не належить @${orch.handle}` };
    if (!rows[0].fresh) return { error: 'ref_too_old', details: `${type} ${id} створено до того, як директиву доставили (${since.toISOString().slice(0, 16)})` };
    return { ok: true, at: new Date(rows[0].at) };
  };
}
