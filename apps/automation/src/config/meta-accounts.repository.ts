// apps/automation/src/config/meta-accounts.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export type MetaPlatform = 'instagram' | 'facebook' | 'threads';

export interface MetaAccountRow {
  id:                string;
  platform:          MetaPlatform;
  account_id:        string;
  token_env:         string;
  target_id:         string;
  username:          string | null;
  display_name:      string | null;
  followers:         number | null;
  picture_url:       string | null;
  active:            boolean;
  last_verified_at:  Date | null;
  verify_error:      string | null;
  created_at:        Date;
}

export interface MetaAccountInsertInput {
  platform:   MetaPlatform;
  account_id: string;
  token_env:  string;
  target_id:  string;
}

export interface MetaVerifyMeta {
  username:     string | null;
  display_name: string | null;
  followers:    number | null;
  picture_url:  string | null;
}

@Injectable()
export class MetaAccountsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<MetaAccountRow[]> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT * FROM meta_accounts ORDER BY platform, created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<MetaAccountRow | null> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT * FROM meta_accounts WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByPlatformAccount(platform: MetaPlatform, accountId: string): Promise<MetaAccountRow | null> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT * FROM meta_accounts WHERE platform = $1 AND account_id = $2`,
      [platform, accountId],
    );
    return rows[0] ?? null;
  }

  async insert(input: MetaAccountInsertInput): Promise<MetaAccountRow> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `INSERT INTO meta_accounts (platform, account_id, token_env, target_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.platform, input.account_id, input.token_env, input.target_id],
    );
    return rows[0];
  }

  async markVerified(id: string, meta: MetaVerifyMeta): Promise<void> {
    await this.pool.query(
      `UPDATE meta_accounts
         SET username         = $2::text,
             display_name     = $3::text,
             followers        = $4::int,
             picture_url      = $5::text,
             last_verified_at = now(),
             verify_error     = NULL
       WHERE id = $1`,
      [id, meta.username, meta.display_name, meta.followers, meta.picture_url],
    );
  }

  async markVerifyError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE meta_accounts SET verify_error = $2::text, last_verified_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(`UPDATE meta_accounts SET active = $2 WHERE id = $1`, [id, active]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM meta_accounts WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
