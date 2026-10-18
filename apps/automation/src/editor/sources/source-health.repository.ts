import type { Pool } from 'pg';
import { SOURCE_TOOLS, type HostBlockRow, type SourceStep } from './source-health';

/** Spec 049 FR-003: the run-trace and blocked-host rows the source health is computed from. */
export class SourceHealthRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /** Source-reading tool steps of the channel's runs since `since`, oldest first, with the slot each run served. */
  async steps(channelKey: string, since: Date): Promise<SourceStep[]> {
    const { rows } = await this.pool.query(
      `SELECT st.created_at AS at, st.tool_name AS tool, st.input, st.is_error,
              st.output->>'error' AS error, left(st.output->>'details', 300) AS details,
              CASE WHEN jsonb_typeof(st.output->'items') = 'array' THEN jsonb_array_length(st.output->'items')
                   WHEN jsonb_typeof(st.output->'rows') = 'array' THEN jsonb_array_length(st.output->'rows') END AS items,
              r.slot_id, s.status AS slot_status
         FROM editor_runs r
         JOIN editor_run_steps st ON st.run_id = r.id
         LEFT JOIN editor_slots s ON s.id = r.slot_id
        WHERE r.channel_key = $1 AND r.started_at >= $2 AND st.type = 'tool' AND st.tool_name = ANY($3)
        ORDER BY st.created_at`,
      [channelKey, since, [...SOURCE_TOOLS]]);
    return rows.map((r: any) => ({
      at: new Date(r.at), tool: r.tool, input: r.input && typeof r.input === 'object' ? r.input : null,
      isError: r.is_error === true, error: r.error ?? null, details: r.details ?? null,
      items: r.items === null || r.items === undefined ? null : Number(r.items),
      slotId: r.slot_id ?? null, slotStatus: r.slot_status ?? null,
    }));
  }

  /** Blocked-host rows for these hosts / feed addresses (active or ended within the window). */
  async blocks(keys: string[], since: Date): Promise<HostBlockRow[]> {
    if (!keys.length) return [];
    try {
      const { rows } = await this.pool.query(
        `SELECT host, reason, status_code, blocked_until, failures FROM source_host_failures WHERE host = ANY($1) AND blocked_until >= $2`,
        [keys, since]);
      return rows.map((r: any) => ({ host: r.host, reason: r.reason, statusCode: r.status_code ?? null, until: new Date(r.blocked_until), failures: Number(r.failures ?? 1) }));
    } catch {
      return []; // before migration 079
    }
  }
}
