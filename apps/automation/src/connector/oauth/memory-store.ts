import { randomUUID } from 'crypto';
import type { ClientListRow, ClientRow, GrantListRow, GrantRow, OAuthStore, RequestRow, TokenRow } from './store';

const DAY_MS = 24 * 3600 * 1000;

/** In-memory OAuthStore for unit tests: the same atomic rules as the PG one (single use, rotation, revoke cascade). */
export class MemoryOAuthStore implements OAuthStore {
  readonly clients  = new Map<string, ClientRow>();
  readonly requests = new Map<string, RequestRow>();
  readonly grants   = new Map<string, GrantRow>();
  readonly tokens   = new Map<string, TokenRow>();

  async upsertClient(c: { clientId: string; kind: 'cimd' | 'dcr'; name: string; redirectUris: string[]; createdIp?: string | null }, now: Date): Promise<ClientRow> {
    const cur = this.clients.get(c.clientId);
    const row: ClientRow = cur
      ? { ...cur, name: c.name, redirectUris: c.redirectUris, lastUsedAt: now, revokedAt: cur.kind === 'cimd' ? null : cur.revokedAt }
      : { id: randomUUID(), clientId: c.clientId, kind: c.kind, name: c.name, redirectUris: c.redirectUris, createdIp: c.createdIp ?? null, createdAt: now, lastUsedAt: null, revokedAt: null };
    this.clients.set(c.clientId, row);
    return row;
  }
  async getClient(clientId: string) { return this.clients.get(clientId) ?? null; }
  async countActiveDcr(now: Date) {
    const dayAgo = now.getTime() - DAY_MS;
    return [...this.clients.values()].filter((c) => c.kind === 'dcr' && !c.revokedAt
      && ([...this.grants.values()].some((g) => g.clientId === c.clientId && !g.revokedAt) || (c.lastUsedAt !== null && c.lastUsedAt.getTime() > dayAgo))).length;
  }
  async touchClient(clientId: string, now: Date) { const c = this.clients.get(clientId); if (c) c.lastUsedAt = now; }
  async listClients(): Promise<ClientListRow[]> {
    return [...this.clients.values()].filter((c) => !c.revokedAt && (c.kind === 'cimd' || [...this.grants.values()].some((g) => g.clientId === c.clientId))).map((c) => ({
      ...c, activeGrants: [...this.grants.values()].filter((g) => g.clientId === c.clientId && !g.revokedAt).length,
    }));
  }
  async revokeClient(id: string, now: Date) {
    const c = [...this.clients.values()].find((x) => x.id === id);
    if (!c) return { found: false, revoked: 0 };
    c.revokedAt = now;
    let revoked = 0;
    for (const g of this.grants.values()) if (g.clientId === c.clientId && !g.revokedAt) { await this.revokeGrant(g.id, 'client_removed', now); revoked++; }
    return { found: true, revoked };
  }

  async insertRequest(r: Omit<RequestRow, 'decidedAt' | 'decision' | 'createdAt'>, now: Date) {
    this.requests.set(r.idHash, { ...r, createdAt: now, decidedAt: null, decision: null });
  }
  async getRequest(idHash: string) { return this.requests.get(idHash) ?? null; }
  async countPendingRequests(clientId: string, now: Date) {
    return [...this.requests.values()].filter((r) => r.clientId === clientId && !r.decision && r.expiresAt > now).length;
  }
  async decideRequest(idHash: string, decision: 'allow' | 'deny', now: Date) {
    const r = this.requests.get(idHash);
    if (!r || r.decision || r.expiresAt <= now) return null;
    r.decision = decision; r.decidedAt = now;
    return { ...r };
  }

  async createGrant(g: { id: string; clientId: string; scope: string; resource: string }, now: Date): Promise<GrantRow> {
    const row: GrantRow = { ...g, createdAt: now, lastUsedAt: null, lastIp: null, revokedAt: null, revokedReason: null };
    this.grants.set(g.id, row);
    return row;
  }
  async getGrant(id: string) { return this.grants.get(id) ?? null; }
  async deleteGrant(id: string) {
    this.grants.delete(id);
    for (const [h, t] of this.tokens) if (t.grantId === id) this.tokens.delete(h);
  }
  async listGrants(): Promise<GrantListRow[]> {
    return [...this.grants.values()].filter((g) => !g.revokedAt).map((g) => {
      const exp = [...this.tokens.values()].filter((t) => t.grantId === g.id && t.kind === 'refresh' && !t.revokedAt).map((t) => t.expiresAt.getTime());
      return { ...g, clientName: this.clients.get(g.clientId)?.name ?? g.clientId, expiresAt: exp.length ? new Date(Math.max(...exp)) : null };
    });
  }
  async touchGrant(id: string, ip: string | null, now: Date) { const g = this.grants.get(id); if (g) { g.lastUsedAt = now; g.lastIp = ip; } }
  async revokeGrant(id: string, reason: string, now: Date) {
    const g = this.grants.get(id);
    if (!g || g.revokedAt) return false;
    g.revokedAt = now; g.revokedReason = reason;
    for (const t of this.tokens.values()) if (t.grantId === id && !t.revokedAt) t.revokedAt = now;
    return true;
  }
  async revokeAllGrants(reason: string, now: Date) {
    let n = 0;
    for (const g of this.grants.values()) if (!g.revokedAt && (await this.revokeGrant(g.id, reason, now))) n++;
    return n;
  }
  async revokeGrantTokensSince(grantId: string, since: Date, now: Date, exceptHash: string) {
    for (const t of this.tokens.values()) if (t.grantId === grantId && !t.revokedAt && t.createdAt >= since && t.tokenHash !== exceptHash) t.revokedAt = now;
  }

  async insertToken(t: Omit<TokenRow, 'usedAt' | 'replacedBy' | 'revokedAt' | 'createdAt'>, now: Date) {
    this.tokens.set(t.tokenHash, { ...t, usedAt: null, replacedBy: null, revokedAt: null, createdAt: now });
  }
  async getToken(hash: string) { const t = this.tokens.get(hash); return t ? { ...t } : null; }
  async consumeCode(hash: string, grantId: string, now: Date) {
    const t = this.tokens.get(hash);
    if (!t || t.kind !== 'code' || t.usedAt || t.revokedAt || t.expiresAt <= now) return null;
    t.usedAt = now; t.grantId = grantId;
    return { ...t };
  }
  async consumeRefresh(hash: string, replacedBy: string, now: Date) {
    const t = this.tokens.get(hash);
    if (!t || t.kind !== 'refresh' || t.usedAt || t.revokedAt) return false;
    t.usedAt = now; t.replacedBy = replacedBy;
    return true;
  }
  async setReplacedBy(hash: string, replacedBy: string) { const t = this.tokens.get(hash); if (t) t.replacedBy = replacedBy; }

  async purge(now: Date) {
    const cutoff = now.getTime() - 24 * 3600 * 1000;
    for (const [h, t] of this.tokens) if (t.expiresAt.getTime() < cutoff) this.tokens.delete(h);
    for (const [h, r] of this.requests) if (r.expiresAt.getTime() < cutoff) this.requests.delete(h);
    for (const [cid, c] of this.clients) {
      if (c.kind === 'dcr' && c.createdAt.getTime() < cutoff && ![...this.grants.values()].some((g) => g.clientId === cid)) this.clients.delete(cid);
    }
  }
}
