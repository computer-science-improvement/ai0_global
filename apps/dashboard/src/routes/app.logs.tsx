// Logs / activity feed. Read-only union of strategy runs + scheduled posts
// (GET /activity). Platform filter (Telegram active; Meta/TikTok disabled) +
// activity-type filter + "load more" pagination.

import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Badge } from '../components/ui/Badge';
import { Placeholder } from '../components/ui/Placeholder';
import { Icon, type IconName } from '../components/ui/Icon';
import { activityApi } from '../api/activity';
import { fmtDate } from '../lib/format';
import type { ActivityType } from '../api/types';

export const Route = createFileRoute('/app/logs')({ component: LogsPage });

const PAGE = 50;

type TypeFilter = ActivityType | 'all';

const TYPE_TABS: ReadonlyArray<{ key: TypeFilter; label: string }> = [
  { key: 'all',     label: 'All' },
  { key: 'posted',  label: 'Posts' },
  { key: 'error',   label: 'Errors' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'running', label: 'Running' },
];

const TYPE_META: Record<ActivityType, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  posted:  { label: 'Posted',  tone: 'success' },
  error:   { label: 'Error',   tone: 'danger'  },
  skipped: { label: 'Skipped', tone: 'warning' },
  running: { label: 'Running', tone: 'neutral' },
};

// Page-local platform chooser — mirrors the header/connections grouping.
const PLATFORMS: ReadonlyArray<{ key: string; label: string; icon: IconName; enabled: boolean }> = [
  { key: 'telegram', label: 'Telegram', icon: 'telegram', enabled: true },
  { key: 'meta',     label: 'Meta',     icon: 'facebook', enabled: true },
  { key: 'tiktok',   label: 'TikTok',   icon: 'tiktok',   enabled: true },
];

function PlatformChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {PLATFORMS.map((p) => {
        const active = value === p.key;
        return (
          <button
            key={p.key}
            disabled={!p.enabled}
            onClick={() => p.enabled && onChange(p.key)}
            title={p.enabled ? p.label : `${p.label} — soon`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 12, padding: '5px 11px', borderRadius: 'var(--radius-sm)',
              border: `1px solid ${active ? 'rgba(62,207,142,0.3)' : 'transparent'}`,
              background: active ? 'var(--color-success-soft)' : 'transparent',
              color: active ? 'var(--color-accent)' : p.enabled ? 'var(--color-ink-muted)' : 'var(--color-ink-dim)',
              cursor: p.enabled ? 'pointer' : 'not-allowed', opacity: p.enabled ? 1 : 0.6,
            }}
          >
            <Icon name={p.icon} size={13} />{p.label}
          </button>
        );
      })}
    </div>
  );
}

function LogsPage() {
  const [platform, setPlatform] = useState('telegram');
  const [type, setType] = useState<TypeFilter>('all');

  const q = useInfiniteQuery({
    queryKey: ['activity', platform, type],
    queryFn: ({ pageParam = 0 }) =>
      activityApi.list({ platform, type: type === 'all' ? null : type, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const detailText = (durationMs: number | null, detail: string | null) => {
    if (detail) return detail;
    if (durationMs != null) return `${(durationMs / 1000).toFixed(1)} s`;
    return '—';
  };

  return (
    <div>
      <PageHeader title="Logs" subtitle="Automation activity — posts, errors, skips" />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <PlatformChips value={platform} onChange={setPlatform} />
        <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
          <SegmentedTabs value={type} onChange={setType} options={TYPE_TABS} />
        </div>
      </div>

      {q.isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {q.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(q.error as Error).message}</p>}

      {!q.isLoading && !q.error && items.length === 0 && (
        <Placeholder icon="logs" title="Nothing here yet" note="Activity will appear after strategies run or scheduled posts are published." />
      )}

      {items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>Time</th><th>Type</th><th>Destination</th><th>Strategy</th><th>Details</th>
              </tr></thead>
              <tbody>
                {items.map((e) => {
                  const m = TYPE_META[e.type];
                  return (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtDate(e.at)}</td>
                      <td><Badge tone={m.tone}>{m.label}</Badge></td>
                      <td>{e.channel ?? '—'}</td>
                      <td className="meta">{e.strategy ?? '—'}</td>
                      <td className="meta" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.detail ?? undefined}>
                        {detailText(e.durationMs, e.detail)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {q.hasNextPage && (
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
              <button className="btn-secondary" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
