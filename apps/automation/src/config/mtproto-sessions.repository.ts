// apps/automation/src/config/mtproto-sessions.repository.ts
//
// Persistence for MTProto (user-account) tracking/stats sessions. The session
// string is the user-account login the tracker/stats clients use to read
// per-post views/reactions. It is stored ENCRYPTED (enc:v1:...) in session_enc
// and is NEVER returned in plaintext from this repo except via
// activeSessionString(), which decrypts the single active row for in-memory use
// by the tracker/stats clients. apiId/apiHash stay in env (app-level/shared).
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { SecretsService } from '../common/crypto/secrets.service';

export interface MtprotoSessionRow {
  id:               string;
  label:            string;
  // Encrypted session string (enc:v1:...). Never exposed by the API.
  session_enc:      string;
  active:           boolean;
  username:         string | null;
  phone:            string | null;
  tg_user_id:       string | null;
  last_verified_at: Date | null;
  verify_error:     string | null;
  created_at:       Date;
}

export interface MtprotoSessionInsertInput {
  label:       string;
  // Already-encrypted blob (enc:v1:...). Callers must encrypt before insert.
  session_enc: string;
}

@Injectable()
export class MtprotoSessionsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<MtprotoSessionRow[]> {
    const { rows } = await this.pool.query<MtprotoSessionRow>(
      `SELECT * FROM mtproto_sessions ORDER BY created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<MtprotoSessionRow | null> {
    const { rows } = await this.pool.query<MtprotoSessionRow>(
      `SELECT * FROM mtproto_sessions WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async insert(input: MtprotoSessionInsertInput): Promise<MtprotoSessionRow> {
    const { rows } = await this.pool.query<MtprotoSessionRow>(
      `INSERT INTO mtproto_sessions (label, session_enc)
       VALUES ($1, $2)
       RETURNING *`,
      [input.label, input.session_enc],
    );
    return rows[0];
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM mtproto_sessions WHERE id = $1`, [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE mtproto_sessions SET active = $2 WHERE id = $1`, [id, active],
    );
  }

  /** Record the verified display identity (getMe) and clear any prior error. */
  async markVerified(
    id: string,
    meta: { username: string | null; phone: string | null; tgUserId: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE mtproto_sessions
         SET username         = $2::text,
             phone            = $3::text,
             tg_user_id       = $4::text,
             last_verified_at = now(),
             verify_error     = NULL
       WHERE id = $1`,
      [id, meta.username, meta.phone, meta.tgUserId],
    );
  }

  async markVerifyError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE mtproto_sessions SET verify_error = $2::text, last_verified_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  /**
   * The session string the tracker/stats clients should use, or null when no
   * active DB session exists (callers then fall back to .env). Picks the first
   * `active` row and decrypts it via SecretsService for in-memory use only.
   * The plaintext is never persisted or logged.
   */
  async activeSessionString(secrets: SecretsService): Promise<string | null> {
    const { rows } = await this.pool.query<MtprotoSessionRow>(
      `SELECT * FROM mtproto_sessions WHERE active ORDER BY created_at LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return secrets.maybeDecrypt(row.session_enc);
  }
}
