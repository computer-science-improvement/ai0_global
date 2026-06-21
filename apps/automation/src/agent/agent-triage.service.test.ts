import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTriageService } from './agent-triage.service';

test('returns parsed triage from the model output', async () => {
  const claude = { available: true, chat: async () => '{"category":"ad","summary":"s","fields":{},"draftReply":"d","score":70}' } as any;
  const svc = new AgentTriageService(claude, { get: () => undefined } as any);
  const r = await svc.triage('хочу рекламу');
  assert.equal(r.category, 'ad');
  assert.equal(r.score, 70);
});

test('falls back to other when claude is unavailable', async () => {
  const claude = { available: false, chat: async () => { throw new Error('should not be called'); } } as any;
  const svc = new AgentTriageService(claude, { get: () => undefined } as any);
  const r = await svc.triage('x');
  assert.equal(r.category, 'other');
});

test('falls back to other when chat returns null', async () => {
  const claude = { available: true, chat: async () => null } as any;
  const svc = new AgentTriageService(claude, { get: () => undefined } as any);
  const r = await svc.triage('x');
  assert.equal(r.category, 'other');
});
