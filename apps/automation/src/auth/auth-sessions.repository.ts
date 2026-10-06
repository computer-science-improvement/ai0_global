import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';

export type SessionMethod = 'token' | 'telegram' | 'link';

export interface AuthSessionRow {
  id:            string;
  method:        SessionMethod;
  subjectId:     number;
  firstName:     string | null;
  username:      string | null;
  ip:            string | null;
  userAgent:     string | null;
  createdAt:     Date;
  lastSeenAt:    Date;
  revokedAt:     Date | null;
  revokedReason: string | null;
}

export interface NewSession {
  method:    SessionMethod;
  subjectId: number;
  firstName: string | null;
  username:  string | null;
  ip:        string | null;
  userAgent: string | null;
}

/** Lifetimes the SQL-side filters need (the service owns the defaults). */
export interface SessionWindows { idleDays: number; absoluteDays: number }

const COLS = `id, method, subject_id, first_name, username, host(ip) AS ip, user_agent,
              created_at, last_seen_at, revoked_at, revoked_reason`;

function toRow(r: any): AuthSessionRow {
  return {
    id: r.id, method: r.method, subjectId: Number(r.subject_id),
    firstName: r.first_name, username: r.username, ip: r.ip, userAgent: r.user_agent,
    createdAt: new Date(r.created_at), lastSeenAt: new Date(r.last_seen_at),
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null, revokedReason: r.revoked_reason,
  };
}

/** `auth_sessions` (migration 055) — one row per dashboard login; never holds a token. */
@Injectable()
export class AuthSessionsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(s: NewSession): Promise<AuthSessionRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO auth_sessions (method, subject_id, first_name, username, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [s.method, s.subjectId, s.firstName, s.username, s.ip, s.userAgent],
    );
    return toRow(rows[0]);
  }

  async findById(id: string): Promise<AuthSessionRow | null> {
    const { rows } = await this.pool.query(`SELECT ${COLS} FROM auth_sessions WHERE id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, at]);
  }

  /** Revoke one live session; false when it was already revoked or does not exist. */
  async revoke(id: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Revoke every live session except `exceptId` (null = all); returns the revoked ids. */
  async revokeAll(exceptId: string | null, reason: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
        WHERE revoked_at IS NULL AND ($1::uuid IS NULL OR id <> $1::uuid)
        RETURNING id`,
      [exceptId, reason],
    );
    return rows.map((r) => r.id);
  }

  /** Sessions that are neither revoked nor past the idle window or the absolute cap, most recent first. */
  async listLive(w: SessionWindows): Promise<AuthSessionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLS} FROM auth_sessions
        WHERE revoked_at IS NULL
          AND last_seen_at > now() - ($1::float8 * interval '1 day')
          AND created_at   > now() - ($2::float8 * interval '1 day')
        ORDER BY last_seen_at DESC`,
      [w.idleDays, w.absoluteDays],
    );
    return rows.map(toRow);
  }

  /** Delete sessions dead (revoked, idle-expired or past the cap) for more than `graceDays`. */
  async purgeDead(w: SessionWindows, graceDays: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM auth_sessions
        WHERE COALESCE(revoked_at, LEAST(last_seen_at + ($1::float8 * interval '1 day'),
                                         created_at   + ($2::float8 * interval '1 day')))
              < now() - ($3::float8 * interval '1 day')`,
      [w.idleDays, w.absoluteDays, graceDays],
    );
    return rowCount ?? 0;
  }
}
