import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import type { ClientListRow, ClientRow, GrantListRow, GrantRow, OAuthStore, RequestRow, TokenRow } from './store';

const d = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

const toClient = (r: any): ClientRow => ({
  id: r.id, clientId: r.client_id, kind: r.kind, name: r.name, redirectUris: Array.isArray(r.redirect_uris) ? r.redirect_uris : [],
  createdIp: r.created_ip ?? null, createdAt: d(r.created_at)!, lastUsedAt: d(r.last_used_at), revokedAt: d(r.revoked_at),
});
const toRequest = (r: any): RequestRow => ({
  idHash: r.id_hash, clientId: r.client_id, redirectUri: r.redirect_uri, codeChallenge: r.code_challenge, scope: r.scope, state: r.state ?? null,
  resource: r.resource, createdAt: d(r.created_at)!, expiresAt: d(r.expires_at)!, decidedAt: d(r.decided_at), decision: r.decision ?? null,
});
const toGrant = (r: any): GrantRow => ({
  id: r.id, clientId: r.client_id, scope: r.scope, resource: r.resource, createdAt: d(r.created_at)!, lastUsedAt: d(r.last_used_at),
  lastIp: r.last_ip ?? null, revokedAt: d(r.revoked_at), revokedReason: r.revoked_reason ?? null,
});
const toToken = (r: any): TokenRow => ({
  tokenHash: r.token_hash, kind: r.kind, grantId: r.grant_id ?? null, clientId: r.client_id, scope: r.scope, resource: r.resource,
  redirectUri: r.redirect_uri ?? null, codeChallenge: r.code_challenge ?? null, expiresAt: d(r.expires_at)!, usedAt: d(r.used_at),
  replacedBy: r.replaced_by ?? null, revokedAt: d(r.revoked_at), createdAt: d(r.created_at)!,
});

