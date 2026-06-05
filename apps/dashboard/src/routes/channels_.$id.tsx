import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { ChannelAvatar } from '../components/ChannelAvatar';
import { InlineScheduleEditor } from '../components/InlineScheduleEditor';
import { useChannelThemes } from '../api/discovery';
import { Icon } from '../components/Icon';
import {
  POLL_TIER_HELP, CHANNEL_KIND_HELP, CHANNEL_FLAG_HELP, STRATEGY_STATUS_HELP,
  STRATEGY_ROLE_HELP, RUN_STATUS_HELP, BOT_STATUS_HELP,
  describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import type { Strategy, TrackedChannel } from '../api/types';

export const Route = createFileRoute('/channels_/$id')({ component: ChannelDetailPage });

function ChannelDetailPage() {
  const { id } = Route.useParams();
  const [themesOpen, setThemesOpen] = useState(false);
  const [editOpen,   setEditOpen]   = useState(false);
  const qc = useQueryClient();

  const togglePause = useMutation({
    mutationFn: (next: boolean) => trackingApi.patchChannel(id, { publishPaused: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      qc.invalidateQueries({ queryKey: ['channel', id] });
    },
  });

  // Inline poll-tier edit — saves immediately.
  const setTier = useMutation({
    mutationFn: (tier: 'hot' | 'warm' | 'cold') => trackingApi.patchChannel(id, { pollTier: tier }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      qc.invalidateQueries({ queryKey: ['channel', id] });
    },
  });

  // On-demand "fetch stats now" — enqueues an immediate meta+posts poll, then
  // refreshes the page data after a few seconds (gives the worker time to run).
  const pollNow = useMutation({
    mutationFn: () => trackingApi.pollChannel(id),
    onSuccess: () => {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['channel', id] });
        qc.invalidateQueries({ queryKey: ['subs', id] });
        qc.invalidateQueries({ queryKey: ['posts', id] });
        qc.invalidateQueries({ queryKey: ['top', id] });
      }, 4000);
    },
  });

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
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 18 }}>
        <ChannelAvatar
          name={c.title ?? c.username ?? c.channelKey}
          src={null}
          size={64}
          title={c.title ?? c.username ?? id}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="text-display-md" style={{ margin: 0 }}>
          {c.title ?? c.channelKey ?? (c.username ? `@${c.username}` : id)}
        </h1>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {c.kind === 'private' && c.tgChatId && (
            <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {c.tgChatId}
            </span>
          )}
          {c.kind !== 'private' && c.username && (
            <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{c.username}</span>
          )}
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNumber(c.subsCount)}</span>
            <span style={{ color: 'var(--color-ink-muted)' }}> subs</span>
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <select
            value={c.pollTier}
            onChange={(e) => setTier.mutate(e.target.value as 'hot' | 'warm' | 'cold')}
            disabled={setTier.isPending}
            title={POLL_TIER_HELP[c.pollTier]}
            className="input-field"
            style={{ padding: '2px 8px', fontSize: 12, width: 'auto' }}
          >
            <option value="hot">hot</option>
            <option value="warm">warm</option>
            <option value="cold">cold</option>
          </select>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>added {fmtDate(c.addedAt)}</span>
          <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            <button
              onClick={() => pollNow.mutate()}
              disabled={pollNow.isPending}
              className="btn-tiny"
              title="Поставити в чергу негайний збір статистики (meta + пости). Також перевіряє підписку."
            >
              <Icon name="refresh" size={12} style={{ marginRight: 4 }} />
              {pollNow.isPending ? 'Збираю…' : 'Отримати статистику'}
            </button>
            {c.isMine && (
              <button
                onClick={() => togglePause.mutate(!c.publishPaused)}
                disabled={togglePause.isPending}
                className={c.publishPaused ? 'btn-primary' : 'btn-tiny'}
                title={CHANNEL_FLAG_HELP.publishPaused}
              >
                <Icon name={c.publishPaused ? 'play' : 'pause'} size={12} style={{ marginRight: 4 }} />
                {c.publishPaused ? 'Resume publishing' : 'Pause publishing'}
              </button>
            )}
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
        </div>
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
      <Stat label="Bot" help="Telegram bot account that publishes content into this channel. Bound via channel config.">
        {channel.bot
          ? <span
              className="text-body-sm"
              style={{ color: 'var(--color-ink)' }}
              title={`${channel.bot.bot_id}${channel.bot.username ? ` (@${channel.bot.username})` : ''}${!channel.bot.active ? ' — ' + BOT_STATUS_HELP.inactive : ''}`}
            >
              <Icon name="bots" size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
              {channel.bot.username ?? channel.bot.bot_id}
              {!channel.bot.active && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 6 }}>inactive</span>}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>— none</span>}
      </Stat>
      <Stat label="Channel key" help="Address used to publish into this channel — '@username' for public, '-100…' numeric id for private.">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {channel.channelKey ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
        </span>
      </Stat>
      <Stat label="Kind" help={channel.kind ? CHANNEL_KIND_HELP[channel.kind as 'public' | 'private'] : 'Whether the channel is public (@username) or private (numeric id).'}>
        <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
          {channel.kind ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
        </span>
      </Stat>
      <Stat label="Strategies" help="Number of strategy bindings that publish content into this channel — primary bindings + forward-route inheritance.">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {strategiesCount}
        </span>
      </Stat>
      <Stat label="Next post" help="Soonest scheduled fire across all enabled strategies bound to this channel. Computed server-side from cron expressions.">
        {nextRunAt
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }} title={new Date(nextRunAt).toLocaleString()}>
              {formatRelativeFuture(nextRunAt)}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>— paused</span>}
      </Stat>
      <Stat label="Themes" help="Tags assigned to this channel for the Phase 4 Recommendations matching. Edit via the Themes button.">
        <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
          {(channel.themes ?? []).length === 0
            ? <span style={{ color: 'var(--color-ink-dim)' }}>none</span>
            : (channel.themes ?? []).slice(0, 3).join(', ') + ((channel.themes ?? []).length > 3 ? ` +${(channel.themes ?? []).length - 3}` : '')}
        </span>
      </Stat>
    </div>
  );
}

