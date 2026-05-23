import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { useStrategies } from '../api/strategies';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { PostsList } from '../components/PostsList';
import { fmtNumber, fmtDate } from '../lib/format';
import { RoiPanel } from '../components/RoiPanel';
import { EditThemesModal } from '../components/EditThemesModal';
import { EditChannelModal } from '../components/EditChannelModal';
import { ForwardRoutesPanel } from '../components/ForwardRoutesPanel';
import { useChannelThemes } from '../api/discovery';
import { Icon } from '../components/Icon';
import type { Strategy, TrackedChannel } from '../api/types';

export const Route = createFileRoute('/channels/$id')({ component: ChannelDetailPage });

function ChannelDetailPage() {
  const { id } = Route.useParams();
  const [themesOpen, setThemesOpen] = useState(false);
  const [editOpen,   setEditOpen]   = useState(false);

  const channelQ    = useQuery({ queryKey: ['channel', id], queryFn: () => trackingApi.getChannel(id) });
  const subsQ       = useQuery({ queryKey: ['subs', id],    queryFn: () => trackingApi.subsHistory(id) });
  const postsQ      = useQuery({ queryKey: ['posts', id],   queryFn: () => trackingApi.listPosts(id, 30) });
  const topQ        = useQuery({ queryKey: ['top', id],     queryFn: () => trackingApi.topPosts(id, 'views', 5) });
  const themesQ     = useChannelThemes(id);
  const strategiesQ = useStrategies();

  if (channelQ.isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  if (channelQ.error)     return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(channelQ.error as Error).message}</p>;
  if (!channelQ.data)     return null;

  const c = channelQ.data;

  // Filter the full strategies list by this channel. Two memberships count:
  //  • primary  — strategy.channel_id == this.id
  //  • forward  — channel.strategies[] entry with role='forward' (the
  //               strategy publishes elsewhere but forward-routes here)
  // The channel DTO already carries strategy refs; we cross-reference with
  // the full strategy rows for schedule + next-run.
  const primaryStrategies = (strategiesQ.data ?? []).filter(s => s.channel_id === id);

  // For forwards, look at c.strategies[].role === 'forward' and resolve back.
  const forwardStrategyIds = new Set(
    (c.strategies ?? []).filter(s => s.role === 'forward').map(s => s.id),
  );
  const forwardStrategies = (strategiesQ.data ?? []).filter(s => forwardStrategyIds.has(s.id));

  const allBound = [...primaryStrategies, ...forwardStrategies];
  const nextRun = soonestNextRun(allBound);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <header>
        <h1 className="text-display-md" style={{ margin: 0 }}>{c.title ?? c.username ?? id}</h1>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {c.username && <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{c.username}</span>}
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNumber(c.subsCount)}</span>
            <span style={{ color: 'var(--color-ink-muted)' }}> subs</span>
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className={`chip ${c.pollTier === 'hot' ? 'chip-warning' : c.pollTier === 'cold' ? '' : 'chip-success'}`}>
            {c.pollTier}
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>added {fmtDate(c.addedAt)}</span>
          <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            <button onClick={() => setThemesOpen(true)} className="btn-tiny">
              <Icon name="pencil" size={12} style={{ marginRight: 4 }} />
              Themes ({themesQ.data?.length ?? 0})
            </button>
            {c.isMine && (
              <button onClick={() => setEditOpen(true)} className="btn-tiny">
                <Icon name="pencil" size={12} style={{ marginRight: 4 }} />
                Config
              </button>
            )}
          </div>
        </div>
        {c.about && (
          <p className="text-body" style={{ marginTop: 12, maxWidth: 720, color: 'var(--color-ink-muted)', lineHeight: 1.5 }}>
            {c.about}
          </p>
        )}
      </header>

      {/* Hero stat strip — at-a-glance "what is this channel" before scrolling. */}
      <StatStrip
        channel={c}
        strategiesCount={allBound.length}
        nextRunAt={nextRun}
      />

      {themesOpen && (
        <EditThemesModal
          channelId={id}
          channelTitle={c.title ?? c.username ?? id}
          open={themesOpen}
          onClose={() => setThemesOpen(false)}
        />
      )}
      {editOpen && (
        <EditChannelModal channel={c} open={editOpen} onClose={() => setEditOpen(false)} />
      )}

      {c.isMine && (
        <Section title="Publishing strategies">
          <StrategiesPanel
            primary={primaryStrategies}
            forwards={forwardStrategies}
            isLoading={strategiesQ.isLoading}
          />
        </Section>
      )}

      {c.isMine && (
        <Section title="Forward routes">
          <ForwardRoutesPanel sourceChannelId={id} />
        </Section>
      )}

      <Section title="ROI estimate">
        <RoiPanel channelId={id} />
      </Section>

      <Section title="Subscribers over time">
        {subsQ.data && subsQ.data.points.length > 0
          ? <SubsHistoryChart points={subsQ.data.points} />
          : <Empty>No history yet — wait for the next poll cycle.</Empty>}
      </Section>

      <Section title="Views per post (last 30)">
        {postsQ.data && postsQ.data.items.length > 0
          ? <ViewsBarChart posts={postsQ.data.items} />
          : <Empty>No posts yet.</Empty>}
      </Section>

      <Section title="Engagement rate">
        {postsQ.data && postsQ.data.items.length > 0
          ? <EngagementChart posts={postsQ.data.items} />
          : <Empty>No data.</Empty>}
      </Section>

      <Section title="Top 5 posts by views">
        {topQ.data && <PostsList posts={topQ.data.items} />}
      </Section>

      <Section title="Recent posts">
        {postsQ.data && <PostsList posts={postsQ.data.items} />}
      </Section>
    </div>
  );
}

