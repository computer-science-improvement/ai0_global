import type { Pool } from 'pg';

export type MemoryKind = 'insight' | 'rule' | 'avoid';

export interface MemoryEntry {
  id:        number;
  kind:      MemoryKind;
  text:      string;
  evidence:  unknown;
  createdBy: 'reviewer' | 'owner';
  createdAt: Date;
}

export interface MemoryRow extends MemoryEntry {
  active: boolean;
}

export class EditorMemoryRepository {
  constructor(private readonly pool: Pool) {}

  async listActive(channelKey: string, limit = 30): Promise<MemoryEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, text, evidence, created_by, created_at FROM editor_channel_memory
        WHERE channel_key = $1 AND active ORDER BY (created_by = 'owner') DESC, created_at DESC LIMIT $2`,
      [channelKey, limit]);
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, text: r.text, evidence: r.evidence, createdBy: r.created_by, createdAt: r.created_at }));
  }

  async add(channelKey: string, kind: MemoryKind, text: string, evidence: unknown, createdBy: 'reviewer' | 'owner'): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO editor_channel_memory (channel_key, kind, text, evidence, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [channelKey, kind, text, evidence == null ? null : JSON.stringify(evidence), createdBy]);
    return Number(rows[0].id);
  }

  /** Reviewer may only retire reviewer-made entries of its own channel. */
  async retireByReviewer(channelKey: string, id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE editor_channel_memory SET active = false WHERE id = $1 AND channel_key = $2 AND created_by = 'reviewer' AND active`,
      [id, channelKey]);
    return (rowCount ?? 0) > 0;
  }

  /** Every entry of the channel (active and retired, including mode-change audit rows), newest first. */
  async listAll(channelKey: string, limit = 200): Promise<MemoryRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, text, evidence, created_by, created_at, active FROM editor_channel_memory
        WHERE channel_key = $1 ORDER BY active DESC, created_at DESC, id DESC LIMIT $2`,
      [channelKey, limit]);
    return rows.map((r) => ({
      id: Number(r.id), kind: r.kind, text: r.text, evidence: r.evidence, createdBy: r.created_by,
      createdAt: r.created_at, active: !!r.active,
    }));
  }

  /** The owner may retire any active entry of the channel (soft delete; the row stays for history). */
  async retireByOwner(channelKey: string, id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE editor_channel_memory SET active = false WHERE id = $1 AND channel_key = $2 AND active`,
      [id, channelKey]);
    return (rowCount ?? 0) > 0;
  }
}
