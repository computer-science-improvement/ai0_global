import type { Pool } from 'pg';
import type { ArtifactAuthor, ArtifactVersionMeta, OwnVersionType } from './artifact.types';

/** artifact_versions (084, spec 048 FR-001): versions of setup proposals, steering sets and a channel's owner rules. */
export class ArtifactVersionsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /**
   * Writes `body` as the next version unless it equals the latest one; returns the current version number. A read that
   * sees a body changed elsewhere (the worker, an older endpoint) records it with author `system`.
   */
  async record(type: OwnVersionType, refId: string, body: unknown, author: ArtifactAuthor, meta: { agentId?: string | null; reason?: string | null } = {}): Promise<number> {
    const json = JSON.stringify(body ?? null);
    const { rows } = await this.pool.query(
      `WITH last AS (SELECT version, body FROM artifact_versions WHERE type = $1 AND ref_id = $2 ORDER BY version DESC LIMIT 1)
       INSERT INTO artifact_versions (type, ref_id, version, body, author, agent_id, reason)
       SELECT $1, $2, COALESCE((SELECT version FROM last), 0) + 1, $3::jsonb, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM last WHERE body = $3::jsonb)
       ON CONFLICT (type, ref_id, version) DO NOTHING
       RETURNING version`,
      [type, refId, json, author, meta.agentId ?? null, meta.reason ?? null]);
    if (rows[0]) return Number(rows[0].version);
    return (await this.latest(type, refId)) ?? 1;
  }

  async latest(type: OwnVersionType, refId: string): Promise<number | null> {
    const { rows } = await this.pool.query(`SELECT max(version) AS v FROM artifact_versions WHERE type = $1 AND ref_id = $2`, [type, refId]);
    return rows[0]?.v == null ? null : Number(rows[0].v);
  }

  /** Latest version per id (lists read this; they never write). */
  async latestMany(type: OwnVersionType, refIds: string[]): Promise<Map<string, number>> {
    if (!refIds.length) return new Map();
    const { rows } = await this.pool.query(
      `SELECT ref_id, max(version) AS v FROM artifact_versions WHERE type = $1 AND ref_id = ANY($2::text[]) GROUP BY ref_id`, [type, refIds]);
    return new Map(rows.map((r: any) => [r.ref_id as string, Number(r.v)]));
  }

  async list(type: OwnVersionType, refId: string): Promise<ArtifactVersionMeta[]> {
    const { rows } = await this.pool.query(
      `SELECT v.version, v.author, v.reason, v.created_at, a.handle
         FROM artifact_versions v LEFT JOIN agents a ON a.id = v.agent_id
        WHERE v.type = $1 AND v.ref_id = $2 ORDER BY v.version DESC`, [type, refId]);
    return rows.map((r: any) => ({
      version: Number(r.version), author: r.author === 'agent' && r.handle ? `@${r.handle}` : r.author,
      reason: r.reason ?? null, createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async body(type: OwnVersionType, refId: string, version: number): Promise<unknown | undefined> {
    const { rows } = await this.pool.query(
      `SELECT body FROM artifact_versions WHERE type = $1 AND ref_id = $2 AND version = $3`, [type, refId, version]);
    return rows[0] ? rows[0].body : undefined;
  }
}
