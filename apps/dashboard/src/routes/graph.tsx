import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { GraphCanvas } from '../components/GraphCanvas';
import { GraphFilters } from '../components/GraphFilters';
import { ChannelDialog } from '../components/ChannelDialog';
import { EdgePanel } from '../components/EdgePanel';
import { SegmentedTabs } from '../components/SegmentedTabs';
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
      <h1 className="text-display-md" style={{ margin: 0, marginBottom: 6 }}>Channel graph</h1>
      <p className="text-caption" style={{ color: 'var(--color-ink-muted)', margin: 0, marginBottom: 16 }}>
        Cross-references between channels. Drag nodes to rearrange.
      </p>
      <GraphFilters {...filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />

      {q.isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading graph…</p>}
      {q.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(q.error as Error).message}</p>}
      {q.data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <p className="text-caption" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{q.data.nodes.length}</span> nodes ·{' '}
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-ink)' }}>{q.data.edges.length}</span> edges · tree layout
            </p>
            <SegmentedTabs<LayoutDirection>
              value={direction}
              onChange={setDirection}
              size="sm"
              options={[
                { key: 'TB', label: 'Top → Down' },
                { key: 'LR', label: 'Left → Right' },
              ]}
            />
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
