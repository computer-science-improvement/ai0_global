import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { trackingApi } from '../api/tracking';
import { fmtRelative } from '../lib/format';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, StatStrip, StatTile, StatusDot, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { ErrorCallout, ListSkeleton, SearchField } from '../components/channels/ChannelsUi';

export const Route = createFileRoute('/app/discovery')({ component: DiscoveryPage });

type DiscoveryItem = { id: string; username: string | null; isClosed: boolean; addedAt: string };

function DiscoveryPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['discovery'], queryFn: () => trackingApi.discovery() });
  const [q, setQ] = useState('');

  const items = (data?.items ?? []) as DiscoveryItem[];

  // Client-side narrowing only — no route search schema, no extra requests.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((it) => (it.username ?? '').toLowerCase().includes(needle));
  }, [items, q]);

  const closedCount = items.filter((it) => it.isClosed).length;
  const openCount = items.length - closedCount;

  return (
    <div>
      <PageHeader
        eyebrow="Insights · competitors"
        title="Discovery"
        subtitle="Channels seen in ads on tracked channels but not yet polled (closed or unresolved)."
      />

      {error && <ErrorCallout title="Couldn’t load the discovery queue" message={(error as Error).message} />}

      <div className="ch-stack">
        {data && items.length > 0 && (
          <div className="compose-rise">
            <StatStrip label="Discovery queue">
              <StatTile label="Open / unresolved" value={openCount} />
              <StatTile label="Closed" value={closedCount} />
            </StatStrip>
          </div>
        )}

        {!error && (
          <SectionCard
            title="Discovery queue"
            flush
            delay={60}
            action={
              <SearchField
                value={q}
                onChange={setQ}
                placeholder="Filter by username…"
                label="Filter the queue by username"
                disabled={isLoading || items.length === 0}
                style={{ width: 260, maxWidth: '100%' }}
              />
            }
          >
            {isLoading && <ListSkeleton rows={4} />}

            {data && items.length === 0 && (
              <EmptyState
                icon="search"
                title="Nothing in the queue right now"
                note="New channels surface here as they're spotted in ads on tracked channels. Check back later."
              />
            )}

            {data && items.length > 0 && filtered.length === 0 && (
              <EmptyState
                icon="search"
                title="No matches"
                note={`No queued channel matches “${q.trim()}”.`}
              />
            )}

            {filtered.map((it) => <ResultRow key={it.id} item={it} />)}
          </SectionCard>
        )}
      </div>
    </div>
  );
}

/** A single discovered channel: status dot, @username with a "closed" badge, when it was seen, and a way to open it. */
function ResultRow({ item }: { item: DiscoveryItem }) {
  const hasUsername = !!item.username;
  const tgUrl = hasUsername ? `https://t.me/${item.username}` : null;

  return (
    <div className="panel-row">
      {/* Status dot — accent = still open/pollable, danger = closed. */}
      <span
        title={item.isClosed ? 'Channel is closed' : 'Open / unresolved'}
        style={{ flexShrink: 0, display: 'inline-flex' }}
      >
        <StatusDot tone={item.isClosed ? 'danger' : 'accent'} />
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ch-row-title">
          <span className={`mono ch-row-name${hasUsername ? '' : ' ch-faint'}`}>
            {hasUsername ? `@${item.username}` : '(no username)'}
          </span>
          {item.isClosed && <Badge tone="danger">closed</Badge>}
        </div>
        <div className="mono ch-row-sub">seen {fmtRelative(item.addedAt)}</div>
      </div>

      {/* Action — open on Telegram when we have a handle to resolve. */}
      {tgUrl ? (
        <a
          href={tgUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-tiny"
          style={{ flexShrink: 0, gap: 5 }}
        >
          Open on Telegram
          <Icon name="chevron-right" size={12} />
        </a>
      ) : (
        <span className="text-micro ch-faint" style={{ flexShrink: 0 }}>
          unresolved
        </span>
      )}
    </div>
  );
}
