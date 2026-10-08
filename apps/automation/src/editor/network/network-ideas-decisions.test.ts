import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkService } from './network.service';
import { makeCard } from '../post/testing/fixtures';

test('ideas(): each idea carries its per-resource decisions (spec 024 FR-011, the Ideas card matrix)', async () => {
  const orch = { id: 'o1', handle: 'nova', scope: 'resource', scopeId: 'telegram:@space', parentId: null, mode: 'live' };
  const queries: string[] = [];
  const svc = new NetworkService({
    pool: { query: async (sql: string) => {
      queries.push(sql);
      return { rows: [
        { idea_id: 'i1', resource_ref: 'telegram:@space', decision: 'unique', reason: 'core resource of the network', reason_code: null, slot_id: 's1', decided_by: 'planner', created_at: new Date(0) },
        { idea_id: 'i1', resource_ref: 'instagram:ig', decision: 'skip', reason: 'profile excludes food topics', reason_code: 'off_topic', slot_id: null, decided_by: 'planner', created_at: new Date(0) },
      ] };
    } } as any,
    agents: { getByHandle: async () => orch, get: async () => null } as any,
    repo: { listIdeas: async () => [{ id: 'i1', title: 'A' }, { id: 'i2', title: 'B' }] } as any,
    inbox: { post: async () => 0 } as any,
    card: async () => makeCard({ channelKey: '@space' }) as any,
    rebuild: async () => null,
  });
  const r: any = await svc.ideas('nova');
  assert.equal(r.ideas[0].decisions.length, 2);
  assert.deepEqual(r.ideas[0].decisions[1], {
    ideaId: 'i1', resourceRef: 'instagram:ig', decision: 'skip', reason: 'profile excludes food topics', reasonCode: 'off_topic', slotId: null, decidedBy: 'planner', at: new Date(0),
  });
  assert.deepEqual(r.ideas[1].decisions, []);
  assert.match(queries[0], /FROM content_decisions/);
});
