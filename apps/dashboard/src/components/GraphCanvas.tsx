import { useEffect, useMemo, useCallback, useState } from 'react';
import ReactFlow, {
  Background, Controls, Position, MarkerType,
  applyNodeChanges,
} from 'reactflow';
import type { Node, Edge, EdgeMouseHandler, NodeMouseHandler, NodeChange } from 'reactflow';
import 'reactflow/dist/style.css';
import { ChannelNode } from './ChannelNode';
import { layoutGraph, type LayoutDirection } from '../lib/graph-layout';
import type { GraphResponse } from '../api/types';

const TIER_HEX: Record<'green'|'orange'|'red', string> = {
  green:  '#22c55e',
  orange: '#f59e0b',
  red:    '#ef4444',
};

const nodeTypes = { channel: ChannelNode };

interface Props {
  data: GraphResponse;
  direction?: LayoutDirection;
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edge: Edge) => void;
}

/**
 * Graph canvas with drag-to-rearrange. Nodes start at dagre-computed positions;
 * user drags override those positions until the underlying data/direction
 * changes (which resets to a fresh dagre layout). Drag state is local — no
 * persistence yet; refreshing the page returns to the auto-layout.
 */
export function GraphCanvas({ data, direction = 'TB', onNodeClick, onEdgeClick }: Props) {
  // Initial layout — recomputed when data/direction change.
  const { initialNodes, edges } = useMemo(() => {
    const sourcePos = direction === 'TB' ? Position.Bottom
                    : direction === 'BT' ? Position.Top
                    : direction === 'LR' ? Position.Right
                    : Position.Left;
    const targetPos = direction === 'TB' ? Position.Top
                    : direction === 'BT' ? Position.Bottom
                    : direction === 'LR' ? Position.Left
                    : Position.Right;
    const horizontal = direction === 'LR' || direction === 'RL';

    const rawNodes: Node[] = data.nodes.map((n) => ({
      id: n.id,
      type: 'channel',
      data: { ...n, horizontal },
      position: { x: 0, y: 0 },
      sourcePosition: sourcePos,
      targetPosition: targetPos,
      draggable: true,
    }));
    const rawEdges: Edge[] = data.edges
      .filter((e) => e.target)
      .map((e, i) => ({
        id: `${e.source}-${e.target_username}-${i}`,
        source: e.source,
        target: e.target!,
        type: 'smoothstep',
        animated: e.colorTier === 'red',
        label: `${e.count}`,
        style: {
          stroke: TIER_HEX[e.colorTier],
          strokeWidth: Math.min(1 + Math.log2(e.count + 1), 6),
        },
        labelBgStyle: { fill: '#1c1c1c', fillOpacity: 0.85 },
        labelStyle:   { fill: TIER_HEX[e.colorTier], fontSize: 11, fontWeight: 600 },
        markerEnd: {
          type:  MarkerType.ArrowClosed,
          color: TIER_HEX[e.colorTier],
          width: 18, height: 18,
        },
        data: e,
      }));
    return { initialNodes: layoutGraph(rawNodes, rawEdges, direction), edges: rawEdges };
  }, [data, direction]);

  // Mutable copy that drag deltas apply to. Reset whenever the auto-layout
  // re-runs (data or direction changed).
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  useEffect(() => { setNodes(initialNodes); }, [initialNodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const handleNodeClick: NodeMouseHandler = useCallback((_, node) => onNodeClick(node.id), [onNodeClick]);
  const handleEdgeClick: EdgeMouseHandler = useCallback((_, edge) => onEdgeClick(edge), [onEdgeClick]);

  return (
    <div
      style={{
        height: '80vh', width: '100%',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)',
        overflow: 'hidden',
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        fitView fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2} maxZoom={2}
        proOptions={{ hideAttribution: true }}
        // A click that follows a drag shouldn't fire the channel dialog.
        // The default 0px deadzone treats every drag-release as a click.
        nodeDragThreshold={3}
      >
        <Background gap={24} color="#1a1a1a" />
        <Controls
          style={{
            background: 'var(--color-surface-1)',
            border: '1px solid var(--color-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        />
      </ReactFlow>
    </div>
  );
}
