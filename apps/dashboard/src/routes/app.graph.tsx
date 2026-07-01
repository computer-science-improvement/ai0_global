import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { GraphCanvas } from '../components/GraphCanvas';
import { GraphFilters } from '../components/GraphFilters';
import { ChannelDialog } from '../components/ChannelDialog';
import { EdgePanel } from '../components/EdgePanel';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/Icon';
import type { GraphEdge } from '../api/types';
import type { LayoutDirection } from '../lib/graph-layout';

export const Route = createFileRoute('/app/graph')({ component: GraphPage });

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

  const isEmpty = !!q.data && q.data.nodes.length === 0;

  return (
    <div>
      <PageHeader
        title="Channel graph"
        subtitle="Cross-references between channels. Drag nodes to rearrange."
      />

      <GraphFilters {...filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />

      {q.isLoading && <LoadingState />}
      {q.error && (
        <StatusCard
          icon="warning"
          tone="danger"
          title="Couldn’t load the graph"
          body={(q.error as Error).message}
        />
      )}
      {isEmpty && (
        <StatusCard
          icon="graph"
          tone="muted"
          title="No connections yet"
          body="No cross-references match the current filters. Loosen the minimum edge weight or widen the date range to surface more channels."
        />
      )}

      {q.data && !isEmpty && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <Metric value={q.data.nodes.length} label="nodes" />
              <span style={{ width: 1, height: 22, background: 'var(--color-hairline)' }} />
              <Metric value={q.data.edges.length} label="edges" />
              <span style={{ width: 1, height: 22, background: 'var(--color-hairline)' }} />
              <span className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>tree layout</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="text-caption" style={{ color: 'var(--color-ink-dim)' }}>Direction</span>
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

/** Inline summary stat — bold tabular count paired with a muted label. */
function Metric({ value, label }: { value: number; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span
        className="tabular-nums"
        style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-ink)' }}
      >
        {value}
      </span>
      <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>{label}</span>
    </span>
  );
}

/** Skeleton placeholder framing while the graph data resolves. */
function LoadingState() {
  return (
    <div
      className="card"
      style={{
        height: 360,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 48,
          height: 48,
          borderRadius: 'var(--radius-lg)',
          border: '1.5px dashed var(--color-hairline-strong)',
          color: 'var(--color-ink-dim)',
        }}
      >
        <Icon name="graph" size={22} />
      </span>
      <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
        Building the channel graph…
      </p>
    </div>
  );
}

/** Crafted empty / error panel with a dashed icon medallion. */
function StatusCard({
  icon,
  tone,
  title,
  body,
}: {
  icon: 'graph' | 'warning';
  tone: 'muted' | 'danger';
  title: string;
  body: string;
}) {
  const danger = tone === 'danger';
  return (
    <div
      className="card"
      style={{ textAlign: 'center', padding: '44px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 48,
          height: 48,
          borderRadius: 'var(--radius-lg)',
          border: `1.5px dashed ${danger ? 'var(--color-danger)' : 'var(--color-hairline-strong)'}`,
          color: danger ? 'var(--color-danger)' : 'var(--color-ink-dim)',
          marginBottom: 16,
        }}
      >
        <Icon name={icon} size={22} />
      </span>
      <p className="text-body" style={{ margin: 0, color: 'var(--color-ink)', fontWeight: 500 }}>
        {title}
      </p>
      <p
        className="text-body-sm"
        style={{ margin: '6px 0 0', maxWidth: 420, color: danger ? 'var(--color-danger)' : 'var(--color-ink-muted)' }}
      >
        {body}
      </p>
    </div>
  );
}
