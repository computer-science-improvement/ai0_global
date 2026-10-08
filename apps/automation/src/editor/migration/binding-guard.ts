import { ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Strategy bindings seen from the agents' side (spec 023 FR-011/FR-012): the resource a binding publishes to,
 * and the live guard — no resource may go `live` while an enabled binding still publishes to it.
 */

type Q = Pick<Pool, 'query'>;

/** SQL: the resource ref of a binding row `b` (joined to tracked_channels `tc`). */
export const BINDING_REF_SQL = `CASE b.platform
    WHEN 'telegram' THEN 'telegram:' || tc.channel_key
    WHEN 'tiktok'   THEN 'tiktok:' || b.tiktok_account_id::text
    ELSE b.platform || ':' || b.meta_account_id::text
  END`;

export interface BindingRow {
  id:             string;
  ext_id:         string;
  type:           string;
  schedule:       string;
  params:         Record<string, unknown>;
  enabled:        boolean;
  platform:       string;
  resourceRef:    string | null;
  retiredAt:      Date | null;
  retiredReason:  string | null;
  migratedTo:     { agent_id?: string; playbook_id?: string | null; series?: string[] } | null;
  notes:          string | null;
}

const toRow = (r: any): BindingRow => ({
  id: r.id, ext_id: r.ext_id, type: r.type, schedule: r.schedule, params: r.params ?? {}, enabled: !!r.enabled, platform: r.platform,
  resourceRef: r.resource_ref ?? null, retiredAt: r.retired_at ?? null, retiredReason: r.retired_reason ?? null,
  migratedTo: r.migrated_to ?? null, notes: r.notes ?? null,
});

/** Bindings that publish to any of `refs` (all of them, or only the enabled ones). */
export async function bindingsFor(pool: Q, refs: string[], o: { enabledOnly?: boolean } = {}): Promise<BindingRow[]> {
  if (!refs.length) return [];
  const res = await pool.query(
    `SELECT * FROM (
       SELECT b.id, b.ext_id, b.type, b.schedule, b.params, b.enabled, b.platform, b.notes,
              b.retired_at, b.retired_reason, b.migrated_to, ${BINDING_REF_SQL} AS resource_ref
         FROM strategy_bindings b LEFT JOIN tracked_channels tc ON tc.id = b.channel_id
     ) x
     WHERE x.resource_ref = ANY($1::text[]) AND ($2::boolean IS FALSE OR x.enabled)
     ORDER BY x.ext_id`,
    [refs, !!o.enabledOnly]);
  return (res?.rows ?? []).map(toRow);
}

/** Every binding with its resource ref (status page). */
export async function allBindings(pool: Q): Promise<BindingRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id, b.ext_id, b.type, b.schedule, b.params, b.enabled, b.platform, b.notes,
            b.retired_at, b.retired_reason, b.migrated_to, ${BINDING_REF_SQL} AS resource_ref
       FROM strategy_bindings b LEFT JOIN tracked_channels tc ON tc.id = b.channel_id
      ORDER BY b.ext_id`);
  return rows.map(toRow);
}

/** ext_ids of the enabled bindings that still publish to any of `refs`. */
export async function enabledBindingExtIds(pool: Q, refs: string[]): Promise<string[]> {
  return (await bindingsFor(pool, refs, { enabledOnly: true })).map((b) => b.ext_id);
}

/** The 409 of FR-012: a resource cannot go live while strategies still publish to it. */
export function bindingsStillEnabled(extIds: string[]): ConflictException {
  return new ConflictException({
    error: 'bindings_still_enabled',
    details: `strategy bindings still publish here: ${extIds.join(', ')} — migrate them (cutover) or pause them on /app/strategies first`,
    ext_ids: extIds,
  });
}

/** Throws `409 bindings_still_enabled` when an enabled binding targets one of `refs`. */
export async function assertNoEnabledBindings(pool: Q, refs: string[]): Promise<void> {
  const ext = await enabledBindingExtIds(pool, refs);
  if (ext.length) throw bindingsStillEnabled(ext);
}

/** The resources an agent's live switch covers: its own resource, or every resource of its network group. */
export async function liveRefsOf(pool: Q, agent: { scope: string; scopeId: string | null }): Promise<string[]> {
  if (!agent.scopeId) return [];
  if (agent.scope === 'resource') {
    const refs = [agent.scopeId];
    // A Telegram anchor runs its whole account group (spec 020): the group's resources go live with it.
    if (agent.scopeId.startsWith('telegram:')) {
      const { rows } = await pool.query(
        `SELECT 'telegram:' || channel_key AS ref FROM tracked_channels WHERE group_id = (SELECT group_id FROM tracked_channels WHERE channel_key = $1) AND channel_key IS NOT NULL AND group_id IS NOT NULL
         UNION SELECT platform || ':' || id FROM meta_accounts WHERE group_id = (SELECT group_id FROM tracked_channels WHERE channel_key = $1) AND group_id IS NOT NULL
         UNION SELECT 'tiktok:' || id FROM tiktok_accounts WHERE group_id = (SELECT group_id FROM tracked_channels WHERE channel_key = $1) AND group_id IS NOT NULL`,
        [agent.scopeId.slice('telegram:'.length)]).catch(() => ({ rows: [] as any[] }));
      for (const r of rows) if (!refs.includes(r.ref)) refs.push(r.ref);
    }
    return refs;
  }
  if (agent.scope === 'network') {
    const { rows } = await pool.query(
      `SELECT 'telegram:' || channel_key AS ref FROM tracked_channels WHERE group_id = $1 AND channel_key IS NOT NULL
       UNION SELECT platform || ':' || id FROM meta_accounts WHERE group_id = $1
       UNION SELECT 'tiktok:' || id FROM tiktok_accounts WHERE group_id = $1`, [agent.scopeId]).catch(() => ({ rows: [] as any[] }));
    return rows.map((r) => String(r.ref));
  }
  return [];
}
