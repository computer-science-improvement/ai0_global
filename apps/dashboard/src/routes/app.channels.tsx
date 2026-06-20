import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { trackingApi } from '../api/tracking';
import { useBots } from '../api/bots';
import { useStrategies } from '../api/strategies';
import { isLowContent } from '../lib/runway';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { AddChannelModal } from '../components/AddChannelModal';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, EmptyState } from '../components/ui/primitives';

const PAGE_SIZE = 50;

interface Search { filter: 'mine' | 'all' | 'external'; page: number; q: string; bot?: string; }

export const Route = createFileRoute('/app/channels')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    filter: (s.filter as Search['filter']) ?? 'mine',
    page:   Math.max(1, Number(s.page) || 1),
    q:      String(s.q ?? ''),
    bot:    s.bot ? String(s.bot) : undefined,
  }),
  component: ChannelsPage,
});

// «My channels» lists owned (is_mine) channels only — the publish targets.
// Tracked / competitor channels live under Intelligence (Discovery / Graph),
// so this page has no all/external tabs.
const FILTER = 'mine' as const;

function ChannelsPage() {
  const { page, q, bot } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const { data: bots } = useBots();
  const { data: strategies } = useStrategies();
  const lowContentIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of strategies ?? []) if (isLowContent(s)) set.add(s.id);
    return set;
  }, [strategies]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', FILTER, page, q, bot],
    queryFn:  () => trackingApi.listChannels({ filter: FILTER, q: q || undefined, bot, page, pageSize: PAGE_SIZE }),
  });

  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  const botFilter = bot ? bots?.find(b => b.id === bot) : null;

  const total    = data?.total ?? 0;
  const showing  = data?.items.length ?? 0;
  const isEmpty  = data != null && showing === 0;
  const filtered = Boolean(q || bot);

  // Summary of the channels visible on this page — derived from the loaded
  // items only (server paginates), surfaced as a small KPI strip.
  const items     = data?.items ?? [];
  const needsBot  = items.filter(c => c.needsBot).length;
  const paused    = items.filter(c => c.publishPaused).length;

  return (
    <div>
      <PageHeader
        title="My channels"
        subtitle="Owned channels you publish into. Each row shows its bound bot, poll tier, and live strategies."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="btn-primary"
            style={{ gap: 6, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            <Icon name="plus" size={14} /> Add channel
          </button>
        }
      />

      {/* Filter bar — search field with an inline glyph, the active bot filter
          (removable), and a live result count anchored to the right. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
          <span
            style={{
              position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
              display: 'inline-flex', color: 'var(--color-ink-dim)', pointerEvents: 'none',
            }}
          >
            <Icon name="discovery" size={15} />
          </span>
          <input
            value={q}
            onChange={(e) => setSearch({ q: e.target.value, page: 1 })}
            placeholder="Search channels…"
            className="input-field"
            style={{ width: '100%', paddingLeft: 36 }}
          />
          {q && (
            <button
              onClick={() => setSearch({ q: '', page: 1 })}
              className="btn-icon"
              title="Clear search"
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                width: 24, height: 24, color: 'var(--color-ink-muted)',
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        {botFilter && (
          <span
            className="chip is-active"
            style={{ cursor: 'pointer', gap: 6 }}
            onClick={() => setSearch({ bot: undefined, page: 1 })}
            title="Clear bot filter"
          >
            <Icon name="bots" size={11} />
            bot: {botFilter.username ?? botFilter.bot_id}
            <Icon name="x" size={11} style={{ marginLeft: 2 }} />
          </span>
        )}
        {data && (
          <span
            className="text-micro"
            style={{
              marginLeft: 'auto', color: 'var(--color-ink-dim)',
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            }}
          >
            {total === 1 ? '1 channel' : `${total.toLocaleString()} channels`}
          </span>
        )}
      </div>

      {isLoading && (
        <div
          className="card"
          style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-ink-muted)' }}
        >
          <span style={{ display: 'inline-flex', color: 'var(--color-ink-dim)' }}>
            <Icon name="refresh" size={15} />
          </span>
          <span className="text-body-sm">Loading channels…</span>
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{ display: 'flex', alignItems: 'flex-start', gap: 10, borderColor: 'var(--color-danger-soft)' }}
        >
          <span style={{ display: 'inline-flex', color: 'var(--color-danger)', flexShrink: 0, marginTop: 1 }}>
            <Icon name="warning" size={16} />
          </span>
          <div>
            <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
              Couldn’t load channels
            </div>
            <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>
              {(error as Error).message}
            </div>
          </div>
        </div>
      )}

      {isEmpty && (
        <SectionCard title="My channels" icon="channels" delay={40}>
          <EmptyState
            icon="channels"
            title={filtered ? 'No channels match your filters' : 'No channels yet'}
            note={filtered
              ? 'Try a different search term or clear the bot filter to see everything.'
              : 'Add a channel to start scheduling and publishing content into it.'}
            action={filtered ? (
              <button onClick={() => setSearch({ q: '', bot: undefined, page: 1 })} className="btn-secondary" style={{ gap: 6 }}>
                <Icon name="x" size={13} /> Clear filters
              </button>
            ) : (
              <button onClick={() => setModalOpen(true)} className="btn-primary" style={{ gap: 6 }}>
                <Icon name="plus" size={13} /> Add channel
              </button>
            )}
          />
        </SectionCard>
      )}

      {data && !isEmpty && (
        <>
          <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
            <StatTile
              label={filtered ? 'On this page' : 'Channels'}
              value={showing.toLocaleString()}
              icon="channels"
              accent
            />
            <StatTile
              label="Need a bot"
              value={needsBot.toLocaleString()}
              icon="warning"
              delta={needsBot > 0 ? 'Can’t publish' : 'All wired'}
              deltaTone={needsBot > 0 ? 'warning' : 'success'}
            />
            <StatTile
              label="Paused"
              value={paused.toLocaleString()}
              icon="pause"
              delta={paused > 0 ? 'Publishing held' : 'All live'}
              deltaTone={paused > 0 ? 'warning' : 'success'}
            />
          </div>

          <SectionCard title="My channels" icon="channels" delay={60}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.items.map((c, i) => (
                <div key={c.id} className="row-lift compose-rise" style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}>
                  <ChannelRow c={c} lowContentIds={lowContentIds} />
                </div>
              ))}
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
          </SectionCard>
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} ownership="mine" />
    </div>
  );
}
