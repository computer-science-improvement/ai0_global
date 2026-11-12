// Spec 103 D2: the agent plan's slots carry who created and who locked them (the dashboard's connector and lock badges).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkService } from './network.service';
import { makeCard } from '../post/testing/fixtures';

test('plan(): a slot carries createdVia, lockedBy and lockedAt', async () => {
  const orch = { id: 'o1', handle: 'nova', scope: 'resource', scopeId: 'telegram:@space', parentId: null, mode: 'live' };
  const lockedAt = new Date('2030-03-04T07:00:00Z');
  const slotRow = {
    id: 's1', plan_id: 'p1', channel_key: '@space', scheduled_at: new Date('2030-03-05T10:00:00Z'), kind: 'content', format: 'text', topic: 'T',
    source_hints: [], status: 'planned', created_via: 'connector', locked_by: 'connector', locked_at: lockedAt,
  };
  const svc = new NetworkService({
    pool: { query: async (sql: string) => {
      if (/FROM editor_plans p/.test(sql)) return { rows: [{ id: 'p1', rationale: 'r', created_at: new Date(0), run_id: null, status: 'active', run_role: null, slots: 1 }] };
      if (/SELECT s\.\* FROM editor_slots/.test(sql)) return { rows: [slotRow] };
      return { rows: [] };
    } } as any,
    agents: { getByHandle: async () => orch, get: async () => orch } as any, repo: {} as any, inbox: {} as any,
    card: async () => makeCard({ channelKey: '@space', timezone: 'Europe/Kyiv' }), rebuild: async () => {},
  } as any);
  const day: any = await svc.plan('nova', '2030-03-05');
  assert.equal(day.slots[0].createdVia, 'connector');
  assert.equal(day.slots[0].lockedBy, 'connector');
  assert.deepEqual(day.slots[0].lockedAt, lockedAt);
});
