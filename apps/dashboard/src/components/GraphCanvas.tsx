import { useMemo, useCallback } from 'react';
import ReactFlow, { Background, Controls } from 'reactflow';
import type { Node, Edge, EdgeMouseHandler, NodeMouseHandler } from 'reactflow';
import 'reactflow/dist/style.css';
import { ChannelNode } from './ChannelNode';
import { layoutGraph } from '../lib/graph-layout';
import type { GraphResponse } from '../api/types';

const TIER_HEX: Record<'green'|'orange'|'red', string> = { green: '#10b981', orange: '#f59e0b', red: '#ef4444' };

const nodeTypes = { channel: ChannelNode };

interface Props {
  data: GraphResponse;
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edge: Edge) => void;
}

export function GraphCanvas({ data, onNodeClick, onEdgeClick }: Props) {
  const { nodes, edges } = useMemo(() => {
    const rawNodes: Node[] = data.nodes.map((n) => ({
      id: n.id,
      type: 'channel',
      data: n,
      position: { x: 0, y: 0 },
    }));
    const rawEdges: Edge[] = data.edges
      .filter((e) => e.target)
      .map((e, i) => ({
        id: `${e.source}-${e.target_username}-${i}`,
        source: e.source,
        target: e.target!,
        label: `${e.count}`,
        style: { stroke: TIER_HEX[e.colorTier], strokeWidth: Math.min(1 + Math.log2(e.count + 1), 6) },
        labelBgStyle: { fill: '#171717' },
        labelStyle: { fill: TIER_HEX[e.colorTier], fontSize: 11 },
        data: e,
      }));
    return { nodes: layoutGraph(rawNodes, rawEdges), edges: rawEdges };
  }, [data]);

  const handleNodeClick: NodeMouseHandler = useCallback((_, node) => onNodeClick(node.id), [onNodeClick]);
  const handleEdgeClick: EdgeMouseHandler = useCallback((_, edge) => onEdgeClick(edge), [onEdgeClick]);

  return (
    <div className="h-[80vh] w-full rounded-lg border border-neutral-800">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick} onEdgeClick={handleEdgeClick}
        fitView minZoom={0.2} maxZoom={2}
      >
        <Background gap={20} color="#262626" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
