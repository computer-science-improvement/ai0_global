import { randomBytes } from 'crypto';
import { MemoryAudit } from '../../audit/audit';
import type { ConnectorUrls } from '../../types';
import { ClientRegistry, type MetadataFetcher } from '../clients';
import { CIMD_URL_HOSTED } from '../constants';
import { s256 } from '../crypto';
import { MemoryOAuthStore } from '../memory-store';
import { OAuthService, type DecisionContext } from '../oauth.service';

export const URLS: ConnectorUrls = {
  origin: 'https://dev.ai0.global', issuer: 'https://dev.ai0.global', resource: 'https://dev.ai0.global/api/mcp',
  prm: 'https://dev.ai0.global/.well-known/oauth-protected-resource/api/mcp',
};

/** A frozen clock the tests move by hand. */
export class Clock {
  t = Date.parse('2026-11-12T10:00:00Z');
  now = () => new Date(this.t);
  advance(ms: number) { this.t += ms; }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier) };
}

export const HOSTED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/** A fetcher that always fails, so the pinned copy is used. */
export const failingFetcher: MetadataFetcher = async () => { throw new Error('offline'); };

export function makeOAuth(fetcher: MetadataFetcher = failingFetcher) {
  const clock = new Clock();
  const store = new MemoryOAuthStore();
  const audit = new MemoryAudit();
  const clients = new ClientRegistry(store, fetcher, clock.now, audit);
  const oauth = new OAuthService(store, clients, audit, clock.now);
  return { clock, store, audit, clients, oauth };
}

export const SESSION: DecisionContext = { authMethod: 'session', production: true, origin: undefined, ip: '1.2.3.4' };

export async function registerDcr(clients: ClientRegistry, redirect = HOSTED_REDIRECT): Promise<string> {
  const r = await clients.register({ client_name: 'Test client', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }, '9.9.9.9');
  return r.client_id as string;
}

/** authorize → consent(allow) → the code the client receives. */
export async function getCode(
  h: ReturnType<typeof makeOAuth>, clientId: string, o: { redirect?: string; scope?: string; challenge?: string; state?: string; chosen?: string[]; resource?: string } = {},
): Promise<{ code: string; verifier: string; redirect: string }> {
  const { verifier, challenge } = o.challenge ? { verifier: '', challenge: o.challenge } : pkce();
  const redirect = o.redirect ?? HOSTED_REDIRECT;
  const a = await h.oauth.authorize({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    ...(o.scope !== undefined ? { scope: o.scope } : {}), state: o.state ?? 'st', ...(o.resource ? { resource: o.resource } : {}),
  }, URLS);
  if (a.kind !== 'redirect') throw new Error(`authorize failed: ${a.kind === 'page' ? a.message : ''}`);
  const id = new URL(a.location).searchParams.get('request');
  if (!id) throw new Error(`no consent request in ${a.location}`);
  const d = await h.oauth.decide(id, { decision: 'allow', ...(o.chosen ? { scopes: o.chosen } : {}) }, URLS, SESSION);
  const code = new URL(d.redirect).searchParams.get('code');
  if (!code) throw new Error(`no code in ${d.redirect}`);
  return { code, verifier, redirect };
}

export const CIMD = CIMD_URL_HOSTED;
