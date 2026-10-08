import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import type { CSSProperties } from 'react';
import { trackingApi } from '../api/tracking';
import { useStrategies } from '../api/strategies';
import { useUpcomingSlots, type UpcomingSlot } from '../api/upcoming';
import { useMetaAccounts, useRefreshMetaStats } from '../api/meta-accounts';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/Icon';
import { Icon as PlatformGlyph } from '../components/ui/Icon';
import { StatTile, SectionCard, EmptyState, StatusDot, type Tone } from '../components/ui/primitives';
import { NetworkHealthCard } from '../components/agents/NetworkHealth';
import { AgentsCard } from '../components/overview/AgentsCard';
import { AiSpendCard } from '../components/overview/AiSpendCard';

export const Route = createFileRoute('/app/')({ component: OverviewPage });

const STATUS_TONE: Record<string, Tone> = { ok: 'success', error: 'danger', skipped: 'warning', running: 'neutral' };
const STATUS_LABEL: Record<string, string> = { ok: 'ok', error: 'error', skipped: 'skipped', running: 'running' };
const STATUS_DOT_TONE: Record<string, Tone> = { ok: 'success', error: 'danger', skipped: 'warning', running: 'neutral' };

function rel(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function deltaText(n: number): string {
  if (n > 0) return `+${n.toLocaleString('en-US')}`;
  if (n < 0) return n.toLocaleString('en-US');
  return '0';
}

const SLOT_STATUS_TONE: Record<string, Tone> = {
  planned: 'neutral', running: 'accent', shadowed: 'neutral', published: 'success', awaiting_approval: 'warning',
  approved: 'success', skipped: 'warning', failed: 'danger', expired: 'neutral',
};

/** "awaiting_approval" → "awaiting approval"; no slot yet → "not planned". */
function slotStatusLabel(s: UpcomingSlot): string {
  return s.status ? s.status.replace(/_/g, ' ') : 'not planned';
}

/** The local time of a slot (en-GB, the viewer's zone) — the card lists the next 24 h. */
function slotTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
}

