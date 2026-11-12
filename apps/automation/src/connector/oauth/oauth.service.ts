import { randomUUID } from 'crypto';
import { SCOPE_LABELS, type ConnectorPrincipal, type ConnectorScope, type ConnectorUrls } from '../types';
import type { AuditSink } from '../audit/audit';
import { ClientRegistry } from './clients';
import { ACCESS_TTL_S, CODE_TTL_MS, REFRESH_GRACE_MS, REFRESH_TTL_MS, REQUEST_TTL_MS, isScope } from './constants';
import { CHALLENGE_RE, VERIFIER_RE, newOpaqueId, newToken, s256, safeEq, sha256Hex, type TokenKind } from './crypto';
import { OAuthError } from './errors';
import { anyRedirectMatches, isLoopbackUri } from './redirect';
import type { OAuthStore, TokenRow } from './store';

export type AuthorizeResult =
  | { kind: 'redirect'; location: string }
  /** Pre-redirect failure: unknown client or bad redirect_uri. Shown as a plain page, never redirected. */
  | { kind: 'page'; message: string };

export interface TokenResponse {
  access_token:  string;
  token_type:    'Bearer';
  expires_in:    number;
  refresh_token: string;
  scope:         string;
}

export interface Caller { ip: string | null }

/** The decision endpoint needs to know how the owner authenticated and where the request came from. */
export interface DecisionContext { authMethod: string; production: boolean; origin: string | undefined; ip: string | null }

const sameResource = (given: string, canonical: string) => given === canonical || given.replace(/\/$/, '') === canonical;
const hash = sha256Hex;

/** The in-house OAuth 2.1 authorization server (spec 103 §5). Time and storage are injected. */
export class OAuthService {
  private lastPurge = 0;

  constructor(
    private readonly store: OAuthStore,
    private readonly clients: ClientRegistry,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── A3 authorize ────────────────────────────────────────────────────────────

  async authorize(q: Record<string, string | undefined>, urls: ConnectorUrls): Promise<AuthorizeResult> {
    const now = this.now();
    void this.maybePurge(now);

    let client;
    try { client = await this.clients.resolve(q.client_id ?? ''); } catch (e) {
      if (e instanceof OAuthError) return { kind: 'page', message: `This client cannot connect: ${e.description}.` };
      throw e;
    }
    if (!client) return { kind: 'page', message: 'This client is not registered. Remove the connector and add it again.' };

    if (!q.redirect_uri && client.redirectUris.length !== 1) return { kind: 'page', message: 'The request has no redirect_uri.' };
    const redirectUri: string = q.redirect_uri || client.redirectUris[0];
    if (q.redirect_uri && !anyRedirectMatches(client.redirectUris, redirectUri)) {
      return { kind: 'page', message: 'The redirect_uri does not match this client.' };
    }
    const fail = (error: string, description: string): AuthorizeResult => ({
      kind: 'redirect', location: this.callbackUrl(redirectUri, { error, error_description: description }, q.state, urls.issuer),
    });

    if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be "code"');
    const challenge = q.code_challenge;
    if (!challenge || !CHALLENGE_RE.test(challenge)) return fail('invalid_request', 'code_challenge is required (S256)');
    if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');

    const scopes = this.parseScopes(q.scope);
    if (!scopes) return fail('invalid_scope', 'Supported scopes: mcp:read, mcp:write');
    if (q.resource !== undefined && !sameResource(q.resource, urls.resource)) return fail('invalid_target', `resource must be ${urls.resource}`);

    const id = newOpaqueId();
    await this.store.insertRequest({
      idHash: hash(id), clientId: client.clientId, redirectUri, codeChallenge: challenge, scope: scopes.join(' '),
      state: q.state ?? null, resource: urls.resource, expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    }, now);
    return { kind: 'redirect', location: `${urls.origin}/app/oauth/consent?request=${encodeURIComponent(id)}` };
  }

  /** `scope` → the granted set. Empty means both; `offline_access` is ignored (refresh tokens are always issued); unknown → null. */
  parseScopes(raw: string | undefined): ConnectorScope[] | null {
    const parts = (raw ?? '').split(/\s+/).filter((s) => s && s !== 'offline_access');
    if (!parts.every(isScope)) return null;
    const set = new Set<ConnectorScope>(parts as ConnectorScope[]);
    return set.size ? [...set] : ['mcp:read', 'mcp:write'];
  }

  private callbackUrl(redirectUri: string, params: Record<string, string>, state: string | undefined, issuer: string): string {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (state !== undefined && state !== null) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuer);
    return u.toString();
  }

