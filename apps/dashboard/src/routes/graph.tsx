import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { GraphCanvas } from '../components/GraphCanvas';
import { GraphFilters } from '../components/GraphFilters';
import { ChannelDialog } from '../components/ChannelDialog';
import { EdgePanel } from '../components/EdgePanel';
import type { GraphEdge } from '../api/types';
import type { LayoutDirection } from '../lib/graph-layout';

export const Route = createFileRoute('/graph')({ component: GraphPage });

function GraphPage() {
  const [filters, setFilters] = useState({
    from: '', to: '', minWeight: 1, kinds: [] as string[], includeMine: true,
  });
  const [direction, setDirection]     = useState<LayoutDirection>('TB');
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [openEdge, setOpenEdge]       = useState<{ sourceId: string; targetUsername: string } | null>(null);

  const q = useQuery({
    queryKey: ['graph', filters],
    queryFn:  () => trackingApi.graph({
      from:            filters.from || undefined,
      to:              filters.to   || undefined,
      min_edge_weight: filters.minWeight,
      kind:            filters.kinds.length ? filters.kinds : undefined,
      include_mine:    filters.includeMine,
    }),
  });

  return (
    <div>
      <h1 className="text-display-md" style={{ marginBottom: 12 }}>Channel graph</h1>
      <GraphFilters {...filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />

      {q.isLoading && <p style={{ color: 'var(--color-ink-muted)' }}>Loading graph…</p>}
      {q.error && <p style={{ color: 'var(--color-danger)' }}>{(q.error as Error).message}</p>}
      {q.data && (
        <>
          <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
            <p style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
              {q.data.nodes.length} nodes · {q.data.edges.length} edges · tree layout
            </p>
            <LayoutDirectionToggle value={direction} onChange={setDirection} />
          </div>
          <GraphCanvas
            data={q.data}
            direction={direction}
            onNodeClick={(id) => setOpenChannel(id)}
            onEdgeClick={(e) => setOpenEdge({ sourceId: e.source, targetUsername: (e.data as GraphEdge).target_username })}
          />
        </>
      )}
      {openChannel && <ChannelDialog channelId={openChannel} onClose={() => setOpenChannel(null)} />}
      {openEdge    && <EdgePanel sourceId={openEdge.sourceId} targetUsername={openEdge.targetUsername} onClose={() => setOpenEdge(null)} />}
    </div>
  );
}

/** Segmented control: tree direction (top-down vs left-right). */
function LayoutDirectionToggle({ value, onChange }: { value: LayoutDirection; onChange: (v: LayoutDirection) => void }) {
  const opts: Array<{ key: LayoutDirection; label: string }> = [
    { key: 'TB', label: 'Top → Down' },
    { key: 'LR', label: 'Left → Right' },
  ];
  return (
    <div
      className="flex p-1 text-[12px]"
      style={{
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-pill)',
      }}
    >
      {opts.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className="rounded-full px-3 py-1 transition-colors"
          style={{
            background: value === o.key ? 'var(--color-surface-2)' : 'transparent',
            color:      value === o.key ? 'var(--color-ink)'        : 'var(--color-ink-muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
