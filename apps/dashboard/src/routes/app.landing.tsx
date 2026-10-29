// Operator landing config — /app/landing. Editor + live-preview split. The
// left column lets operators pick which resources are featured on the PUBLIC
// landing (/) and order them, and edit each network's blurb and order (spec 026
// FR-015); the right column renders the exact same NetworkShowcase the public
// page renders, fed the server's own preview of GET /api/landing/networks.
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
import { Badge } from '../components/ui/Badge';
import { TableAction } from '../components/ui/table';
import { EmptyState, SectionCard } from '../components/ui/primitives';
import { Icon, type IconName } from '../components/ui/Icon';
import { NetworkShowcase } from '../components/landing/NetworkShowcase';
import { NetworksCard } from '../components/landing/NetworksCard';
import { PublicPageCard } from '../components/landing/PublicPageCard';
import { CtaStatsCard } from '../components/landing/CtaStatsCard';
import { LeadsCard } from '../components/landing/LeadsCard';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SkeletonRows } from '../components/SkeletonRows';
import {
  landingApi, useLandingAdmin, useLandingAdminNetworks, useSetFeatured,
  type LandingAdminResource, type LandingPlatform,
} from '../api/landing';
import { PLATFORM_META as PUBLIC_PLATFORM_META, PLATFORM_ORDER as PUBLIC_PLATFORM_ORDER } from '../lib/landing-view';
import { describeError } from '../components/ui/Toast';
import '../components/landing/landing-admin.css';

// Tabs (spec 026 FR-015): the page setup, the leads from the public forms and the CTA stats.
type LandingTab = 'page' | 'leads' | 'stats';
const LANDING_TABS: ReadonlyArray<{ key: LandingTab; label: string }> = [
  { key: 'page',  label: 'Page setup' },
  { key: 'leads', label: 'Leads' },
  { key: 'stats', label: 'CTA stats' },
];

export const Route = createFileRoute('/app/landing')({
  validateSearch: (s: Record<string, unknown>): { tab?: LandingTab } =>
    LANDING_TABS.some((t) => t.key === s.tab) && s.tab !== 'page' ? { tab: s.tab as LandingTab } : {},
  component: LandingAdminPage,
});

const PLATFORM_ORDER: readonly LandingPlatform[] = PUBLIC_PLATFORM_ORDER;
const PLATFORM_META: Record<LandingPlatform, { icon: IconName; label: string }> = PUBLIC_PLATFORM_META;

function fmtFollowers(n: number): string {
  if (n < 1_000) return String(n);
  const f = (v: number, s: string) => `${v.toFixed(1).replace(/\.0$/, '')}${s}`;
  if (n < 1_000_000) return f(n / 1_000, 'K');
  if (n < 1_000_000_000) return f(n / 1_000_000, 'M');
  return f(n / 1_000_000_000, 'B');
}

function LandingAdminPage(): JSX.Element {
  const tab: LandingTab = Route.useSearch().tab ?? 'page';
  const navigate = Route.useNavigate();
  const setTab = (t: LandingTab) => navigate({ search: t === 'page' ? {} : { tab: t }, replace: true });
  return (
    <div>
      <PageHeader
        eyebrow="Public site"
        title="Landing"
        subtitle="How the public landing page takes ad orders, which resources it shows in which order, and what visitors do."
        actions={
          <a href="/" target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm" style={{ gap: 6 }}>
            Open live page <Icon name="external" size={13} />
          </a>
        }
      />
      <div style={{ marginBottom: 'var(--space-xl)' }}>
        <SegmentedTabs<LandingTab> variant="underline" ariaLabel="Landing sections" value={tab} onChange={setTab} options={LANDING_TABS} />
      </div>
      {tab === 'page' && <PageSetup />}
      {tab === 'leads' && <LeadsCard />}
      {tab === 'stats' && <CtaStatsCard />}
    </div>
  );
}

function PageSetup(): JSX.Element {
  const { data, isLoading, error } = useLandingAdmin();
  const networks = useLandingAdminNetworks();
  const setFeatured = useSetFeatured();
  const qc = useQueryClient();

  const all = data ?? [];

  // The flat ordered list of currently-visible resources — this is what the
  // public landing renders, and what up/down ordering operates over.
  const visibleSorted = [...all]
    .filter((r) => r.landingVisible)
    .sort((a, b) => a.order - b.order);

  // Preview feed: the server builds it with the same code as the public endpoint
  // (uncached), so the preview is exactly what / shows.
  const preview = networks.data?.preview ?? [];
  const previewCount = preview.reduce((a, n) => a + n.resources.length, 0);

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
      qc.invalidateQueries({ queryKey: ['landing', 'networks'] });
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PublicPageCard />

      <div className="la-wrap">
        <div className="la-editor">
          <NetworksCard data={networks.data} isLoading={networks.isLoading} error={networks.error} />

          {/* Loading: skeleton rows in a panel that keeps the editor's rhythm. */}
          {isLoading && (
            <SectionCard title="Resources" flush delay={60}>
              <SkeletonRows flush rows={5} height={54} label="Loading landing resources" />
            </SectionCard>
          )}

          {/* Error: a danger callout, the same pattern as the list pages. */}
          {error && (
            <div className="callout-danger" role="alert">
              <Icon name="warning" size={16} />
              <div>
                <div className="text-body ld-callout-title">Couldn’t load landing resources</div>
                <div className="text-body-sm ink-muted" style={{ marginTop: 2 }}>
                  {describeError(error)}
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

          {groups.map((g, gi) => {
            const meta = PLATFORM_META[g.platform];
            const featuredCount = g.items.filter((r) => r.landingVisible).length;
            return (
              <SectionCard
                key={g.platform}
                title={meta.label}
                flush
                delay={60 + gi * 40}
                action={<span className="la-count">{featuredCount}/{g.items.length} featured</span>}
              >
                {g.items.map((r) => {
                  const vIdx = visibleIndex(r);
                  const isFirst = vIdx === 0;
                  const isLast = vIdx === visibleSorted.length - 1;
                  return (
                    <div key={r.id} className={`panel-row${r.landingVisible ? ' is-selected' : ' la-hidden'}`}>
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
                        <span className="la-row-sub">
                          {r.handle && <span className="mono">@{r.handle}</span>}
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
              </SectionCard>
            );
          })}
        </div>

        <div className="la-preview">
          <SectionCard
            title="Live preview"
            delay={60}
            action={
              previewCount > 0 ? <span className="la-count">{previewCount} featured</span> : undefined
            }
          >
            <p className="la-note">
              The same as the public landing page at <code>/</code> — same component, same data, same order.
            </p>
            {networks.isLoading && <SkeletonRows rows={1} height={160} label="Loading the preview" />}
            {networks.error && (
              <div className="callout-danger" role="alert">
                Couldn’t load the preview: {describeError(networks.error)}
              </div>
            )}
            {networks.data && <NetworkShowcase networks={preview} />}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
