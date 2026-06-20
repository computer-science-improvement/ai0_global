import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { SecretsService } from '../common/crypto/secrets.service';
import type { TikTokTokenSet } from './tiktok-token.util';

export interface TikTokAccountRow {
  id:                        string;
  open_id:                   string;
  union_id:                  string | null;
  username:                  string | null;
  display_name:              string | null;
  avatar_url:                string | null;
  access_token:              string;
  refresh_token:             string;
  access_token_expires_at:   Date;
  refresh_token_expires_at:  Date;
  scope:                     string | null;
  active:                    boolean;
  last_refreshed_at:         Date | null;
  refresh_error:             string | null;
  created_at:                Date;
  landing_visible:           boolean;
  landing_order:             number;
}

export interface TikTokUpsertInput extends TikTokTokenSet {
  openId: string;
  scope:  string | null;
}

@Injectable()
export class TikTokAccountsRepository {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly secrets: SecretsService,
  ) {}

  /**
   * Decrypt the at-rest token columns so callers always see plaintext (the
   * contract is unchanged). `maybeDecrypt` passes legacy plaintext rows through
   * untouched, so this is safe for rows written before encryption was enabled.
   */
  private decode<T extends Partial<TikTokAccountRow>>(row: T): T {
    if (!row) return row;
    return {
      ...row,
      ...(typeof row.access_token === 'string'  ? { access_token:  this.secrets.maybeDecrypt(row.access_token) }  : {}),
      ...(typeof row.refresh_token === 'string' ? { refresh_token: this.secrets.maybeDecrypt(row.refresh_token) } : {}),
    };
  }

  async list(): Promise<TikTokAccountRow[]> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts ORDER BY created_at`,
    );
    return rows.map(r => this.decode(r));
  }

  async findById(id: string): Promise<TikTokAccountRow | null> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts WHERE id = $1`, [id],
    );
    return rows[0] ? this.decode(rows[0]) : null;
  }

  async findByOpenId(openId: string): Promise<TikTokAccountRow | null> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts WHERE open_id = $1`, [openId],
    );
    return rows[0] ? this.decode(rows[0]) : null;
  }

  /** Insert or, on open_id conflict, re-auth an existing account. Clears errors, re-activates. */
  async upsertFromTokens(input: TikTokUpsertInput): Promise<TikTokAccountRow> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `INSERT INTO tiktok_accounts
         (open_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope, last_refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (open_id) DO UPDATE SET
         access_token             = EXCLUDED.access_token,
         refresh_token            = EXCLUDED.refresh_token,
         access_token_expires_at  = EXCLUDED.access_token_expires_at,
         refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         scope                    = EXCLUDED.scope,
         active                   = true,
         refresh_error            = NULL,
         last_refreshed_at        = now()
       RETURNING *`,
      [input.openId,
       this.secrets.encryptIfConfigured(input.accessToken),
       this.secrets.encryptIfConfigured(input.refreshToken),
       input.accessTokenExpiresAt, input.refreshTokenExpiresAt, input.scope],
    );
    return this.decode(rows[0]);
  }

  /** Persist rotated tokens after a successful refresh. */
  async updateTokens(id: string, t: TikTokTokenSet): Promise<void> {
    await this.pool.query(
      `UPDATE tiktok_accounts SET
         access_token             = $2,
         refresh_token            = $3,
         access_token_expires_at  = $4,
         refresh_token_expires_at = $5,
         refresh_error            = NULL,
         last_refreshed_at        = now()
       WHERE id = $1`,
      [id,
       this.secrets.encryptIfConfigured(t.accessToken),
       this.secrets.encryptIfConfigured(t.refreshToken),
       t.accessTokenExpiresAt, t.refreshTokenExpiresAt],
    );
  }

  async setRefreshError(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE tiktok_accounts SET refresh_error = $2::text WHERE id = $1`, [id, message],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(`UPDATE tiktok_accounts SET active = $2 WHERE id = $1`, [id, active]);
  }

  async setLanding(id: string, opts: { visible: boolean; order: number }): Promise<void> {
    await this.pool.query(
      `UPDATE tiktok_accounts SET landing_visible = $2, landing_order = $3 WHERE id = $1`,
      [id, opts.visible, opts.order],
    );
  }

  async listFeatured(): Promise<TikTokAccountRow[]> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts WHERE landing_visible AND active ORDER BY landing_order, created_at`,
    );
    return rows.map(r => this.decode(r));
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM tiktok_accounts WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