// ─── Hero stat strip ────────────────────────────────────────────────────────

function StatStrip({
  channel, strategiesCount, nextRunAt,
}: { channel: TrackedChannel; strategiesCount: number; nextRunAt: string | null }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 12,
      }}
    >
      <Stat label="Bot">
        {channel.bot
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
              <Icon name="bots" size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              {channel.bot.username ?? channel.bot.bot_id}
              {!channel.bot.active && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 6 }}>inactive</span>}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>— none</span>}
      </Stat>
      <Stat label="Channel key">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {channel.channelKey ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
        </span>
      </Stat>
      <Stat label="Kind">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
          {channel.kind ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
        </span>
      </Stat>
      <Stat label="Strategies">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {strategiesCount}
        </span>
      </Stat>
      <Stat label="Next post">
        {nextRunAt
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
              {formatRelativeFuture(nextRunAt)}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>— paused</span>}
      </Stat>
      <Stat label="Themes">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
          {(channel.themes ?? []).length === 0
            ? <span style={{ color: 'var(--color-ink-dim)' }}>none</span>
            : (channel.themes ?? []).slice(0, 3).join(', ') + ((channel.themes ?? []).length > 3 ? ` +${(channel.themes ?? []).length - 3}` : '')}
        </span>
      </Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ minHeight: 18 }}>{children}</div>
    </div>
  );
}

// ─── Strategies panel ──────────────────────────────────────────────────────

function StrategiesPanel({
  primary, forwards, isLoading,
}: { primary: Strategy[]; forwards: Strategy[]; isLoading: boolean }) {
  if (isLoading) {
    return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  }
  const total = primary.length + forwards.length;
  if (total === 0) {
    return (
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
        No strategies publish to this channel. <Link to="/strategies" className="link-accent">Add one</Link>.
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Type</th>
            <th>Schedule</th>
            <th>Next run</th>
            <th>Last run</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {primary.map(s => <StrategyTableRow key={s.id} s={s} role="primary" />)}
          {forwards.map(s => <StrategyTableRow key={s.id} s={s} role="forward" />)}
        </tbody>
      </table>
    </div>
  );
}

function StrategyTableRow({ s, role }: { s: Strategy; role: 'primary' | 'forward' }) {
  return (
    <tr>
      <td>
        <Link to="/strategies" className="link-accent" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {s.ext_id}
        </Link>
        {role === 'forward' && (
          <span className="chip" style={{ marginLeft: 8 }}>↩ forward</span>
        )}
      </td>
      <td><span className="chip">{s.type}</span></td>
      <td style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>{s.schedule}</td>
      <td>
        {s.enabled && s.next_run_at
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
              {formatRelativeFuture(s.next_run_at)}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>—</span>}
      </td>
      <td>
        {s.last_run ? (
          <span className={
            s.last_run.status === 'ok'    ? 'chip chip-success'
          : s.last_run.status === 'error' ? 'chip chip-danger'
          : s.last_run.status === 'skipped' ? 'chip chip-warning'
          : 'chip'
          } title={s.last_run.error ?? s.last_run.status}>
            {s.last_run.status}
          </span>
        ) : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>never</span>}
      </td>
      <td>
        {s.enabled
          ? <span className="chip chip-success"><Icon name="check" size={12} style={{ marginRight: 4 }} />enabled</span>
          : <span className="chip">paused</span>}
      </td>
    </tr>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Soonest next-run ISO timestamp across all enabled strategies. null when none. */
function soonestNextRun(strategies: Strategy[]): string | null {
  let soonest: string | null = null;
  for (const s of strategies) {
    if (!s.enabled || !s.next_run_at) continue;
    if (!soonest || new Date(s.next_run_at).getTime() < new Date(soonest).getTime()) {
      soonest = s.next_run_at;
    }
  }
  return soonest;
}

/** Future timestamp → relative string. */
function formatRelativeFuture(iso: string): string {
  const t  = new Date(iso).getTime();
  const dt = t - Date.now();
  if (dt < 0) return 'now';
  const m = Math.round(dt / 60_000);
  if (m < 60)   return `in ${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  if (h < 24)   return `in ${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h - d * 24}h`;
}

/** Section heading uses .text-eyebrow (caption tier, ink-muted) — no uppercase
 *  + weight-bump anti-pattern. Hierarchy comes from size + tracking. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-eyebrow" style={{ margin: 0, marginBottom: 10 }}>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{children}</p>;
}
