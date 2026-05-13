import { forceLink, forceManyBody, forceSimulation, forceCenter } from 'd3-force';
import type { Node, Edge } from 'reactflow';

interface SimNode { id: string; x?: number; y?: number; fx?: number; fy?: number; }
interface SimLink { source: string; target: string; }

/** One-shot d3-force layout. Returns the nodes with x/y positions. */
export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const simNodes: SimNode[] = nodes.map((n) => ({ id: n.id }));
  const simLinks: SimLink[] = edges
    .filter((e) => e.target)
    .map((e) => ({ source: e.source, target: e.target! }));

  const sim = forceSimulation(simNodes as any)
    .force('charge', forceManyBody().strength(-200))
    .force('link',   forceLink(simLinks).id((d: any) => d.id).distance(120))
    .force('center', forceCenter(0, 0))
    .stop();

  for (let i = 0; i < 200; i++) sim.tick();

  const pos = new Map(simNodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? { x: 0, y: 0 } }));
}
