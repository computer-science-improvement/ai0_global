// Operator landing config — /app/landing. Editor + live-preview split. The
// left column lets operators pick which resources are featured on the PUBLIC
// landing (/) and order them; the right column renders the exact same
// ResourceShowcase fed the currently-visible set, sorted by landingOrder.
//
// Ordering is a SINGLE flat list across all platforms (the public landing is
// one ordered grid). Moving an item up/down RENUMBERS the whole visible list
// to sequential indexes (only rows whose stored order changed get PATCHed) —
// a naive two-row swap breaks on the default data where every row still has
// landing_order = 0: swapping 0 with 0 is a no-op and the arrows appear dead.
// All actions are disabled while a mutation is in flight so a double-click
// can't interleave two half-finished reorders.

import type { JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { TableAction } from '../components/ui/table';
import { EmptyState } from '../components/ui/primitives';
import { Icon, type IconName } from '../components/ui/Icon';
import { ResourceShowcase } from '../components/landing/ResourceShowcase';
import { PublicPageCard } from '../components/landing/PublicPageCard';
import {
  landingApi, useLandingAdmin, useSetFeatured,
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
  const qc = useQueryClient();

  const all = data ?? [];

  // The flat ordered list of currently-visible resources — this is what the
  // public landing renders, and what up/down ordering operates over.
  const visibleSorted = [...all]
    .filter((r) => r.landingVisible)
    .sort((a, b) => a.order - b.order);

  // preview feed: pass admin resources straight through (ResourceShowcase only
  // reads LandingResource fields; the extra id/landingVisible are harmless).
  const preview = visibleSorted;

  // Batched reorder: PATCH every row whose stored order changed, then refetch
  // ONCE. One react-query mutation → one pending flag, no interleaving.
  const reorder = useMutation({
    mutationFn: async (updates: Array<{ platform: LandingPlatform; id: string; landingOrder: number }>) => {
      for (const u of updates) {
        await landingApi.setFeatured(u.platform, u.id, { landingVisible: true, landingOrder: u.landingOrder });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['landing', 'admin'] });
      qc.invalidateQueries({ queryKey: ['landing', 'resources'] });
    },
  });

  const pending = setFeatured.isPending || reorder.isPending;

  const toggleVisible = (r: LandingAdminResource) => {
    // Newly-featured resources append at the END of the flat order (max+1) —
    // keeping r.order would drop them at 0 and shuffle the existing grid.
    const nextOrder = r.landingVisible
      ? r.order
      : visibleSorted.length > 0
        ? Math.max(...visibleSorted.map((v) => v.order)) + 1
        : 0;
    setFeatured.mutate({
      platform: r.platform,
      id: r.id,
      landingVisible: !r.landingVisible,
      landingOrder: nextOrder,
    });
  };

  // Move = swap positions in the list, then renumber EVERY visible row to its
  // index. Renumbering (instead of swapping two order values) also heals the
  // degenerate default state where all rows share landing_order = 0.
  const move = (r: LandingAdminResource, dir: -1 | 1) => {
    const idx = visibleSorted.findIndex((v) => v.platform === r.platform && v.id === r.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= visibleSorted.length) return;
    const next = [...visibleSorted];
    [next[idx], next[j]] = [next[j], next[idx]];
    const updates = next
      .map((v, i) => ({ platform: v.platform, id: v.id, landingOrder: i, stored: v.order }))
      .filter((u) => u.stored !== u.landingOrder)
      .map(({ platform, id, landingOrder }) => ({ platform, id, landingOrder }));
    if (updates.length > 0) reorder.mutate(updates);
  };

  // Group all candidate resources by platform, preserving PLATFORM_ORDER.
  const groups = PLATFORM_ORDER
    .map((p) => ({ platform: p, items: all.filter((r) => r.platform === p) }))
    .filter((g) => g.items.length > 0);

  const visibleIndex = (r: LandingAdminResource) =>
    visibleSorted.findIndex((v) => v.platform === r.platform && v.id === r.id);

  return (
    <div>
      <PageHeader
        title="Landing"
        subtitle="How the public landing page takes ad orders, and which resources it shows in which order."
        actions={
          <a href="/" target="_blank" rel="noopener noreferrer" className="btn-ghost" style={{ gap: 6 }}>
            Open live page <span aria-hidden>↗</span>
          </a>
        }
      />

      <div style={{ marginBottom: 'var(--space-xl)' }}>
        <PublicPageCard />
      </div>

      <div className="la-wrap">
        <div className="la-editor">
          {/* Loading — skeleton rows mirroring the editor-row rhythm. */}
          {isLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="la-skeleton" style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          )}

          {/* Error — contained danger card, same pattern as the list pages. */}
          {error && (
            <div
              className="card"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                borderColor: 'var(--color-danger-soft)', background: 'var(--color-danger-soft)',
              }}
            >
              <span style={{ color: 'var(--color-danger)', display: 'flex', marginTop: 1 }}>
                <Icon name="warning" size={16} />
              </span>
              <div>
                <div className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                  Couldn’t load landing resources
                </div>
                <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>
                  {(error as Error).message}
                </div>
              </div>
            </div>
          )}

          {!isLoading && !error && groups.length === 0 && (
            <EmptyState
              icon="connections"
              title="No candidate resources yet"
              note="Connect channels and accounts under Connections — anything with a public profile becomes a landing candidate."
            />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groups.map((g) => {
              const meta = PLATFORM_META[g.platform];
              const featuredCount = g.items.filter((r) => r.landingVisible).length;
              return (
                <Panel
                  key={g.platform}
                  title={meta.label}
                  action={
                    <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
                      {featuredCount}/{g.items.length} featured
                    </span>
                  }
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {g.items.map((r) => {
                      const vIdx = visibleIndex(r);
                      const isFirst = vIdx === 0;
                      const isLast = vIdx === visibleSorted.length - 1;
                      return (
                        <div key={r.id} className={`la-row${r.landingVisible ? ' la-row-featured' : ''}`}>
                          <span className="la-avatar">
                            {r.avatarUrl ? (
                              <img src={r.avatarUrl} alt="" className="la-avatar-img" loading="lazy" />
                            ) : (
                              <Icon name={meta.icon} size={15} />
                            )}
                          </span>

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
                                <span title="Position on the public landing (one flat order across platforms)">
                                  <Badge tone="accent">#{vIdx + 1} on landing</Badge>
                                </span>
                                <TableAction
                                  icon="chevron-up"
                                  title="Move up"
                                  disabled={isFirst || pending}
                                  onClick={() => move(r, -1)}
                                />
                                <TableAction
                                  icon="chevron-down"
                                  title="Move down"
                                  disabled={isLast || pending}
                                  onClick={() => move(r, 1)}
                                />
                                <TableAction
                                  action="pause"
                                  title="Hide from the landing"
                                  disabled={pending}
                                  onClick={() => toggleVisible(r)}
                                />
                              </>
                            )}
                            {!r.landingVisible && (
                              <TableAction
                                action="enable"
                                title="Feature on the landing"
                                disabled={pending}
                                onClick={() => toggleVisible(r)}
                              />
                            )}
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
          <Panel
            title="Live preview"
            action={
              preview.length > 0 ? (
                <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
                  {preview.length} featured
                </span>
              ) : undefined
            }
          >
            <p className="text-micro" style={{ margin: '0 0 12px', color: 'var(--color-ink-dim)' }}>
              The same as the public landing page at <code>/</code> — same component, same order.
            </p>
            <ResourceShowcase resources={preview} />
          </Panel>
        </div>
      </div>

      <style>{`
        .la-wrap {
          display: grid;
          grid-template-columns: minmax(360px, 1fr) minmax(360px, 1.1fr);
          gap: var(--space-xl);
          align-items: start;
        }
        @media (max-width: 1024px) {
          .la-wrap { grid-template-columns: minmax(0, 1fr); }
        }
        .la-preview { position: sticky; top: var(--space-lg); }
        .la-row {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 12px;
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          border-radius: var(--radius-md);
          transition: opacity 0.15s ease, border-color 0.15s ease;
        }
        /* Hidden-from-landing rows recede; featured rows carry a faint accent edge. */
        .la-row:not(.la-row-featured) { opacity: 0.72; }
        .la-row:not(.la-row-featured):hover { opacity: 1; }
        .la-row-featured {
          border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-hairline));
        }
        .la-avatar {
          display: inline-flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; flex-shrink: 0;
          border-radius: var(--radius-sm);
          background: var(--color-surface-3);
          border: 1px solid var(--color-hairline);
          color: var(--color-ink-muted);
          overflow: hidden;
        }
        .la-avatar-img { width: 100%; height: 100%; object-fit: cover; }
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
        .la-skeleton {
          height: 54px; border-radius: var(--radius-md);
          background: linear-gradient(90deg, var(--color-surface-2) 25%, var(--color-surface-3) 50%, var(--color-surface-2) 75%);
          background-size: 200% 100%;
          border: 1px solid var(--color-hairline);
          animation: la-shimmer 1.6s ease-in-out infinite;
        }
        @keyframes la-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
      `}</style>
    </div>
  );
}
