import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategiesController } from './strategies.controller';

// daily-photo / ua-news / movies stay registered (still run for existing
// bindings) but must never appear in GET /types (the create/edit selects).
test('GET /types hides daily-photo, ua-news, movies', () => {
  const registry = {
    types: () => ['recipes', 'daily-photo', 'ua-news', 'movies', 'quotes'],
    supportedPlatforms: () => ['telegram'],
  };
  const c = new StrategiesController(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, registry as any, {} as any,
  );
  const out = c.listTypes().map((t: any) => t.type);
  assert.deepEqual(out, ['recipes', 'quotes']);
  for (const hidden of ['daily-photo', 'ua-news', 'movies']) {
    assert.ok(!out.includes(hidden), `${hidden} must be hidden from the select`);
  }
});