function Stat({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }} title={help}>
      <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        {label}
        {help && <Icon name="info" size={11} style={{ color: 'var(--color-ink-dim)', verticalAlign: 'middle' }} />}
      </div>
      <div style={{ minHeight: 18 }}>{children}</div>
    </div>
  );
}

// ─── Strategies panel ──────────────────────────────────────────────────────

function StrategiesPanel({
  primary, forwards, isLoading,
}: { primary: Strategy[]; forwards: Strategy[]; isLoading: boolean }) {
  // One row open at a time. null = none. Parent state lives here so opening
  // row B implicitly closes row A.
  const [editingId, setEditingId] = useState<string | null>(null);

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
          {primary.map(s => (
            <StrategyTableRow
              key={s.id}
              s={s}
              role="primary"
              isEditing={editingId === s.id}
              onStartEdit={() => setEditingId(s.id)}
              onDone={() => setEditingId(null)}
            />
          ))}
          {forwards.map(s => (
            <StrategyTableRow
              key={s.id}
              s={s}
              role="forward"
              isEditing={false}
              onStartEdit={() => {}}
              onDone={() => {}}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrategyTableRow({
  s, role, isEditing, onStartEdit, onDone,
}: {
  s: Strategy;
  role: 'primary' | 'forward';
  isEditing: boolean;
  onStartEdit: () => void;
  onDone: () => void;
}) {
  const meta = describeStrategy(s.type);
  const typeTooltip = meta
    ? `${meta.title} (${SOURCE_KIND_LABEL[meta.source]})\n\n${meta.description}`
    : s.type;
  return (
    <tr>
      <td>
        <Link to="/strategies" className="link-accent" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {s.ext_id}
        </Link>
        {role === 'forward' && (
          <span className="chip" style={{ marginLeft: 8 }} title={STRATEGY_ROLE_HELP.forward}>↩ forward</span>
        )}
      </td>
      <td><span className="chip" title={typeTooltip}>{s.type}</span></td>
      <td style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {role === 'primary' ? (
          <InlineScheduleEditor
            strategyId={s.id}
            current={s.schedule}
            isEditing={isEditing}
            onStartEdit={onStartEdit}
            onDone={onDone}
          />
        ) : (
          <span title="Cron schedule (UTC unless TZ is configured). Inherited from a forward route — open the source channel's detail page to edit this schedule inline.">
            {s.schedule}
            <span className="text-micro" style={{ marginLeft: 6, color: 'var(--color-ink-dim)' }}>
              (forwarded — edit on source)
            </span>
          </span>
        )}
      </td>
      <td>
        {s.enabled && s.next_run_at
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }} title={new Date(s.next_run_at).toLocaleString()}>
              {formatRelativeFuture(s.next_run_at)}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>—</span>}
      </td>
      <td>
        {s.last_run ? (
          <span
            className={
              s.last_run.status === 'ok'    ? 'chip chip-success'
            : s.last_run.status === 'error' ? 'chip chip-danger'
            : s.last_run.status === 'skipped' ? 'chip chip-warning'
            : 'chip'
            }
            title={
              (RUN_STATUS_HELP[s.last_run.status] ?? s.last_run.status)
              + (s.last_run.error ? `\n\n${s.last_run.error}` : '')
            }
          >
            {s.last_run.status}
          </span>
        ) : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }} title="No execution recorded yet.">never</span>}
      </td>
      <td>
        {s.enabled
          ? <span className="chip chip-success" title={STRATEGY_STATUS_HELP.enabled}><Icon name="check" size={12} style={{ marginRight: 4 }} />enabled</span>
          : <span className="chip" title={STRATEGY_STATUS_HELP.paused}>paused</span>}
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
