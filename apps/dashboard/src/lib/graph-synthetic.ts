// DEV-ONLY synthetic graph generator — perf-testing the graph page without a
// large real dataset. Activated by `?synthetic=<edgeCount>` on /app/graph in
// dev builds only (the import.meta.env.DEV guard below dead-code-eliminates
// this from production bundles). Deterministic (seeded LCG) so repeated runs
// render the identical graph.
import type { GraphResponse, GraphEdge, GraphNode } from '../api/types';

/** Tiny deterministic PRNG (LCG) — same output for the same edge count. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function tierFor(count: number): GraphEdge['colorTier'] {
  if (count >= 10) return 'red';
  if (count >= 2)  return 'orange';
  return 'green';
}

export function makeSyntheticGraph(edgeCount: number): GraphResponse | null {
  if (!import.meta.env.DEV) return null;
  const n = Math.max(10, Math.min(edgeCount, 20_000));
  const rnd = lcg(n);

  const channelCount = Math.max(8, Math.floor(n / 3));
  const nodes: GraphNode[] = Array.from({ length: channelCount }, (_, i) => ({
    id: `syn-${i}`,
    username: `channel_${i}`,
    title: `Channel ${i}`,
    subs: Math.floor(rnd() * 2_000_000),
    isMine: rnd() < 0.03,
    category: null,
  }));

  const kinds = ['tg_channel', 'web', 'instagram', 'tg_user'] as const;
  const edges: GraphEdge[] = Array.from({ length: n }, (_, i) => {
    const src = nodes[Math.floor(rnd() * channelCount)];
    const external = rnd() < 0.12;
    const tgt = external ? null : nodes[Math.floor(rnd() * channelCount)];
    const count = 1 + Math.floor(rnd() * rnd() * 40); // skewed toward small
    return {
      source: src.id,
      target: tgt && tgt.id !== src.id ? tgt.id : null,
      target_username: tgt && tgt.id !== src.id
        ? tgt.username!
        : `ext-site-${i % 60}.com`,
      count,
      kind: tgt && tgt.id !== src.id ? 'tg_channel' : kinds[1 + Math.floor(rnd() * 3)],
      colorTier: tierFor(count),
      last_seen: new Date(2026, 5, 1 + (i % 28)).toISOString(),
    };
  });

  return { nodes, edges };
}
