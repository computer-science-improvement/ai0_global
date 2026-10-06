import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';

export type AuthEventKind =
  | 'login_ok' | 'login_failed' | 'rate_limited' | 'locked_out'
  | 'logout' | 'revoked' | 'revoke_all' | 'expired';

export interface AuthEventInput {
  kind:       AuthEventKind;
  method?:    string | null;
  /** Error / reason code (`bad_token`, `session_revoked`, …) — never a secret. */
  code?:      string | null;
  subjectId?: number | null;
  sessionId?: string | null;
  ip?:        string | null;
  userAgent?: string | null;
}

export interface AuthEventRow {
  id:        number;
  at:        Date;
  kind:      AuthEventKind;
  method:    string | null;
  code:      string | null;
  subjectId: number | null;
  sessionId: string | null;
  ip:        string | null;
  userAgent: string | null;
}

function toRow(r: any): AuthEventRow {
  return {
    id: Number(r.id), at: new Date(r.at), kind: r.kind, method: r.method, code: r.code,
    subjectId: r.subject_id === null ? null : Number(r.subject_id), sessionId: r.session_id,
    ip: r.ip, userAgent: r.user_agent,
  };
}

/**
 * `auth_events` (migration 055) — the auth audit log: every login attempt,
 * logout, revoke and lockout. Holds no token, token prefix or widget hash.
 */
@Injectable()
export class AuthEventsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async record(e: AuthEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_events (kind, method, code, subject_id, session_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.kind, e.method ?? null, e.code ?? null, e.subjectId ?? null, e.sessionId ?? null, e.ip ?? null, e.userAgent ?? null],
    );
  }

  async recent(limit: number): Promise<AuthEventRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, at, kind, method, code, subject_id, session_id, host(ip) AS ip, user_agent
         FROM auth_events ORDER BY at DESC, id DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toRow);
  }

  /** IP + UA of successful logins in the last `days`, excluding one session (the login being checked). */
  async recentLogins(days: number, excludeSessionId: string | null): Promise<{ ip: string | null; userAgent: string | null }[]> {
    const { rows } = await this.pool.query(
      `SELECT host(ip) AS ip, user_agent FROM auth_events
        WHERE kind = 'login_ok' AND at > now() - ($1::float8 * interval '1 day')
          AND ($2::uuid IS NULL OR session_id IS DISTINCT FROM $2::uuid)`,
      [days, excludeSessionId],
    );
    return rows.map((r) => ({ ip: r.ip, userAgent: r.user_agent }));
  }

  async purgeOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM auth_events WHERE at < now() - ($1::float8 * interval '1 day')`,
      [days],
    );
    return rowCount ?? 0;
  }
}
