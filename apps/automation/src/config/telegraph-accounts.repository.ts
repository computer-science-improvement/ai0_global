// apps/automation/src/config/telegraph-accounts.repository.ts
//
// DB-managed Telegraph sessions, mirroring MyBotsRepository. A row stores the
// env-var NAME (`token_env`) that holds the real access token — the secret
// never lives in the DB. Verify fills short_name / author_* from
// getAccountInfo. The strategy picks the active account at publish time.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface TelegraphAccountRow {
  id:                string;
  account_id:        string;
  token_env:         string;
  // Encrypted token at rest (enc:v1:...). Non-null wins over token_env; null →
  // legacy env-var path.
  token_enc:         string | null;
  short_name:        string | null;
  author_name:       string | null;
  author_url:        string | null;
  active:            boolean;
  last_verified_at:  Date | null;
  verify_error:      string | null;
  created_at:        Date;
}

export interface TelegraphAccountInsertInput {
  account_id:   string;
  // Legacy env-var NAME — null when a token VALUE (token_enc) is supplied instead.
  token_env:    string | null;
  // Encrypted token blob (enc:v1:...) — set when the operator entered a value.
  token_enc?:   string | null;
  author_name?: string | null;
  author_url?:  string | null;
}

@Injectable()
export class TelegraphAccountsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<TelegraphAccountRow[]> {
    const { rows } = await this.pool.query<TelegraphAccountRow>(
      `SELECT * FROM telegraph_accounts ORDER BY created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<TelegraphAccountRow | null> {
    const { rows } = await this.pool.query<TelegraphAccountRow>(
      `SELECT * FROM telegraph_accounts WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByAccountId(accountId: string): Promise<TelegraphAccountRow | null> {
    const { rows } = await this.pool.query<TelegraphAccountRow>(
      `SELECT * FROM telegraph_accounts WHERE account_id = $1`, [accountId],
    );
    return rows[0] ?? null;
  }

  /** Oldest active account — the default publishing identity. */
  async findActive(): Promise<TelegraphAccountRow | null> {
    const { rows } = await this.pool.query<TelegraphAccountRow>(
      `SELECT * FROM telegraph_accounts WHERE active = true ORDER BY created_at LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async insert(input: TelegraphAccountInsertInput): Promise<TelegraphAccountRow> {
    const { rows } = await this.pool.query<TelegraphAccountRow>(
      `INSERT INTO telegraph_accounts (account_id, token_env, token_enc, author_name, author_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.account_id, input.token_env, input.token_enc ?? null, input.author_name ?? null, input.author_url ?? null],
    );
    return rows[0];
  }

  /** Persist (or clear) the encrypted token blob for a telegraph account. */
  async setTokenEnc(id: string, tokenEnc: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE telegraph_accounts SET token_enc = $2 WHERE id = $1`, [id, tokenEnc],
    );
  }

  async markVerified(
    id: string,
    meta: { short_name: string; author_name: string | null; author_url: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE telegraph_accounts
         SET short_name       = $2::text,
             author_name      = $3::text,
             author_url       = $4::text,
             last_verified_at = now(),
             verify_error     = NULL
       WHERE id = $1`,
      [id, meta.short_name, meta.author_name, meta.author_url],
    );
  }

  async markVerifyError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE telegraph_accounts SET verify_error = $2::text, last_verified_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(`UPDATE telegraph_accounts SET active = $2 WHERE id = $1`, [id, active]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM telegraph_accounts WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}
