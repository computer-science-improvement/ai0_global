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
    const toRow = (r: any): HostBlockRow => ({
      host: r.host, reason: r.reason, statusCode: r.status_code ?? null, until: new Date(r.blocked_until),
      failures: Number(r.failures ?? 1), strikes: Number(r.strikes ?? 0),
    });
    try {
      const { rows } = await this.pool.query(
        `SELECT host, reason, status_code, blocked_until, failures, strikes FROM source_host_failures WHERE host = ANY($1) AND blocked_until >= $2`,
        [keys, since]);
      return rows.map(toRow);
    } catch {
      return []; // before migration 094 (`strikes`)
    }
  }

  /** Hosts struck `min` times in a row that the owner was not told about yet (spec 061 FR-004). */
  async struck(keys: string[], min: number): Promise<Array<HostBlockRow & { notedAt: Date | null }>> {
    if (!keys.length) return [];
    try {
      const { rows } = await this.pool.query(
        `SELECT host, reason, status_code, blocked_until, failures, strikes, noted_at FROM source_host_failures
          WHERE host = ANY($1) AND strikes >= $2 AND noted_at IS NULL AND position('/' in host) = 0`, [keys, min]);
      return rows.map((r: any) => ({ host: r.host, reason: r.reason, statusCode: r.status_code ?? null, until: new Date(r.blocked_until),
        failures: Number(r.failures ?? 1), strikes: Number(r.strikes ?? 0), notedAt: r.noted_at ? new Date(r.noted_at) : null }));
    } catch {
      return [];
    }
  }

  /** Claims the owner note of a host: true for the one caller that got it (the note is written once per streak). */
  async claimNote(host: string): Promise<boolean> {
    const { rows } = await this.pool.query(`UPDATE source_host_failures SET noted_at = now() WHERE host = $1 AND noted_at IS NULL RETURNING host`, [host]);
    return rows.length > 0;
  }

  /** The active playbook of the orchestrator that owns this channel's resource (null without one). */
  async playbookOf(resourceRef: string): Promise<unknown | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT p.body FROM playbooks p JOIN agents a ON a.id = p.agent_id
          WHERE a.kind = 'orchestrator' AND a.scope = 'resource' AND a.scope_id = $1 AND p.status = 'active' LIMIT 1`, [resourceRef]);
      return rows[0]?.body ?? null;
    } catch {
      return null;
    }
  }
}
