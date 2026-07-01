import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { AddChannelModal } from '../components/AddChannelModal';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/Icon';
import { StatTile, StatusDot, EmptyState, type Tone } from '../components/ui/primitives';
import type { TrackedChannel } from '../api/types';

const PAGE_SIZE = 50;

// Tracked / competitor channels (NOT is_mine) — the intelligence side. Owned
// publish targets live under «My channels» (Publishing). This is the flat,
// manageable list that complements the Graph and Discovery views.
interface Search { page: number; q: string; }

export const Route = createFileRoute('/app/tracked')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    page: Math.max(1, Number(s.page) || 1),
    q:    String(s.q ?? ''),
  }),
  component: TrackedPage,
});

// Tracking-status presentation — a semantic tone + label per state.
// ok = tracker subscribed & polling; not_subscribed = needs the tracker to
// join before stats flow; unknown = never resolved yet.
const TRACKING_META: Record<
  TrackedChannel['trackingStatus'],
  { label: string; tone: Tone; help: string }
> = {
  ok:             { label: 'Tracking',       tone: 'success', help: 'Tracker is subscribed and polling this channel.' },
  not_subscribed: { label: 'Not subscribed', tone: 'warning', help: 'The tracker account isn’t subscribed — subscribe to start collecting stats.' },
  unknown:        { label: 'Unknown',        tone: 'neutral', help: 'Tracking state hasn’t been resolved yet.' },
};

function TrackedPage() {
  const { page, q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', 'external', page, q],
    queryFn:  () => trackingApi.listChannels({ filter: 'external', q: q || undefined, page, pageSize: PAGE_SIZE }),
  });

  const items = data?.items ?? [];
  const okCount   = items.filter((c) => c.trackingStatus === 'ok').length;
  const warnCount = items.filter((c) => c.trackingStatus === 'not_subscribed').length;

  return (
    <div>
      <PageHeader
        title="Tracked channels"
        subtitle="Other people's channels being tracked (not mine)"
        actions={
          <button onClick={() => setModalOpen(true)} className="btn-primary" style={{ gap: 6 }}>
            <Icon name="plus" size={14} /> Add channel
          </button>
        }
      />

      {/* Status tiles — at-a-glance tracking health across this page. */}
      {data && data.total > 0 && (
        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <StatTile
            label="Total tracked"
            value={data.total.toLocaleString()}
            icon="discovery"
            accent
          />
          <StatTile
            label="Tracking ok"
            value={okCount}
            delta={TRACKING_META.ok.label}
            deltaTone="success"
          />
          <StatTile
            label="Needs subscribe"
            value={warnCount}
            delta={TRACKING_META.not_subscribed.label}
            deltaTone="warning"
          />
        </div>
      )}

      {/* Search bar — paired with a tracking-status legend so the dots in the
          list (and stat strip) read unambiguously. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 20,
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-ink-dim)',
              display: 'flex',
              pointerEvents: 'none',
            }}
          >
            <Icon name="discovery" size={14} />
          </span>
          <input
            value={q}
            onChange={(e) => setSearch({ q: e.target.value, page: 1 })}
            placeholder="Search channels…"
            className="input-field"
            style={{ width: '100%', paddingLeft: 34 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {(['ok', 'not_subscribed', 'unknown'] as const).map((s) => {
            const m = TRACKING_META[s];
            return (
              <span
                key={s}
                title={m.help}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <StatusDot tone={m.tone} size={7} />
                <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{m.label}</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* Loading — skeleton rows that mirror the channel-row rhythm. */}
      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="compose-rise"
              style={{
                height: 66,
                background: 'var(--color-surface-1)',
                borderRadius: 'var(--radius-lg)',
                opacity: 0.55,
                animationDelay: `${i * 50}ms`,
              }}
            />
          ))}
        </div>
      )}

      {/* Error — a contained danger card rather than a bare line. */}
      {error && (
        <div
          className="card compose-rise"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            borderColor: 'var(--color-danger-soft)',
            background: 'var(--color-danger-soft)',
          }}
        >
          <span style={{ color: 'var(--color-danger)', display: 'flex', marginTop: 1 }}>
            <Icon name="warning" size={16} />
          </span>
          <div>
            <div className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
              Couldn’t load tracked channels
            </div>
            <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>
              {(error as Error).message}
            </div>
          </div>
        </div>
      )}

      {/* Empty — crafted zero-state medallion shared with the sibling pages. */}
      {data && data.total === 0 && (
        <EmptyState
          icon="discovery"
          title={q ? 'No channels match your search' : 'No tracked channels yet'}
          note={
            q
              ? 'Try a different name or @username, or clear the search to see everything.'
              : 'Add a competitor or reference channel to start collecting subscriber and posting intelligence.'
          }
          action={
            q ? (
              <button onClick={() => setSearch({ q: '', page: 1 })} className="btn-ghost" style={{ gap: 6 }}>
                <Icon name="x" size={13} /> Clear search
              </button>
            ) : (
              <button onClick={() => setModalOpen(true)} className="btn-primary" style={{ gap: 6 }}>
                <Icon name="plus" size={14} /> Add channel
              </button>
            )
          }
        />
      )}

      {/* List — existing ChannelRow, now with a staggered entrance. */}
      {data && data.total > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((c, i) => (
              <div
                key={c.id}
                className="compose-rise"
                style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
              >
                <ChannelRow c={c} />
              </div>
            ))}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} ownership="external" />
    </div>
  );
}
