import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentStrategyRegistry } from './content-strategy.registry';

function strat(type: string, supportedPlatforms?: string[]) {
  return { type, supportedPlatforms, getSkills: () => [], fetch: async () => null, generate: async () => null } as any;
}

test('supportedPlatforms returns the declared list', () => {
  const r = new ContentStrategyRegistry();
  r.register(strat('recipe-carousel', ['instagram', 'facebook', 'threads', 'tiktok']));
  assert.deepEqual(r.supportedPlatforms('recipe-carousel'), ['instagram', 'facebook', 'threads', 'tiktok']);
});

test('supportedPlatforms defaults to [telegram] when undeclared or unknown', () => {
  const r = new ContentStrategyRegistry();
  r.register(strat('ai0-news'));
  assert.deepEqual(r.supportedPlatforms('ai0-news'), ['telegram']);
  assert.deepEqual(r.supportedPlatforms('does-not-exist'), ['telegram']);
});
