import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingService } from './tracking.service';

/**
 * Guards the graph endpoint against the pool-exhaustion hang: it must resolve
 * every node in a SINGLE batched call (`getByIds`), never one `getById` per
 * node, and must forward the caller's minWeight to the (now LIMIT-bounded)
 * edges query.
 */
function makeService(opts: {
  edges: any[];
  channels: Array<{ id: string; username: string; title: string; subsCount: number; isMine: boolean; category?: string | null }>;
}) {
  let getByIdCalls = 0;
  const getByIdsCalls: string[][] = [];
  const edgeGraphArgs: any[] = [];

  const channelsRepo = {
    getById: async (_id: string) => { getByIdCalls++; return null; },
    getByIds: async (ids: string[]) => {
      getByIdsCalls.push(ids);
      return opts.channels.filter((c) => ids.includes(c.id));
    },
  };
  const edgesRepo = {
    graph: async (from: Date | null, to: Date | null, minWeight: number) => {
      edgeGraphArgs.push({ from, to, minWeight });
      return opts.edges;
    },
  };

  const svc = new TrackingService(
    {} as any, channelsRepo as any, {} as any, edgesRepo as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { svc, stats: () => ({ getByIdCalls, getByIdsCalls, edgeGraphArgs }) };
}

const edge = (over: Partial<any> = {}) => ({
  source_channel_id: 's1', target_channel_id: 't1', target_username: 'dst',
  target_kind: 'tg_channel', ad_post_count: 3,
  first_seen_at: new Date('2026-01-01'), last_seen_at: new Date('2026-06-01'),
  ...over,
});

const chan = (id: string, isMine = false) => ({
  id, username: `u_${id}`, title: `t_${id}`, subsCount: 10, isMine, category: null,
});

test('graph resolves all nodes in one batched getByIds call (no per-node fan-out)', async () => {
  const { svc, stats } = makeService({
    edges: [
      edge({ source_channel_id: 's1', target_channel_id: 't1' }),
      edge({ source_channel_id: 's2', target_channel_id: 't2', ad_post_count: 5 }),
    ],
    channels: [chan('s1'), chan('t1'), chan('s2'), chan('t2')],
  });

  const res = await svc.graph({ from: null, to: null, minWeight: 2, includeMine: true });

  const { getByIdCalls, getByIdsCalls } = stats();
  assert.equal(getByIdCalls, 0, 'must not fan out per-node getById');
  assert.equal(getByIdsCalls.length, 1, 'exactly one batched getByIds call');
  assert.deepEqual([...getByIdsCalls[0]].sort(), ['s1', 's2', 't1', 't2']);
  assert.equal(res.nodes.length, 4);
  assert.equal(res.edges.length, 2);
});

test('graph forwards minWeight to the (bounded) edges query', async () => {
  const { svc, stats } = makeService({ edges: [], channels: [] });
  await svc.graph({ from: null, to: null, minWeight: 7, includeMine: true });
  assert.equal(stats().edgeGraphArgs[0].minWeight, 7);
});

test('graph with includeMine=false drops edges whose source is mine', async () => {
  const { svc } = makeService({
    edges: [
      edge({ source_channel_id: 'mine', target_channel_id: 't1' }),
      edge({ source_channel_id: 'other', target_channel_id: 't2' }),
    ],
    channels: [chan('mine', true), chan('other', false), chan('t1'), chan('t2')],
  });

  const res = await svc.graph({ from: null, to: null, minWeight: 1, includeMine: false });
  assert.equal(res.edges.length, 1);
  assert.equal(res.edges[0].source, 'other');
});
