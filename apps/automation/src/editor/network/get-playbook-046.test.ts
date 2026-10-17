/** Spec 046 FR-008: the manager reads an orchestrator's playbook by handle (it has no orchestrator context). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkTools } from './network-tools';
import type { ToolContext } from '../harness/tool';

const PB = { platforms: [{ resource_ref: 'telegram:@nova', role: 'core' }] };

test('046: get_playbook(handle) works for the manager; without a context it asks for the handle', async () => {
  const repo: any = {
    activePlaybook: async (id: string) => (id === 'o1' ? { version: 4, body: PB } : null),
    pendingPlaybook: async () => ({ id: 'p1', version: 5, rationale: 'r', review: null }),
  };
  const agents = { getByHandle: async (h: string) => (h === 'nova' ? { id: 'o1', handle: 'nova', kind: 'orchestrator' } : h === 'writer' ? { id: 'w', handle: 'writer', kind: 'executor' } : null) as any };
  const tool = buildNetworkTools({ repo, plans: {} as any, memory: { add: async () => 1 }, inbox: { post: async () => {} } as any, agents }).find((t) => t.name === 'get_playbook')!;
  const manager: ToolContext = { runId: 'r', role: 'manager', channelKey: null, slotId: null, extras: {} };
  const call = (args: unknown) => tool.execute(tool.input.parse(args), manager) as Promise<any>;
  const r = await call({ handle: '@nova' });
  assert.deepEqual([r.orchestrator, r.active.version, r.pending.version], ['@nova', 4, 5]);
  assert.equal((await call({ handle: 'writer' })).error, 'unknown_orchestrator');
  assert.equal((await call({})).error, 'handle_required');
});
