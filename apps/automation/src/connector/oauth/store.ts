/** The authorization server's state (migration 105). Every secret is a SHA-256 hex hash here; raw values never reach a store. */

export const OAUTH_STORE = 'CONNECTOR_OAUTH_STORE';

export type ClientKind = 'cimd' | 'dcr';

export interface ClientRow {
  id:           string;
  clientId:     string;
  kind:         ClientKind;
  name:         string;
  redirectUris: string[];
  createdIp:    string | null;
  createdAt:    Date;
  lastUsedAt:   Date | null;
  revokedAt:    Date | null;
}

export interface RequestRow {
  idHash:        string;
  clientId:      string;
  redirectUri:   string;
  codeChallenge: string;
  scope:         string;
  state:         string | null;
  resource:      string;
  createdAt:     Date;
  expiresAt:     Date;
  decidedAt:     Date | null;
  decision:      'allow' | 'deny' | null;
}

export interface GrantRow {
  id:            string;
  clientId:      string;
  scope:         string;
  resource:      string;
  createdAt:     Date;
  lastUsedAt:    Date | null;
  lastIp:        string | null;
  revokedAt:     Date | null;
  revokedReason: string | null;
}

export type StoredTokenKind = 'code' | 'access' | 'refresh';

export interface TokenRow {
  tokenHash:     string;
  kind:          StoredTokenKind;
  grantId:       string | null;
  clientId:      string;
  scope:         string;
  resource:      string;
  redirectUri:   string | null;
  codeChallenge: string | null;
  expiresAt:     Date;
  usedAt:        Date | null;
  replacedBy:    string | null;
  revokedAt:     Date | null;
  createdAt:     Date;
}

export interface ClientListRow extends ClientRow { activeGrants: number }
export interface GrantListRow extends GrantRow { clientName: string; expiresAt: Date | null }

export interface OAuthStore {
  // clients
  upsertClient(c: { clientId: string; kind: ClientKind; name: string; redirectUris: string[]; metadata?: Record<string, unknown>; createdIp?: string | null }, now: Date): Promise<ClientRow>;
  getClient(clientId: string): Promise<ClientRow | null>;
  /** DCR clients that count toward the cap: not revoked, and holding a live grant or used in the last 24 h. */
  countActiveDcr(now: Date): Promise<number>;
  touchClient(clientId: string, now: Date): Promise<void>;
  /** Active clients; a DCR client that never got a grant is hidden. */
  listClients(): Promise<ClientListRow[]>;
  /** Marks the client revoked and revokes every live grant it has; returns the number of grants revoked. */
  revokeClient(id: string, now: Date): Promise<{ found: boolean; revoked: number }>;

  // consent requests
  insertRequest(r: Omit<RequestRow, 'decidedAt' | 'decision' | 'createdAt'>, now: Date): Promise<void>;
  getRequest(idHash: string): Promise<RequestRow | null>;
  /** Requests of this client that still wait for a decision and have not expired. */
  countPendingRequests(clientId: string, now: Date): Promise<number>;
  /** Atomic: only a pending, unexpired request takes a decision. Returns the row, or null when it was not pending. */
  decideRequest(idHash: string, decision: 'allow' | 'deny', now: Date): Promise<RequestRow | null>;

  // grants
  createGrant(g: { id: string; clientId: string; scope: string; resource: string }, now: Date): Promise<GrantRow>;
  getGrant(id: string): Promise<GrantRow | null>;
  /** Removes a grant that never got used (a lost code race). Cascades to its tokens. */
  deleteGrant(id: string): Promise<void>;
  listGrants(): Promise<GrantListRow[]>;
  touchGrant(id: string, ip: string | null, now: Date): Promise<void>;
  /** Revokes the grant and every token under it. Returns false when it was unknown or already revoked. */
  revokeGrant(id: string, reason: string, now: Date): Promise<boolean>;
  revokeAllGrants(reason: string, now: Date): Promise<number>;
  /** Revokes the grant's tokens created at or after `since` (a rotation that must be undone). */
  revokeGrantTokensSince(grantId: string, since: Date, now: Date, exceptHash: string): Promise<void>;

  // tokens
  insertToken(t: Omit<TokenRow, 'usedAt' | 'replacedBy' | 'revokedAt' | 'createdAt'>, now: Date): Promise<void>;
  getToken(hash: string): Promise<TokenRow | null>;
  /**
   * Atomic single use of a code: sets used_at and the grant it produced. Returns the row on success;
   * null when the code was already used, expired, revoked or unknown.
   */
  consumeCode(hash: string, grantId: string, now: Date): Promise<TokenRow | null>;
  /** Atomic rotation of a refresh token: sets used_at and replaced_by. Returns false when it was already used or revoked. */
  consumeRefresh(hash: string, replacedBy: string, now: Date): Promise<boolean>;
  setReplacedBy(hash: string, replacedBy: string): Promise<void>;

  /** Housekeeping: drops expired codes, tokens and requests older than a day, and DCR clients that never got a grant within a day. */
  purge(now: Date): Promise<void>;
}
