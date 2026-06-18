// apps/automation/src/config/meta-account-groups.repository.ts
//
// Named groups of related Meta accounts (a brand's Facebook + Instagram +
// Threads). A strategy publishing to the group's Facebook account fans the same
// post out to its Instagram + Threads siblings. See migration 033.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface MetaAccountGroupRow {
  id:              string;
  name:            string;
  source_platform: 'facebook' | 'instagram' | 'threads' | 'telegram';
  created_at:      Date;
}

@Injectable()
export class MetaAccountGroupsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<MetaAccountGroupRow[]> {
    const { rows } = await this.pool.query<MetaAccountGroupRow>(
      `SELECT * FROM meta_account_groups ORDER BY name`,
    );
    return rows;
  }

  async findById(id: string): Promise<MetaAccountGroupRow | null> {
    const { rows } = await this.pool.query<MetaAccountGroupRow>(
      `SELECT * FROM meta_account_groups WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByName(name: string): Promise<MetaAccountGroupRow | null> {
    const { rows } = await this.pool.query<MetaAccountGroupRow>(
      `SELECT * FROM meta_account_groups WHERE name = $1`, [name],
    );
    return rows[0] ?? null;
  }

  async create(name: string): Promise<MetaAccountGroupRow> {
    const { rows } = await this.pool.query<MetaAccountGroupRow>(
      `INSERT INTO meta_account_groups (name) VALUES ($1) RETURNING *`, [name],
    );
    return rows[0];
  }

  /** Set which member platform is this group's fan-out source. */
  async setSourcePlatform(
    id: string,
    sourcePlatform: 'facebook' | 'instagram' | 'threads' | 'telegram',
  ): Promise<MetaAccountGroupRow | null> {
    const { rows } = await this.pool.query<MetaAccountGroupRow>(
      `UPDATE meta_account_groups SET source_platform = $2 WHERE id = $1 RETURNING *`,
      [id, sourcePlatform],
    );
    return rows[0] ?? null;
  }

  /** Delete a group. meta_accounts.group_id is ON DELETE SET NULL, so member
   *  accounts are simply un-grouped (never deleted). */
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM meta_account_groups WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
