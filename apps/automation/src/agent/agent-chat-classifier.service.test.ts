import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatClassifier } from './agent-chat-classifier.service';

test('classifies via the model output', async () => {
  const claude = { available: true, chat: async () => '{"kind":"vp_request","summary":"s","score":60,"suggestedAction":"do_vp"}' } as any;
  const svc = new AgentChatClassifier(claude, { get: () => undefined } as any);
  const r = await svc.classify('Пропоную ВП');
  assert.equal(r.kind, 'vp_request'); assert.equal(r.suggestedAction, 'do_vp');
});
test('falls back to other when claude unavailable or null', async () => {
  const off = new AgentChatClassifier({ available: false, chat: async () => { throw new Error('no'); } } as any, { get: () => undefined } as any);
  assert.equal((await off.classify('x')).kind, 'other');
  const nul = new AgentChatClassifier({ available: true, chat: async () => null } as any, { get: () => undefined } as any);
  assert.equal((await nul.classify('x')).kind, 'other');
});