function OverviewPage() {
  const strategiesQ = useStrategies();
  // Spec 023 FR-013: agents' series instances and owner pins replace "Active strategies / Upcoming runs".
  const upcomingQ = useUpcomingSlots(24, 8);
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'overview'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const metaQ = useMetaAccounts();
  const refresh = useRefreshMetaStats();

  const strategies = strategiesQ.data ?? [];
  const channels = channelsQ.data?.items ?? [];
  const metaAccounts = metaQ.data ?? [];

  const totalSubs = channels.reduce((sum, c) => sum + (c.subsCount ?? 0), 0);
  const metaFollowers = metaAccounts.reduce((sum, a) => sum + (a.followers ?? 0), 0);
  const metaDelta24 = metaAccounts.reduce((sum, a) => sum + (a.followers_delta_24h ?? 0), 0);
  const errors = strategies.filter(s => s.last_run?.status === 'error');
  const upcoming = upcomingQ.data?.items ?? [];
  const recent = strategies
    .filter(s => s.last_run)
    .sort((a, b) => (b.last_run!.started_at > a.last_run!.started_at ? 1 : -1))
    .slice(0, 6);

  // Shared row treatment: hairline divider, hover-lift via inline transition.
  const rowBase: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
    borderTop: '1px solid var(--color-hairline)', fontSize: 12.5,
    borderRadius: 'var(--radius-sm)', transition: 'background 0.13s ease',
  };
  const onRowEnter = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'var(--color-surface-3)'; };
  const onRowLeave = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.background = ''; };

  return (
    <div>
      <PageHeader title="Overview" subtitle="Telegram + Meta · audience, publishing, status" />

      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <StatTile icon="channels" label="Subscribers (Telegram)" value={channelsQ.isLoading ? '—' : totalSubs.toLocaleString('en-US')} />
        <StatTile icon="connections" label="Followers (Meta)" value={metaQ.isLoading ? '—' : metaFollowers.toLocaleString('en-US')} />
        <StatTile
          icon="analytics" label="Meta Δ 24h"
          value={metaQ.isLoading ? '—' : deltaText(metaDelta24)}
          delta={metaQ.isLoading ? undefined : deltaText(metaDelta24)}
          deltaTone={metaDelta24 > 0 ? 'success' : metaDelta24 < 0 ? 'danger' : 'neutral'}
        />
        <StatTile icon="calendar" label="Upcoming slots (24 h)" value={upcomingQ.isLoading ? '—' : upcoming.length >= 8 ? '8+' : upcoming.length} />
        <StatTile
          icon="warning" label="Errors" value={errors.length}
          delta={errors.length ? 'needs attention' : 'all clear'}
          deltaTone={errors.length ? 'danger' : 'neutral'}
        />
      </div>

      {/* Spec 029 FR-009: agent activity and AI spend (tokens + USD across every LLM call). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 12, marginBottom: 12, alignItems: 'start' }}>
        <AgentsCard delay={3 * 60} />
        <AiSpendCard delay={3 * 60 + 30} />
      </div>

      <NetworkHealthCard delay={4 * 60} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 12, marginBottom: 12 }}>
        <SectionCard delay={5 * 60} icon="calendar" title="Upcoming slots" action={<span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>series and pins · next 24 h</span>}>
          {upcomingQ.isLoading
            ? <EmptyState icon="calendar" title="Loading upcoming slots…" />
            : upcomingQ.error
              ? <EmptyState icon="calendar" title="Upcoming slots unavailable" note={(upcomingQ.error as Error).message} />
              : upcoming.length === 0
                ? <EmptyState icon="calendar" title="No series or pins in the next 24 hours" note="Agents' series and your pinned posts appear here. Steer them on an agent's Schedule tab." />
                : upcoming.map((u, idx) => (
                  <Link
                    key={`${u.agent}-${u.at}-${u.name}`}
                    to={'/app/agents/$handle' as never}
                    params={{ handle: u.agent } as never}
                    search={{ tab: 'schedule' } as never}
                    style={idx === 0 ? { ...rowBase, borderTop: 'none', textDecoration: 'none', color: 'inherit', flexWrap: 'wrap' } : { ...rowBase, textDecoration: 'none', color: 'inherit', flexWrap: 'wrap' }}
                    onMouseEnter={onRowEnter}
                    onMouseLeave={onRowLeave}
                    title={`${u.kind === 'pin' ? 'Pinned post' : 'Series'} · ${u.resourceRef} · @${u.agent}${u.owner ? ' · set by you' : ''}`}
                  >
                    <span style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums', fontWeight: 500, minWidth: 40 }}>{slotTime(u.at)}</span>
                    <span style={{ color: 'var(--color-ink-muted)', display: 'inline-flex', flexShrink: 0 }}><PlatformGlyph name={u.kind === 'pin' ? 'pin' : 'calendar'} size={12} /></span>
                    <span style={{ color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{u.name}</span>
                    <span className="text-micro" style={{ color: 'var(--color-ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{u.channelKey}</span>
                    <span style={{ marginLeft: 'auto' }}><Badge tone={u.status ? (SLOT_STATUS_TONE[u.status] ?? 'neutral') : 'neutral'}>{slotStatusLabel(u)}</Badge></span>
                  </Link>
                ))}
        </SectionCard>

        <SectionCard delay={6 * 60} icon="strategies" title="Legacy strategy runs">
          {strategiesQ.isLoading
            ? <EmptyState icon="strategies" title="Loading recent runs…" />
            : recent.length === 0
              ? <EmptyState icon="strategies" title="No runs yet" note="Legacy strategy outcomes appear here while any strategy still runs." />
              : recent.map((s, idx) => {
                const status = s.last_run!.status;
                return (
                  <div key={s.id} style={idx === 0 ? { ...rowBase, borderTop: 'none' } : rowBase} onMouseEnter={onRowEnter} onMouseLeave={onRowLeave}>
                    <StatusDot tone={STATUS_DOT_TONE[status] ?? 'neutral'} size={7} />
                    <span style={{ color: 'var(--color-ink)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{s.ext_id}</span>
                    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>
                    {s.last_run!.error && <span className="text-micro" style={{ color: 'var(--color-danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }} title={s.last_run!.error}>{s.last_run!.error}</span>}
                    <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)', whiteSpace: 'nowrap' }}>{s.last_run!.finished_at ? rel(s.last_run!.finished_at) : ''}</span>
                  </div>
                );
              })}
        </SectionCard>
      </div>

      <SectionCard
        delay={7 * 60}
        icon="connections"
        title="Meta accounts"
        action={
          metaAccounts.length > 0 ? (
            <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="btn-tiny" title="Fetch latest followers + insights">
              <Icon name="refresh" size={12} /> {refresh.isPending ? 'Refreshing…' : 'Refresh'}
            </button>
          ) : undefined
        }
      >
        {metaQ.isLoading
          ? <EmptyState icon="connections" title="Loading Meta accounts…" />
          : metaAccounts.length === 0
            ? <EmptyState icon="connections" title="No Meta accounts yet" note="Connect Facebook, Instagram or Threads on the Meta page to track followers here." />
            : metaAccounts.map((a, idx) => {
                const d = a.followers_delta_24h ?? null;
                const dTone = d == null || d === 0 ? 'var(--color-ink-dim)' : d > 0 ? 'var(--color-success)' : 'var(--color-danger)';
                return (
                  <Link
                    key={a.id}
                    to={'/app/connections/meta/$accountId' as any}
                    params={{ accountId: a.id } as any}
                    style={idx === 0 ? { ...rowBase, borderTop: 'none', textDecoration: 'none', color: 'inherit' } : { ...rowBase, textDecoration: 'none', color: 'inherit' }}
                    onMouseEnter={onRowEnter}
                    onMouseLeave={onRowLeave}
                  >
                    <span style={{
                      width: 24, height: 24, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)',
                      color: 'var(--color-ink-muted)',
                    }}>
                      <PlatformGlyph name={a.platform as any} size={13} />
                    </span>
                    <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{a.username ? `@${a.username}` : a.account_id}</span>
                    <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)', whiteSpace: 'nowrap' }}>{a.followers != null ? `${a.followers.toLocaleString('en-US')} followers` : '—'}</span>
                    <span style={{ color: dTone, minWidth: 56, textAlign: 'right', fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{d == null ? '' : deltaText(d)}</span>
                  </Link>
                );
              })}
      </SectionCard>
    </div>
  );
}
