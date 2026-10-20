import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistrySync } from './agent-registry-sync';
import { AGENT_KINDS, RESERVED_HANDLES, roleOfKind } from './agent.types';
import { lintSkill } from './skill-lint';
import { EDITOR_ROLES } from '../llm/model-registry';

function fakeAgents(o: { handles?: string[]; existing?: boolean; failInsert?: boolean } = {}) {
  const inserted: any[] = [];
  const handles = new Set(o.handles ?? []);
  return {
    inserted,
    repo: {
      allHandles: async () => handles,
      findTop: async (kind: string) => (kind === 'auditor' && o.existing ? { id: 'x', kind } : null),
      insert: async (a: any) => { if (o.failInsert) throw new Error('agents_kind_check'); inserted.push(a); return { id: `a${inserted.length}`, ...a }; },
      update: async () => undefined,
      linkLegacyRuns: async () => 0,
    } as any,
  };
}

test('055: the registry sync creates @sysadmin once, live, in the system scope', async () => {
  const a = fakeAgents();
  const logs: string[] = [];
  const sync = new AgentRegistrySync({ agents: a.repo, channels: { list: async () => [] } as any, log: (m) => logs.push(m) });
  await sync.run();
  assert.equal(a.inserted.length, 1);
  assert.deepEqual([a.inserted[0].kind, a.inserted[0].scope, a.inserted[0].scopeId, a.inserted[0].handle, a.inserted[0].mode], ['auditor', 'system', null, 'sysadmin', 'live']);
  assert.match(a.inserted[0].description, /тиждень/);
});

test('055: an existing @sysadmin is left alone; a taken handle gets a suffix; a failing insert never fails the sync', async () => {
  const had = fakeAgents({ existing: true });
  await new AgentRegistrySync({ agents: had.repo, channels: { list: async () => [] } as any }).run();
  assert.equal(had.inserted.length, 0);

  const taken = fakeAgents({ handles: ['sysadmin'] });
  await new AgentRegistrySync({ agents: taken.repo, channels: { list: async () => [] } as any }).run();
  assert.equal(taken.inserted[0].handle, 'sysadmin_2');

  const logs: string[] = [];
  const bad = fakeAgents({ failInsert: true });
  const r = await new AgentRegistrySync({ agents: bad.repo, channels: { list: async () => [] } as any, log: (m) => logs.push(m) }).run();
  assert.equal(r.created, 0);
  assert.ok(logs.some((l) => /not created/.test(l)));
});

test('055: the auditor role is wired through kinds, handles, models and skill roles', () => {
  assert.ok(AGENT_KINDS.includes('auditor' as any));
  assert.ok(RESERVED_HANDLES.has('sysadmin'));
  assert.equal(roleOfKind('auditor' as any), 'auditor');
  assert.ok(EDITOR_ROLES.includes('auditor'));
  // A skill may apply to the auditor role.
  const r = lintSkill({ name: 'auditor-x', description: 'A description long enough to pass the lint of skills.', appliesTo: ['auditor'], body: 'Text of the skill for the auditor role, long enough.' } as any);
  assert.ok(!r.errors.some((e: any) => /applies_to|role/i.test(JSON.stringify(e))), JSON.stringify(r.errors));
});
