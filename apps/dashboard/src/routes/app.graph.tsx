import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { trackingApi } from '../api/tracking';
import { GraphCanvas, type GraphLayout } from '../components/GraphCanvas';
import { GraphFilters } from '../components/GraphFilters';
import { ChannelDialog } from '../components/ChannelDialog';
import { EdgePanel } from '../components/EdgePanel';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { ErrorCallout } from '../components/channels/ChannelsUi';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, StatStrip, StatTile } from '../components/ui/primitives';
import { makeSyntheticGraph } from '../lib/graph-synthetic';
import '../components/channels/channels.css';

export const Route = createFileRoute('/app/graph')({ component: GraphPage });

function GraphPage() {
  const [filters, setFilters] = useState({
    from: '', to: '', minWeight: 1, kinds: [] as string[], includeMine: true,
  });
  const [layout, setLayout]           = useState<GraphLayout>('force');
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [openEdge, setOpenEdge]       = useState<{ sourceId: string; targetUsername: string } | null>(null);

  // DEV-only perf harness: /app/graph?synthetic=2000 renders a generated
  // graph of that many edges instead of calling the API. Dead-code-eliminated
  // from production bundles (see lib/graph-synthetic.ts).
  const syntheticN = import.meta.env.DEV
    ? Number(new URLSearchParams(window.location.search).get('synthetic') ?? 0) || 0
    : 0;
  const syntheticData = useMemo(
    () => (syntheticN ? makeSyntheticGraph(syntheticN) : null),
    [syntheticN],
  );

  const q = useQuery({
    queryKey: ['graph', filters],
    queryFn:  () => trackingApi.graph({
      from:            filters.from || undefined,
      to:              filters.to   || undefined,
      min_edge_weight: filters.minWeight,
      kind:            filters.kinds.length ? filters.kinds : undefined,
      include_mine:    filters.includeMine,
    }),
    enabled: !syntheticData,
  });

  const data = syntheticData ?? q.data;
  const isEmpty = !!data && data.nodes.length === 0;
  const showCanvas = !!data && !isEmpty;

  return (
    <div>
      <PageHeader
        eyebrow="Insights · network"
        title="Channel graph"
        subtitle="Cross-references between channels. Drag nodes to rearrange."
        actions={showCanvas ? (
          <SegmentedTabs<GraphLayout>
            value={layout}
            onChange={setLayout}
            size="sm"
            ariaLabel="Graph layout"
            options={[
              { key: 'force', label: 'Force' },
              { key: 'td',    label: 'Tree ↓' },
              { key: 'lr',    label: 'Tree →' },
            ]}
          />
        ) : undefined}
      />

      <GraphFilters {...filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />

      {!syntheticData && q.isLoading && (
        <div className="panel gr-state">
          <EmptyState icon="refresh" title="Building the channel graph…" />
        </div>
      )}
      {!syntheticData && q.error && (
        <ErrorCallout title="Couldn’t load the graph" error={q.error} />
      )}
      {isEmpty && (
        <div className="panel gr-state">
          <EmptyState
            icon="graph"
            title="No connections yet"
            note="No cross-references match the current filters. Loosen the minimum edge weight or widen the date range to surface more channels."
          />
        </div>
      )}

      {data && !isEmpty && (
        <div className="ch-stack">
          <div className="compose-rise">
            <StatStrip label="Graph size">
              <StatTile label="Nodes" value={data.nodes.length} delta="channels in view" />
              <StatTile label="Edges" value={data.edges.length} delta="cross-references" />
            </StatStrip>
          </div>

          <GraphCanvas
            data={data}
            layout={layout}
            onNodeClick={(id) => setOpenChannel(id)}
            onEdgeClick={(e) => setOpenEdge({ sourceId: e.source, targetUsername: e.target_username })}
            onLayoutFallback={() => setLayout('force')}
          />
        </div>
      )}
      {openChannel && <ChannelDialog channelId={openChannel} onClose={() => setOpenChannel(null)} />}
      {openEdge    && <EdgePanel sourceId={openEdge.sourceId} targetUsername={openEdge.targetUsername} onClose={() => setOpenEdge(null)} />}
    </div>
  );
}
