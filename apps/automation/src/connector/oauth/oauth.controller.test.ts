import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAudit } from '../audit/audit';
import { makeConnectorConfig } from '../http/config';
import { ClientRegistry } from './clients';
import { AUTHORIZE_PER_IP_PER_MIN } from './constants';
import { MemoryOAuthStore } from './memory-store';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { HOSTED_REDIRECT, failingFetcher, pkce, registerDcr } from './testing/fixtures';

class FakeRes {
  code = 0; headers: Record<string, string> = {}; sent = ''; location = '';
  setHeader(n: string, v: string) { this.headers[n.toLowerCase()] = v; }
  status(c: number) { this.code = c; return this; }
  type() { return this; }
  send(b: string) { this.sent = b; return this; }
  redirect(c: number, l: string) { this.code = c; this.location = l; }
}

test('AUTH-2: GET /authorize is limited per client address (429 page, Retry-After), other addresses are unaffected', async () => {
  const store = new MemoryOAuthStore();
  const audit = new MemoryAudit();
  const clients = new ClientRegistry(store, failingFetcher, () => new Date(), audit);
  const oauth = new OAuthService(store, clients, audit);
  const cfg = makeConnectorConfig((k) => ({ MCP_CONNECTOR: 'on', MCP_PUBLIC_URL: 'https://dev.ai0.global', NODE_ENV: 'production' } as Record<string, string>)[k]);
  const ctl = new OAuthController(cfg, oauth, clients);
  const clientId = await registerDcr(clients);
  const go = async (ip: string, id = clientId) => {
    const res = new FakeRes();
    const req = { ip, headers: {}, socket: { remoteAddress: ip }, query: { client_id: id, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256' } };
    await ctl.authorize(req, res);
    return res;
  };
  for (let i = 0; i < AUTHORIZE_PER_IP_PER_MIN; i++) assert.notEqual((await go('8.8.8.8', 'nope')).code, 429);
  const limited = await go('8.8.8.8');
  assert.equal(limited.code, 429);
  assert.match(limited.sent, /Too many requests/);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await go('9.9.9.9')).code, 302);
});
