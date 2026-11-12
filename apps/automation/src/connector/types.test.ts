import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorStatus } from './types';

const env = (o: Record<string, string>) => (k: string) => o[k];

test('connectorStatus: off by default, URLs from MCP_PUBLIC_URL or DASHBOARD_URL, https origin only', () => {
  assert.equal(connectorStatus(env({})).status.reason, 'not_configured');
  const off = connectorStatus(env({ DASHBOARD_URL: 'https://dev.ai0.global/app' }));
  assert.equal(off.status.reason, 'off');
  assert.equal(off.status.url, 'https://dev.ai0.global/api/mcp', 'the path of DASHBOARD_URL is dropped');
  const on = connectorStatus(env({ MCP_CONNECTOR: 'on', DASHBOARD_URL: 'https://x.test', MCP_PUBLIC_URL: 'https://dev.ai0.global/' }));
  assert.equal(on.status.enabled, true);
  assert.deepEqual(on.urls, {
    origin: 'https://dev.ai0.global', issuer: 'https://dev.ai0.global', resource: 'https://dev.ai0.global/api/mcp',
    prm: 'https://dev.ai0.global/.well-known/oauth-protected-resource/api/mcp',
  });
  assert.equal(connectorStatus(env({ MCP_CONNECTOR: 'on', DASHBOARD_URL: 'http://dev.ai0.global' })).status.reason, 'not_https');
  assert.equal(connectorStatus(env({ MCP_CONNECTOR: 'on', DASHBOARD_URL: 'http://localhost:5173' })).status.enabled, true);
  assert.equal(connectorStatus(env({ MCP_CONNECTOR: 'on', DASHBOARD_URL: 'not a url' })).status.reason, 'not_configured');
});
