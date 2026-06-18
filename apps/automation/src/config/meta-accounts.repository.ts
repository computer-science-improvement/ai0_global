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
  // Encrypted token at rest (enc:v1:...). When non-null it is the source of
  // truth and takes precedence over token_env; null → legacy env-var path.
  token_enc:         string | null;
  target_id:         string;
  username:          string | null;
  display_name:      string | null;
  followers:         number | null;
  picture_url:       string | null;
  active:            boolean;
  last_verified_at:  Date | null;
  verify_error:      string | null;
  created_at:        Date;
  // Group of related accounts (same brand's FB/IG/Threads) for publish fan-out.
  group_id:          string | null;
  landing_visible:   boolean;
  landing_order:     number;
  // Derived from Graph debug_token on Verify — the token value is NEVER stored.
  token_type:                   string | null;
  token_expires_at:             Date | null;
  token_data_access_expires_at: Date | null;
  token_scopes:                 string[] | null;
  token_valid:                  boolean | null;
  token_checked_at:             Date | null;
}

export interface MetaAccountInsertInput {
  platform:   MetaPlatform;
  account_id: string;
  // Legacy env-var NAME — null when a token VALUE (token_enc) is supplied instead.
  token_env:  string | null;
  // Encrypted token blob (enc:v1:...) — set when the operator entered a value.
  token_enc?: string | null;
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
      `INSERT INTO meta_accounts (platform, account_id, token_env, token_enc, target_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.platform, input.account_id, input.token_env, input.token_enc ?? null, input.target_id],
    );
    return rows[0];
  }

  /** Persist (or clear) the encrypted token blob for an account. */
  async setTokenEnc(id: string, tokenEnc: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE meta_accounts SET token_enc = $2 WHERE id = $1`, [id, tokenEnc],
    );
  }

  /** Persist the authoritative target id resolved from the token (Threads
   *  `/me`), self-healing a wrong/stale value so publishing uses the right id. */
  async setTargetId(id: string, targetId: string): Promise<void> {
    await this.pool.query(
      `UPDATE meta_accounts SET target_id = $2::text WHERE id = $1`, [id, targetId],
    );
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

  /** Persist debug_token-derived metadata. The token value is NEVER stored.
   *  token_valid records debug_token's is_valid — captured independently of
   *  Verify, so a live token still reads valid when Verify fails for an
   *  unrelated reason (e.g. wrong target_id). */
  async setTokenMeta(
    id: string,
    info: { type: string | null; expiresAt: Date | null; dataAccessExpiresAt: Date | null; scopes: string[]; isValid: boolean },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE meta_accounts
         SET token_type                   = $2,
             token_expires_at             = $3,
             token_data_access_expires_at = $4,
             token_scopes                 = $5,
             token_valid                  = $6,
             token_checked_at             = now()
       WHERE id = $1`,
      [id, info.type, info.expiresAt, info.dataAccessExpiresAt, info.scopes, info.isValid],
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

  /** Assign (or clear) the account's group. The partial unique index enforces at
   *  most one account per platform per group, so a clashing assignment errors. */
  async setGroup(id: string, groupId: string | null): Promise<void> {
    await this.pool.query(`UPDATE meta_accounts SET group_id = $2 WHERE id = $1`, [id, groupId]);
  }

  /** All ACTIVE Meta accounts in a group (any platform). Empty for a missing
   *  or empty group. Drives group fan-out target resolution. */
  async findActiveByGroup(groupId: string): Promise<MetaAccountRow[]> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT * FROM meta_accounts WHERE group_id = $1 AND active ORDER BY platform`,
      [groupId],
    );
    return rows;
  }

  /** Active accounts in the SAME group as `id`, excluding `id` itself. Empty
   *  when the account is ungrouped or has no active siblings. Drives the
   *  Facebook → Instagram + Threads publish fan-out. */
  async findActiveGroupSiblings(id: string): Promise<MetaAccountRow[]> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT s.* FROM meta_accounts s
         JOIN meta_accounts a ON a.id = $1
        WHERE s.active
          AND s.group_id IS NOT NULL
          AND s.group_id = a.group_id
          AND s.id <> a.id
        ORDER BY s.platform`,
      [id],
    );
    return rows;
  }

  async setLanding(id: string, opts: { visible: boolean; order: number }): Promise<void> {
    await this.pool.query(
      `UPDATE meta_accounts SET landing_visible = $2, landing_order = $3 WHERE id = $1`,
      [id, opts.visible, opts.order],
    );
  }

  async listFeatured(): Promise<MetaAccountRow[]> {
    const { rows } = await this.pool.query<MetaAccountRow>(
      `SELECT * FROM meta_accounts WHERE landing_visible AND active ORDER BY landing_order, created_at`,
    );
    return rows;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM meta_accounts WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
