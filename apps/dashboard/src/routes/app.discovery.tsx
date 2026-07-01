import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { trackingApi } from '../api/tracking';
import { fmtRelative } from '../lib/format';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/Icon';
import { SectionCard, StatTile, StatusDot, EmptyState } from '../components/ui/primitives';

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
        title="Discovery"
        subtitle="Channels seen in ads on tracked channels but not yet polled (closed or unresolved)."
      />

      {data && items.length > 0 && (
        <div className="stat-grid" style={{ marginBottom: 20 }}>
          <StatTile label="Open / unresolved" value={openCount} icon="discovery" accent />
          <StatTile label="Closed" value={closedCount} icon="warning" />
        </div>
      )}

      <SectionCard
        title="Discovery queue"
        icon="discovery"
        action={
          <div style={{ position: 'relative', maxWidth: 280 }}>
            <span
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'inline-flex',
                color: 'var(--color-ink-dim)',
                pointerEvents: 'none',
              }}
            >
              <Icon name="discovery" size={15} />
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by username…"
              className="input-field"
              style={{ width: '100%', paddingLeft: 34 }}
              disabled={isLoading || !!error || items.length === 0}
            />
          </div>
        }
      >
        {isLoading && <LoadingState />}

        {error && (
          <EmptyState
            icon="warning"
            title="Couldn't load the discovery queue"
            note={(error as Error).message}
          />
        )}

        {data && items.length === 0 && (
          <EmptyState
            icon="discovery"
            title="Nothing in the queue right now"
            note="New channels surface here as they're spotted in ads on tracked channels. Check back later."
          />
        )}

        {data && items.length > 0 && filtered.length === 0 && (
          <EmptyState
            icon="discovery"
            title="No matches"
            note={`No queued channel matches “${q.trim()}”.`}
          />
        )}

        {data && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map((it, i) => (
              <ResultRow key={it.id} item={it} index={i} />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/** A single discovered-channel row — patch-bay card with identity, status dot, and meta. */
function ResultRow({ item, index }: { item: DiscoveryItem; index: number }) {
  const hasUsername = !!item.username;
  const tgUrl = hasUsername ? `https://t.me/${item.username}` : null;

  return (
    <div
      className="card row-lift compose-rise"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 16px',
        animationDelay: `${Math.min(index, 12) * 40}ms`,
      }}
    >
      {/* Status dot — accent = still open/pollable, danger = closed. */}
      <span
        title={item.isClosed ? 'Channel is closed' : 'Open / unresolved'}
        style={{ flexShrink: 0, display: 'inline-flex' }}
      >
        <StatusDot tone={item.isClosed ? 'danger' : 'accent'} />
      </span>

      {/* Identity */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            className="text-body-sm tabular-nums"
            style={{
              fontWeight: 500,
              color: hasUsername ? 'var(--color-ink)' : 'var(--color-ink-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {hasUsername ? `@${item.username}` : '(no username)'}
          </span>
          {item.isClosed && <span className="chip chip-danger">closed</span>}
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 3 }}>
          seen {fmtRelative(item.addedAt)}
        </div>
      </div>

      {/* Action — open on Telegram when we have a handle to resolve. */}
      {tgUrl ? (
        <a
          href={tgUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-tiny"
          style={{ flexShrink: 0, gap: 5 }}
          onClick={(e) => e.stopPropagation()}
        >
          Open on Telegram
          <Icon name="chevron-right" size={12} />
        </a>
      ) : (
        <span className="text-micro" style={{ flexShrink: 0, color: 'var(--color-ink-dim)' }}>
          unresolved
        </span>
      )}
    </div>
  );
}

/** Skeleton placeholder rows while the queue loads. */
function LoadingState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="card"
          style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px' }}
        >
          <span
            style={{ width: 8, height: 8, borderRadius: 'var(--radius-pill)', background: 'var(--color-surface-3)' }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                height: 12,
                width: `${42 - i * 6}%`,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface-3)',
                opacity: 0.7,
              }}
            />
            <div
              style={{
                height: 9,
                width: '24%',
                marginTop: 8,
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface-2)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
