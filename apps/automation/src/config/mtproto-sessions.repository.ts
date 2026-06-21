// apps/automation/src/config/mtproto-sessions.repository.ts
//
// Persistence for MTProto (user-account) tracking/stats sessions. The session
// string is the user-account login the tracker/stats clients use to read
// per-post views/reactions. It is stored ENCRYPTED (enc:v1:...) in session_enc
// and is NEVER returned in plaintext from this repo except via activeSession(),
// which decrypts the single active row for in-memory use by the tracker/stats
// clients. Each row also carries its own Telegram app credentials: api_id
// (plaintext, not secret) and api_hash_enc (ENCRYPTED). Both are optional —
// a row without them falls back to the env TELEGRAM_API_ID / TELEGRAM_API_HASH.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { SecretsService } from '../common/crypto/secrets.service';

export interface MtprotoSessionRow {
  id:               string;
  label:            string;
  // Encrypted session string (enc:v1:...). Never exposed by the API.
  session_enc:      string;
  // Per-session Telegram app credentials. api_id is plaintext (not a secret);
  // api_hash_enc is encrypted (enc:v1:...) and never exposed. Both NULLable —
  // a row without them falls back to the env app credentials.
  api_id:           string | null;
  api_hash_enc:     string | null;
  active:           boolean;
  role:             'tracker' | 'agent';
  username:         string | null;
  phone:            string | null;
  tg_user_id:       string | null;
  last_verified_at: Date | null;
  verify_error:     string | null;
  created_at:       Date;
}

export interface MtprotoSessionInsertInput {
  label:        string;
  // Already-encrypted blob (enc:v1:...). Callers must encrypt before insert.
  session_enc:  string;
  // Optional per-session app credentials. api_id is plaintext; api_hash_enc is
  // an already-encrypted blob (callers encrypt before insert). Null → env fallback.
  api_id?:      string | null;
  api_hash_enc?: string | null;
}

/** The active session resolved for in-memory use by the tracker/stats clients:
 *  the decrypted session string plus its own app credentials (when set). Callers
 *  fall back to the env TELEGRAM_API_ID / TELEGRAM_API_HASH when apiId/apiHash
 *  are null. */
export interface ActiveMtprotoSession {
  session: string;
  apiId:   number | null;
  apiHash: string | null;
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
      `INSERT INTO mtproto_sessions (label, session_enc, api_id, api_hash_enc)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.label, input.session_enc, input.api_id ?? null, input.api_hash_enc ?? null],
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
   * The active session the tracker/stats clients should use, or null when no
   * active DB session exists (callers then fall back to .env entirely). Picks
   * the first `active` row matching `role` and decrypts the session string AND
   * its api_hash via SecretsService for in-memory use only — never persisted or
   * logged. api_id and api_hash are null when the row carries no own credentials,
   * in which case the caller uses the env app credentials.
   *
   * `role` defaults to 'tracker' so all existing callers remain correct.
   */
  async activeSession(
    secrets: SecretsService,
    role: 'tracker' | 'agent' = 'tracker',
  ): Promise<ActiveMtprotoSession | null> {
    const { rows } = await this.pool.query<MtprotoSessionRow>(
      `SELECT * FROM mtproto_sessions WHERE active AND role = $1 ORDER BY created_at LIMIT 1`,
      [role],
    );
    const row = rows[0];
    if (!row) return null;
    const apiId = row.api_id ? parseInt(row.api_id, 10) : NaN;
    return {
      session: secrets.maybeDecrypt(row.session_enc),
      apiId:   Number.isFinite(apiId) ? apiId : null,
      apiHash: row.api_hash_enc ? secrets.maybeDecrypt(row.api_hash_enc) : null,
    };
  }

  /** Back-compat shim: the decrypted active session string only (no creds). */
  async activeSessionString(
    secrets: SecretsService,
    role: 'tracker' | 'agent' = 'tracker',
  ): Promise<string | null> {
    return (await this.activeSession(secrets, role))?.session ?? null;
  }
}
