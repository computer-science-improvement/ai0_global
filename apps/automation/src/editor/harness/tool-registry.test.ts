import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool, isToolError, toToolSpec } from './tool';
import { ToolRegistry } from './tool-registry';

const mk = (name: string, roles: any[], kind: any = 'read') =>
  defineTool({ name, description: `${name} desc`, input: z.object({ n: z.number().optional() }), kind, roles, execute: async () => ({ ok: true }) });

test('forRole filters by role', () => {
  const r = new ToolRegistry([mk('a', ['planner']), mk('b', ['executor']), mk('c', ['planner', 'executor'])]);
  assert.deepEqual(r.forRole('planner').map((t) => t.name), ['a', 'c']);
});

test('allowlist narrows but keeps terminal tools', () => {
  const r = new ToolRegistry([mk('a', ['executor']), mk('b', ['executor']), mk('publish', ['executor'], 'terminal')]);
  assert.deepEqual(r.forRole('executor', ['b']).map((t) => t.name), ['b', 'publish']);
  assert.deepEqual(r.forRole('executor', []).map((t) => t.name), ['a', 'b', 'publish']);
});

test('duplicate names rejected', () => {
  assert.throws(() => new ToolRegistry([mk('a', ['planner']), mk('a', ['executor'])]), /duplicate/);
});

test('toToolSpec emits object JSON schema without $schema', () => {
  const spec = toToolSpec(mk('a', ['planner']));
  assert.equal(spec.name, 'a');
  assert.equal((spec.parameters as any).type, 'object');
  assert.equal((spec.parameters as any).$schema, undefined);
});

test('isToolError', () => {
  assert.equal(isToolError({ error: 'x' }), true);
  assert.equal(isToolError({ ok: true }), false);
  assert.equal(isToolError(null), false);
});
