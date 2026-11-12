import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityAlert, activityLabel, claudeCodeCommand, consentFailure, safeRedirect, scopeChip, scopeLabel, statusWarning } from './connector-view';

test('scopes read in plain English and unknown ones pass through', () => {
  assert.match(scopeLabel('mcp:read'), /^See channels/);
  assert.match(scopeLabel('mcp:write'), /locked from agent edits/);
  assert.equal(scopeLabel('x'), 'x');
  assert.equal(scopeChip('mcp:read'), 'read');
  assert.equal(scopeChip('mcp:write'), 'write');
});

test('the Claude Code command carries the URL', () => {
  assert.equal(claudeCodeCommand('https://dev.ai0.global/api/mcp'), 'claude mcp add --transport http ai0 https://dev.ai0.global/api/mcp');
});

test('status warnings: not configured and non-https are errors, off is a warning, a healthy connector says nothing', () => {
  const ok = { enabled: true, configured: true, httpsOk: true, url: 'https://x/api/mcp' };
  assert.equal(statusWarning(ok), null);
  assert.equal(statusWarning({ ...ok, configured: false })!.tone, 'danger');
  assert.match(statusWarning({ ...ok, httpsOk: false })!.text, /https/);
  assert.equal(statusWarning({ ...ok, enabled: false })!.tone, 'warning');
});

test('the consent redirect must be https, or loopback http for a local app', () => {
  assert.equal(safeRedirect('https://claude.ai/api/mcp/auth_callback?code=a&state=b', false), 'https://claude.ai/api/mcp/auth_callback?code=a&state=b');
  assert.equal(safeRedirect('http://localhost:5123/callback?code=a', true), 'http://localhost:5123/callback?code=a');
  assert.equal(safeRedirect('http://127.0.0.1:5123/callback', false), null);
  assert.equal(safeRedirect('http://evil.example/cb', true), null);
  assert.equal(safeRedirect('javascript:alert(1)', true), null);
  assert.equal(safeRedirect('data:text/html,x', true), null);
  assert.equal(safeRedirect(undefined, true), null);
  assert.equal(safeRedirect('not a url', true), null);
});

test('consent failures: unknown, expired, already decided, wrong session', () => {
  assert.equal(consentFailure(404, '{"error":"not_found"}'), 'unknown');
  assert.equal(consentFailure(410, '{"error":"expired"}'), 'expired');
  assert.equal(consentFailure(410, '{"error":"already_decided"}'), 'decided');
  // The codes the backend sends (oauth.service.ts pending/decide).
  assert.equal(consentFailure(410, '{"error":"request_expired","error_description":"x"}'), 'expired');
  assert.equal(consentFailure(410, '{"error":"request_decided","error_description":"x"}'), 'decided');
  assert.equal(consentFailure(404, '{"error":"request_not_found"}'), 'unknown');
  assert.equal(consentFailure(403, ''), 'denied');
  assert.equal(consentFailure(500, 'boom'), 'error');
});

test('activity: labels and which rows need a look', () => {
  assert.equal(activityLabel('tools/call'), 'Tool call');
  assert.equal(activityLabel('tool_call'), 'Tool call'); // the event name mcp_audit stores for tool rows
  assert.equal(activityLabel('weird'), 'weird');
  assert.equal(activityAlert({ event: 'tools/call', ok: false }), true);
  assert.equal(activityAlert({ event: 'refresh_reuse', ok: true }), true);
  assert.equal(activityAlert({ event: 'tools/call', ok: true }), false);
});