  // ── A4 consent ──────────────────────────────────────────────────────────────

  private async pending(id: string) {
    const row = id ? await this.store.getRequest(hash(id)) : null;
    if (!row) throw new OAuthError(404, 'request_not_found', 'Unknown authorization request');
    // The consent page tells the two apart by the code (expired → start again from Claude; decided → close the tab).
    if (row.decision) throw new OAuthError(410, 'request_decided', 'This authorization request was already answered');
    if (row.expiresAt <= this.now()) throw new OAuthError(410, 'request_expired', 'This authorization request has expired');
    return row;
  }

  async requestInfo(id: string): Promise<{
    id: string; client: { clientId: string; name: string; kind: string; redirectHost: string; loopback: boolean };
    scopes: { scope: string; label: string }[]; expiresAt: string;
  }> {
    const row = await this.pending(id);
    const client = await this.store.getClient(row.clientId);
    if (!client || client.revokedAt) throw new OAuthError(404, 'request_not_found', 'Unknown authorization request');
    return {
      id,
      client: { clientId: client.clientId, name: client.name, kind: client.kind, redirectHost: new URL(row.redirectUri).host, loopback: isLoopbackUri(row.redirectUri) },
      scopes: row.scope.split(' ').filter(isScope).map((s) => ({ scope: s, label: SCOPE_LABELS[s] })),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async decide(id: string, body: { decision?: unknown; scopes?: unknown }, urls: ConnectorUrls, ctx: DecisionContext): Promise<{ redirect: string }> {
    // A TRACKING_TOKEN bearer is a script, not the owner at the browser: only a real session (or the explicit local dev bypass) may consent.
    const okMethod = ctx.authMethod === 'session' || (ctx.authMethod === 'dev' && !ctx.production);
    if (!okMethod) throw new OAuthError(403, 'session_required', 'Sign in to the dashboard to approve this connection');
    if (ctx.origin !== undefined && ctx.origin !== urls.origin) throw new OAuthError(403, 'bad_origin', 'The request did not come from the dashboard');
    if (body.decision !== 'allow' && body.decision !== 'deny') throw new OAuthError(400, 'invalid_request', 'decision must be "allow" or "deny"');

    const row = await this.pending(id);
    const requested = row.scope.split(' ').filter(isScope);
    let chosen: ConnectorScope[] = requested;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes) || !body.scopes.every((s) => typeof s === 'string' && requested.includes(s as ConnectorScope))) {
        throw new OAuthError(400, 'invalid_scope', 'scopes must be a subset of the requested scopes');
      }
      chosen = requested.filter((s) => (body.scopes as string[]).includes(s));
    }
    const now = this.now();
    const client = await this.store.getClient(row.clientId);
    if (body.decision === 'allow' && !chosen.length) throw new OAuthError(400, 'invalid_scope', 'Pick at least one permission');

    const decided = await this.store.decideRequest(hash(id), body.decision, now);
    // Lost the race to a concurrent decision (pending() just saw it fresh and undecided).
    if (!decided) throw new OAuthError(410, 'request_decided', 'This authorization request was already answered');

