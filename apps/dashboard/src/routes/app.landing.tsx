// Operator landing config — /app/landing. Editor + live-preview split. The
// left column lets operators pick which resources are featured on the PUBLIC
// landing (/) and order them; the right column renders the exact same
// ResourceShowcase fed the currently-visible set, sorted by landingOrder.
//
// Ordering is a SINGLE flat list across all platforms (the public landing is
// one ordered grid). Moving an item up/down swaps its landingOrder with the
// adjacent VISIBLE item via TWO setFeatured mutations — one per item.

import type { JSX } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Icon, type IconName } from '../components/ui/Icon';
import { ResourceShowcase } from '../components/landing/ResourceShowcase';
import {
  useLandingAdmin, useSetFeatured,
  type LandingAdminResource, type LandingPlatform,
} from '../api/landing';

export const Route = createFileRoute('/app/landing')({
  component: LandingAdminPage,
});

const PLATFORM_ORDER: LandingPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'];
const PLATFORM_META: Record<LandingPlatform, { icon: IconName; label: string }> = {
  telegram:  { icon: 'telegram',  label: 'Telegram' },
  instagram: { icon: 'instagram', label: 'Instagram' },
  facebook:  { icon: 'facebook',  label: 'Facebook' },
  threads:   { icon: 'threads',   label: 'Threads' },
  tiktok:    { icon: 'tiktok',    label: 'TikTok' },
};

function fmtFollowers(n: number): string {
  if (n < 1_000) return String(n);
  const f = (v: number, s: string) => `${v.toFixed(1).replace(/\.0$/, '')}${s}`;
  if (n < 1_000_000) return f(n / 1_000, 'K');
  if (n < 1_000_000_000) return f(n / 1_000_000, 'M');
  return f(n / 1_000_000_000, 'B');
}

function LandingAdminPage(): JSX.Element {
  const { data, isLoading, error } = useLandingAdmin();
  const setFeatured = useSetFeatured();

  const all = data ?? [];

  // The flat ordered list of currently-visible resources — this is what the
  // public landing renders, and what up/down ordering operates over.
  const visibleSorted = [...all]
    .filter((r) => r.landingVisible)
    .sort((a, b) => a.order - b.order);

  // preview feed: pass admin resources straight through (ResourceShowcase only
  // reads LandingResource fields; the extra id/landingVisible are harmless).
  const preview = visibleSorted;

  const toggleVisible = (r: LandingAdminResource) => {
    setFeatured.mutate({
      platform: r.platform,
      id: r.id,
      landingVisible: !r.landingVisible,
      landingOrder: r.order,
    });
  };

  // Swap landingOrder with the adjacent visible item via two mutations.
  const move = (r: LandingAdminResource, dir: -1 | 1) => {
    const idx = visibleSorted.findIndex((v) => v.platform === r.platform && v.id === r.id);
    if (idx < 0) return;
    const neighbor = visibleSorted[idx + dir];
    if (!neighbor) return;
    setFeatured.mutate({
      platform: r.platform, id: r.id,
      landingVisible: r.landingVisible, landingOrder: neighbor.order,
    });
    setFeatured.mutate({
      platform: neighbor.platform, id: neighbor.id,
      landingVisible: neighbor.landingVisible, landingOrder: r.order,
    });
  };

  // Group all candidate resources by platform, preserving PLATFORM_ORDER.
  const groups = PLATFORM_ORDER
    .map((p) => ({ platform: p, items: all.filter((r) => r.platform === p) }))
    .filter((g) => g.items.length > 0);

  const visibleIndex = (r: LandingAdminResource) =>
    visibleSorted.findIndex((v) => v.platform === r.platform && v.id === r.id);

  return (
    <div className="la-wrap">
      <div className="la-editor">
        <PageHeader
          title="Landing"
          subtitle="Choose which resources appear on the public landing page and their order."
        />

        {isLoading && (
          <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>
        )}
        {error && (
          <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>
            {(error as Error).message}
          </p>
        )}

        {!isLoading && !error && groups.length === 0 && (
          <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            No candidate resources yet.
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {groups.map((g) => {
            const meta = PLATFORM_META[g.platform];
            return (
              <Panel
                key={g.platform}
                title={`${meta.label} · ${g.items.length}`}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {g.items.map((r) => {
                    const vIdx = visibleIndex(r);
                    const isFirst = vIdx === 0;
                    const isLast = vIdx === visibleSorted.length - 1;
                    return (
                      <div key={r.id} className="la-row">
                        <span className="la-row-icon"><Icon name={meta.icon} size={16} /></span>

                        <div className="la-row-main">
                          <span className="text-body-sm la-row-name">
                            {r.displayName ?? (r.handle ? `@${r.handle}` : meta.label)}
                          </span>
                          <span className="text-micro la-row-sub">
                            {r.handle && <span>@{r.handle}</span>}
                            {r.followerCount !== null && (
                              <span>{r.handle ? ' · ' : ''}{fmtFollowers(r.followerCount)} followers</span>
                            )}
                          </span>
                        </div>

                        <div className="la-row-actions">
                          {r.landingVisible && (
                            <>
                              <Button
                                variant="tiny"
                                title="Move up"
                                disabled={isFirst}
                                onClick={() => move(r, -1)}
                              >▲</Button>
                              <Button
                                variant="tiny"
                                title="Move down"
                                disabled={isLast}
                                onClick={() => move(r, 1)}
                              >▼</Button>
                            </>
                          )}
                          <Button
                            variant={r.landingVisible ? 'secondary' : 'tiny'}
                            onClick={() => toggleVisible(r)}
                          >
                            {r.landingVisible ? (
                              <><Icon name="check" size={12} /> Featured</>
                            ) : 'Feature'}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            );
          })}
        </div>
      </div>

      <div className="la-preview">
        <Panel title="Live preview">
          <p className="text-micro" style={{ margin: '0 0 12px', color: 'var(--color-ink-dim)' }}>
            Mirrors the public landing page at <code>/</code>.
          </p>
          <ResourceShowcase resources={preview} />
        </Panel>
      </div>

      <style>{`
        .la-wrap {
          display: grid;
          grid-template-columns: minmax(360px, 1fr) minmax(360px, 1.1fr);
          gap: var(--space-xl);
          align-items: start;
        }
        @media (max-width: 1024px) {
          .la-wrap { grid-template-columns: 1fr; }
        }
        .la-preview { position: sticky; top: var(--space-lg); }
        .la-row {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 12px;
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          border-radius: var(--radius-md);
        }
        .la-row-icon {
          display: inline-flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; flex-shrink: 0;
          border-radius: var(--radius-sm);
          background: var(--color-surface-3);
          color: var(--color-ink-muted);
        }
        .la-row-main {
          flex: 1; min-width: 0;
          display: flex; flex-direction: column; gap: 2px;
        }
        .la-row-name {
          color: var(--color-ink);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .la-row-sub { color: var(--color-ink-dim); }
        .la-row-actions {
          display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}