/** Postgres OAuthStore over migration 105. Single-use and rotation rules are one UPDATE … WHERE … RETURNING each. */
@Injectable()
export class PgOAuthStore implements OAuthStore {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsertClient(c: { clientId: string; kind: 'cimd' | 'dcr'; name: string; redirectUris: string[]; metadata?: Record<string, unknown>; createdIp?: string | null }, now: Date): Promise<ClientRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO mcp_oauth_clients (client_id, kind, name, redirect_uris, metadata, created_ip, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
       ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, metadata = EXCLUDED.metadata, last_used_at = $7,
         revoked_at = CASE WHEN mcp_oauth_clients.kind = 'cimd' THEN NULL ELSE mcp_oauth_clients.revoked_at END
       RETURNING *`,
      [c.clientId, c.kind, c.name, JSON.stringify(c.redirectUris), JSON.stringify(c.metadata ?? {}), c.createdIp ?? null, now],
    );
    return toClient(rows[0]);
  }
  async getClient(clientId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM mcp_oauth_clients WHERE client_id = $1`, [clientId]);
    return rows[0] ? toClient(rows[0]) : null;
  }
  async countActiveDcr(now: Date) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM mcp_oauth_clients c
        WHERE c.kind = 'dcr' AND c.revoked_at IS NULL
          AND (c.last_used_at > $1 OR EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL))`,
      [new Date(now.getTime() - 24 * 3600 * 1000)],
    );
    return rows[0].n as number;
  }
  async touchClient(clientId: string, now: Date) {
    await this.pool.query(`UPDATE mcp_oauth_clients SET last_used_at = $2 WHERE client_id = $1`, [clientId, now]);
  }
  async listClients(): Promise<ClientListRow[]> {
    const { rows } = await this.pool.query(
      `SELECT c.*, (SELECT count(*)::int FROM mcp_oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL) AS active_grants
         FROM mcp_oauth_clients c
        WHERE c.revoked_at IS NULL AND (c.kind = 'cimd' OR EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = c.client_id))
        ORDER BY c.created_at DESC`,
    );
    return rows.map((r) => ({ ...toClient(r), activeGrants: r.active_grants as number }));
  }
  async revokeClient(id: string, now: Date) {
    const c = await this.pool.query(`UPDATE mcp_oauth_clients SET revoked_at = $2 WHERE id = $1 RETURNING client_id`, [id, now]);
    if (!c.rows[0]) return { found: false, revoked: 0 };
    const ids = await this.pool.query(`SELECT id FROM mcp_oauth_grants WHERE client_id = $1 AND revoked_at IS NULL`, [c.rows[0].client_id]);
    let revoked = 0;
    for (const g of ids.rows) if (await this.revokeGrant(g.id, 'client_removed', now)) revoked++;
    return { found: true, revoked };
  }

  async insertRequest(r: Omit<RequestRow, 'decidedAt' | 'decision' | 'createdAt'>, now: Date) {
    await this.pool.query(
      `INSERT INTO mcp_oauth_requests (id_hash, client_id, redirect_uri, code_challenge, scope, state, resource, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.idHash, r.clientId, r.redirectUri, r.codeChallenge, r.scope, r.state, r.resource, now, r.expiresAt],
    );
  }
  async getRequest(idHash: string) {
    const { rows } = await this.pool.query(`SELECT * FROM mcp_oauth_requests WHERE id_hash = $1`, [idHash]);
    return rows[0] ? toRequest(rows[0]) : null;
  }
  async countPendingRequests(clientId: string, now: Date) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM mcp_oauth_requests WHERE client_id = $1 AND decision IS NULL AND expires_at > $2`, [clientId, now]);
    return rows[0].n as number;
  }
  async decideRequest(idHash: string, decision: 'allow' | 'deny', now: Date) {
    const { rows } = await this.pool.query(
      `UPDATE mcp_oauth_requests SET decision = $2, decided_at = $3 WHERE id_hash = $1 AND decision IS NULL AND expires_at > $3 RETURNING *`,
      [idHash, decision, now],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async createGrant(g: { id: string; clientId: string; scope: string; resource: string }, now: Date) {
    const { rows } = await this.pool.query(
      `INSERT INTO mcp_oauth_grants (id, client_id, scope, resource, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [g.id, g.clientId, g.scope, g.resource, now],
    );
    return toGrant(rows[0]);
  }
  async getGrant(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM mcp_oauth_grants WHERE id = $1`, [id]);
    return rows[0] ? toGrant(rows[0]) : null;
  }
  async deleteGrant(id: string) {
    await this.pool.query(`DELETE FROM mcp_oauth_grants WHERE id = $1`, [id]);
  }
  async listGrants(): Promise<GrantListRow[]> {
    const { rows } = await this.pool.query(
      `SELECT g.*, COALESCE(c.name, g.client_id) AS client_name,
              (SELECT max(t.expires_at) FROM mcp_oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh' AND t.revoked_at IS NULL) AS expires_at
         FROM mcp_oauth_grants g LEFT JOIN mcp_oauth_clients c ON c.client_id = g.client_id
        WHERE g.revoked_at IS NULL ORDER BY g.created_at DESC`,
    );
    return rows.map((r) => ({ ...toGrant(r), clientName: r.client_name as string, expiresAt: d(r.expires_at) }));
  }
  async touchGrant(id: string, ip: string | null, now: Date) {
    await this.pool.query(`UPDATE mcp_oauth_grants SET last_used_at = $3, last_ip = $2 WHERE id = $1`, [id, ip, now]);
  }
  async revokeGrant(id: string, reason: string, now: Date) {
    const g = await this.pool.query(`UPDATE mcp_oauth_grants SET revoked_at = $3, revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [id, reason, now]);
    if (!g.rows[0]) return false;
    await this.pool.query(`UPDATE mcp_oauth_tokens SET revoked_at = $2 WHERE grant_id = $1 AND revoked_at IS NULL`, [id, now]);
    return true;
  }
  async revokeAllGrants(reason: string, now: Date) {
    const g = await this.pool.query(`UPDATE mcp_oauth_grants SET revoked_at = $2, revoked_reason = $1 WHERE revoked_at IS NULL RETURNING id`, [reason, now]);
    if (g.rows.length) await this.pool.query(`UPDATE mcp_oauth_tokens SET revoked_at = $1 WHERE grant_id = ANY($2::uuid[]) AND revoked_at IS NULL`, [now, g.rows.map((r) => r.id)]);
    return g.rows.length;
  }
  async revokeGrantTokensSince(grantId: string, since: Date, now: Date, exceptHash: string) {
    await this.pool.query(`UPDATE mcp_oauth_tokens SET revoked_at = $3 WHERE grant_id = $1 AND created_at >= $2 AND token_hash <> $4 AND revoked_at IS NULL`, [grantId, since, now, exceptHash]);
  }

  async insertToken(t: Omit<TokenRow, 'usedAt' | 'replacedBy' | 'revokedAt' | 'createdAt'>, now: Date) {
    await this.pool.query(
      `INSERT INTO mcp_oauth_tokens (token_hash, kind, grant_id, client_id, scope, resource, redirect_uri, code_challenge, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.tokenHash, t.kind, t.grantId, t.clientId, t.scope, t.resource, t.redirectUri, t.codeChallenge, t.expiresAt, now],
    );
  }
  async getToken(hash: string) {
    const { rows } = await this.pool.query(`SELECT * FROM mcp_oauth_tokens WHERE token_hash = $1`, [hash]);
    return rows[0] ? toToken(rows[0]) : null;
  }
  async consumeCode(hash: string, grantId: string, now: Date) {
    const { rows } = await this.pool.query(
      `UPDATE mcp_oauth_tokens SET used_at = $3, grant_id = $2
        WHERE token_hash = $1 AND kind = 'code' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $3 RETURNING *`,
      [hash, grantId, now],
    );
    return rows[0] ? toToken(rows[0]) : null;
  }
  async consumeRefresh(hash: string, replacedBy: string, now: Date) {
    const { rows } = await this.pool.query(
      `UPDATE mcp_oauth_tokens SET used_at = $3, replaced_by = $2 WHERE token_hash = $1 AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL RETURNING token_hash`,
      [hash, replacedBy, now],
    );
    return rows.length === 1;
  }
  async setReplacedBy(hash: string, replacedBy: string) {
    await this.pool.query(`UPDATE mcp_oauth_tokens SET replaced_by = $2 WHERE token_hash = $1`, [hash, replacedBy]);
  }

  async purge(now: Date) {
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
    await this.pool.query(`DELETE FROM mcp_oauth_tokens WHERE expires_at < $1`, [cutoff]);
    await this.pool.query(`DELETE FROM mcp_oauth_requests WHERE expires_at < $1`, [cutoff]);
    await this.pool.query(
      `DELETE FROM mcp_oauth_clients c WHERE c.kind = 'dcr' AND c.created_at < $1 AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = c.client_id)`,
      [cutoff],
    );
  }
}
