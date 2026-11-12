import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';

export const CONNECTOR_AUDIT = 'CONNECTOR_AUDIT';

export type AuditEvent = 'register' | 'consent_allow' | 'consent_deny' | 'token_issued' | 'refresh_reuse' | 'revoked' | 'tool_call';

export interface AuditEntry {
  event:       AuditEvent;
  grantId?:    string | null;
  clientId?:   string | null;
  tool?:       string | null;
  ok?:         boolean | null;
  error?:      string | null;
  durationMs?: number | null;
  /** Never post or message text: ids, channel, time only. */
  summary?:    string | null;
  ip?:         string | null;
}

export interface AuditItem {
  id: number; at: Date; event: string; tool: string | null; clientName: string | null; ok: boolean | null;
  error: string | null; durationMs: number | null; summary: string | null;
}

export interface AuditSink {
  /** Never throws: an audit failure must not break a tool call or a sign-in. */
  record(e: AuditEntry, now?: Date): Promise<void>;
  list(limit: number): Promise<AuditItem[]>;
}

/** Argument keys a summary may carry. Everything else (post text, messages, notes) is dropped. */
const SUMMARY_KEYS = ['channel', 'post_id', 'at', 'chat_id', 'card_id', 'run_id', 'agent', 'day', 'decision'];

/** `channel=@x post_id=… at=…` from a tool's arguments, never its free text. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of SUMMARY_KEYS) {
    const v = a[k];
    if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}=${String(v).replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  return parts.join(' ').slice(0, 300);
}

@Injectable()
export class PgAudit implements AuditSink {
  private readonly log = new Logger('ConnectorAudit');
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async record(e: AuditEntry, now = new Date()): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO mcp_audit (at, event, grant_id, client_id, tool, ok, error, duration_ms, summary, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [now, e.event, e.grantId ?? null, e.clientId ?? null, e.tool ?? null, e.ok ?? null, e.error?.slice(0, 300) ?? null, e.durationMs ?? null, e.summary?.slice(0, 300) ?? null, e.ip ?? null],
      );
    } catch (err) {
      this.log.warn(`audit write failed: ${(err as Error).message}`);
    }
  }

  async list(limit: number): Promise<AuditItem[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.at, a.event, a.tool, a.ok, a.error, a.duration_ms, a.summary, c.name AS client_name
         FROM mcp_audit a LEFT JOIN mcp_oauth_clients c ON c.client_id = a.client_id
        ORDER BY a.at DESC, a.id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id), at: r.at, event: r.event, tool: r.tool, clientName: r.client_name ?? null, ok: r.ok, error: r.error,
      durationMs: r.duration_ms, summary: r.summary,
    }));
  }
}

/** Test double: keeps entries in memory. */
export class MemoryAudit implements AuditSink {
  readonly entries: (AuditEntry & { at: Date })[] = [];
  async record(e: AuditEntry, now = new Date()) { this.entries.push({ ...e, at: now }); }
  async list(limit: number): Promise<AuditItem[]> {
    return this.entries.slice().reverse().slice(0, limit).map((e, i) => ({
      id: i + 1, at: e.at, event: e.event, tool: e.tool ?? null, clientName: e.clientId ?? null, ok: e.ok ?? null,
      error: e.error ?? null, durationMs: e.durationMs ?? null, summary: e.summary ?? null,
    }));
  }
}