    if (body.decision === 'deny') {
      await this.audit.record({ event: 'consent_deny', clientId: row.clientId, summary: `client=${client?.name ?? row.clientId}`, ip: ctx.ip }, now);
      return { redirect: this.callbackUrl(row.redirectUri, { error: 'access_denied', error_description: 'The owner denied the request' }, row.state ?? undefined, urls.issuer) };
    }
    const code = newToken('code');
    await this.store.insertToken({
      tokenHash: hash(code), kind: 'code', grantId: null, clientId: row.clientId, scope: chosen.join(' '), resource: row.resource,
      redirectUri: row.redirectUri, codeChallenge: row.codeChallenge, expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    }, now);
    await this.store.touchClient(row.clientId, now);
    await this.audit.record({ event: 'consent_allow', clientId: row.clientId, summary: `client=${client?.name ?? row.clientId} scope=${chosen.join(' ')}`, ip: ctx.ip }, now);
    return { redirect: this.callbackUrl(row.redirectUri, { code }, row.state ?? undefined, urls.issuer) };
  }

  // ── A5 token ────────────────────────────────────────────────────────────────

  async token(p: Record<string, unknown>, urls: ConnectorUrls, caller: Caller): Promise<TokenResponse> {
    const str = (k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : undefined);
    const grantType = str('grant_type');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    const clientId = str('client_id');
    if (!clientId) throw new OAuthError(400, 'invalid_request', 'client_id is required');
    const client = await this.store.getClient(clientId);
    if (!client || client.revokedAt) throw new OAuthError(401, 'invalid_client', 'Unknown client');
    const resource = str('resource');
    if (resource !== undefined && !sameResource(resource, urls.resource)) throw new OAuthError(400, 'invalid_target', `resource must be ${urls.resource}`);
    return grantType === 'authorization_code'
      ? this.exchangeCode({ clientId, code: str('code'), redirectUri: str('redirect_uri'), verifier: str('code_verifier'), resource }, urls, caller)
      : this.exchangeRefresh({ clientId, refresh: str('refresh_token'), scope: str('scope'), resource }, urls, caller);
  }

  private async exchangeCode(
    a: { clientId: string; code?: string; redirectUri?: string; verifier?: string; resource?: string },
    urls: ConnectorUrls, caller: Caller,
  ): Promise<TokenResponse> {
    if (!a.code || !a.redirectUri || !a.verifier) throw new OAuthError(400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
    const now = this.now();
    const row = await this.store.getToken(hash(a.code));
    if (!row || row.kind !== 'code') throw new OAuthError(400, 'invalid_grant', 'Unknown or expired authorization code');
    if (row.usedAt) {
      // OAuth 2.1 §4.1.2: a second use of a code revokes what the first use produced.
      await this.revokeForReuse(row, 'code_reuse', caller.ip);
      throw new OAuthError(400, 'invalid_grant', 'Authorization code already used');
    }
    if (row.revokedAt || row.expiresAt <= now) throw new OAuthError(400, 'invalid_grant', 'Unknown or expired authorization code');
    if (row.clientId !== a.clientId) throw new OAuthError(400, 'invalid_grant', 'The code was issued to another client');
    if (row.redirectUri !== a.redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (!VERIFIER_RE.test(a.verifier) || !row.codeChallenge || !safeEq(s256(a.verifier), row.codeChallenge)) {
      throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed');
    }
    if (a.resource !== undefined && !sameResource(a.resource, row.resource)) throw new OAuthError(400, 'invalid_target', 'resource does not match the authorization request');

    // The grant exists first so the code row can point at it in the same atomic UPDATE that marks the code used.
    const grantId = randomUUID();
    await this.store.createGrant({ id: grantId, clientId: row.clientId, scope: row.scope, resource: row.resource }, now);
    const consumed = await this.store.consumeCode(hash(a.code), grantId, now);
    if (!consumed) {
      await this.store.deleteGrant(grantId);
      const again = await this.store.getToken(hash(a.code));
      if (again?.usedAt) await this.revokeForReuse(again, 'code_reuse', caller.ip);
      throw new OAuthError(400, 'invalid_grant', 'Authorization code already used');
    }
    const out = await this.issuePair(grantId, row.clientId, row.scope, row.resource, now);
    await this.store.touchClient(row.clientId, now);
    await this.audit.record({ event: 'token_issued', grantId, clientId: row.clientId, summary: `authorization_code scope=${row.scope}`, ip: caller.ip }, now);
    return out;
  }

  private async exchangeRefresh(
    a: { clientId: string; refresh?: string; scope?: string; resource?: string },
    _urls: ConnectorUrls, caller: Caller,
  ): Promise<TokenResponse> {
    if (!a.refresh) throw new OAuthError(400, 'invalid_request', 'refresh_token is required');
    const now = this.now();
    const bad = () => new OAuthError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked');
    const row = await this.store.getToken(hash(a.refresh));
    if (!row || row.kind !== 'refresh' || !row.grantId || row.clientId !== a.clientId) throw bad();
    const grant = await this.store.getGrant(row.grantId);
    if (!grant || grant.revokedAt || row.revokedAt || row.expiresAt <= now) throw bad();
    if (a.resource !== undefined && !sameResource(a.resource, row.resource)) throw new OAuthError(400, 'invalid_target', 'resource does not match the grant');

    let scope = row.scope;
    if (a.scope !== undefined) {
      const asked = a.scope.split(/\s+/).filter(Boolean);
      const held = row.scope.split(' ');
      if (!asked.every((s) => held.includes(s))) throw new OAuthError(400, 'invalid_scope', 'scope may not be wider than the grant');
      scope = asked.join(' ');
    }

    const next = this.mint('refresh');
    const rotated = row.usedAt ? false : await this.store.consumeRefresh(hash(a.refresh), next.hash, now);
    if (!rotated) {
      // Already used: a lost response being retried (grace) or a stolen token (revoke everything).
      const used = row.usedAt ? row : await this.store.getToken(hash(a.refresh));
      const usedAt = used?.usedAt ?? now;
      if (now.getTime() - usedAt.getTime() > REFRESH_GRACE_MS) {
        await this.revokeForReuse(row, 'refresh_reuse', caller.ip);
        throw bad();
      }
      await this.store.revokeGrantTokensSince(row.grantId, usedAt, now, hash(a.refresh));
      await this.store.setReplacedBy(hash(a.refresh), next.hash);
    }
    const out = await this.issuePair(row.grantId, row.clientId, scope, row.resource, now, next);
    await this.audit.record({ event: 'token_issued', grantId: row.grantId, clientId: row.clientId, summary: rotated ? 'refresh_token' : 'refresh_token (retry)', ip: caller.ip }, now);
    return out;
  }

  private async revokeForReuse(row: TokenRow, reason: 'code_reuse' | 'refresh_reuse', ip: string | null): Promise<void> {
    if (!row.grantId) return;
    const was = await this.store.revokeGrant(row.grantId, reason, this.now());
    if (was) await this.audit.record({ event: 'refresh_reuse', grantId: row.grantId, clientId: row.clientId, summary: reason, ip }, this.now());
  }

  private mint(kind: TokenKind): { raw: string; hash: string } {
    const raw = newToken(kind);
    return { raw, hash: hash(raw) };
  }

  private async issuePair(grantId: string, clientId: string, scope: string, resource: string, now: Date, refresh = this.mint('refresh')): Promise<TokenResponse> {
    const access = this.mint('access');
    await this.store.insertToken({ tokenHash: refresh.hash, kind: 'refresh', grantId, clientId, scope, resource, redirectUri: null, codeChallenge: null, expiresAt: new Date(now.getTime() + REFRESH_TTL_MS) }, now);
    await this.store.insertToken({ tokenHash: access.hash, kind: 'access', grantId, clientId, scope, resource, redirectUri: null, codeChallenge: null, expiresAt: new Date(now.getTime() + ACCESS_TTL_S * 1000) }, now);
    return { access_token: access.raw, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh.raw, scope };
  }

  // ── A6 revoke ───────────────────────────────────────────────────────────────

  /** RFC 7009: revokes the grant behind an access or refresh token. The caller answers 200 whatever happened. */
  async revoke(p: Record<string, unknown>, caller: Caller): Promise<void> {
    const token = typeof p.token === 'string' ? p.token : '';
    if (!token) return;
    const row = await this.store.getToken(hash(token));
    if (!row || row.kind === 'code' || !row.grantId) return;
    if (typeof p.client_id === 'string' && p.client_id && p.client_id !== row.clientId) return;
    const now = this.now();
    if (await this.store.revokeGrant(row.grantId, 'revoked_by_client', now)) {
      await this.audit.record({ event: 'revoked', grantId: row.grantId, clientId: row.clientId, summary: 'revoked by the client', ip: caller.ip }, now);
    }
  }

  // ── B1 bearer validation ────────────────────────────────────────────────────

  /** A live access token for the canonical resource, under a live grant. Null otherwise (never says why). */
  async authenticateAccess(bearer: string, urls: ConnectorUrls): Promise<ConnectorPrincipal | null> {
    if (!bearer.startsWith('ai0mcp_at_')) return null;
    const now = this.now();
    const row = await this.store.getToken(hash(bearer));
    if (!row || row.kind !== 'access' || row.revokedAt || row.expiresAt <= now || row.resource !== urls.resource || !row.grantId) return null;
    const grant = await this.store.getGrant(row.grantId);
    if (!grant || grant.revokedAt || grant.resource !== urls.resource) return null;
    const held = new Set(grant.scope.split(' '));
    const scopes = new Set(row.scope.split(' ').filter(isScope).filter((s) => held.has(s)));
    const client = await this.store.getClient(row.clientId);
    if (!client || client.revokedAt) return null;
    return { grantId: grant.id, clientId: row.clientId, clientName: client.name, scopes };
  }

  private async maybePurge(now: Date): Promise<void> {
    if (now.getTime() - this.lastPurge < 3600 * 1000) return;
    this.lastPurge = now.getTime();
    await this.store.purge(now).catch(() => undefined);
  }
}
