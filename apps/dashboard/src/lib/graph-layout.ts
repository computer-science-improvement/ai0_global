import dagre from '@dagrejs/dagre';
import type { Node, Edge } from 'reactflow';

export type LayoutDirection = 'TB' | 'LR' | 'BT' | 'RL';

/**
 * Hierarchical tree-style layout via dagre. Better than force-directed for
 * ad-relationship graphs because the source → target direction has actual
 * semantic meaning (who advertises whom).
 *
 * Multiple incoming edges per node are fine — dagre handles DAGs, not just
 * strict trees. Disconnected components are placed side-by-side.
 *
 * direction:
 *   - TB (default) — top to bottom; sources at the top, targets below
 *   - LR — left to right; useful for wide screens with many channels
 *   - BT / RL — inverses
 */
export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'TB',
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir:   direction,
    nodesep:   60,   // horizontal gap between siblings
    ranksep:   90,   // vertical gap between layers
    edgesep:   20,   // padding between parallel edges
    marginx:   20,
    marginy:   20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Approximate node sizes — must match the rendered ChannelNode chrome so
  // dagre routes edges without overlapping cards.
  const NODE_W = 160;
  const NODE_H = 64;

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => {
    if (e.target) g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      // dagre centers nodes at (pos.x, pos.y); React Flow positions by top-left,
      // so we offset by half-size.
      position: pos
        ? { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 }
        : { x: 0, y: 0 },
    };
  });
}
