import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useReducer, useState } from 'react';
import { trackingApi } from '../api/tracking';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { useMediaQuery } from '../lib/useMediaQuery';
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
import { Badge } from '../components/ui/Badge';
import { StatTile, SectionCard, EmptyState } from '../components/ui/primitives';
import { FINITE_POOL_TYPES, isLowContent } from '../lib/runway';
import {
  POLL_TIER_HELP, CHANNEL_KIND_HELP, CHANNEL_FLAG_HELP, STRATEGY_STATUS_HELP,
  STRATEGY_ROLE_HELP, RUN_STATUS_HELP, BOT_STATUS_HELP,
  describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import type { Strategy, TrackedChannel } from '../api/types';

export const Route = createFileRoute('/app/channels_/$id')({ component: ChannelDetailPage });

function ChannelDetailPage() {
  const { id } = Route.useParams();
  const [themesOpen, setThemesOpen] = useState(false);
  const [editOpen,   setEditOpen]   = useState(false);
  const confirm = useConfirm();
  const isMobile = useMediaQuery('(max-width: 600px)');
  // Bumped to force the controlled poll-tier <select> back to the saved value
  // when the user cancels the confirm dialog.
  const [, revertTier] = useReducer((x: number) => x + 1, 0);
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

  if (channelQ.isLoading) {
    return (
      <div className="panel compose-rise" style={{ textAlign: 'center', padding: 56, color: 'var(--color-ink-muted)' }}>
        <div style={{
          display: 'inline-flex', padding: 16, borderRadius: 'var(--radius-pill)',
          border: '1px dashed var(--color-hairline-strong)', background: 'var(--color-surface-2)',
          marginBottom: 16, opacity: 0.6,
        }}>
          <Icon name="refresh" size={24} />
        </div>
        <p className="text-body-sm" style={{ margin: 0 }}>Loading channel…</p>
      </div>
    );
  }
  if (channelQ.error) {
    return <EmptyState icon="warning" title="Couldn’t load channel" note={(channelQ.error as Error).message} />;
  }
  if (!channelQ.data) return null;

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <header
        className="card-featured compose-rise"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: isMobile ? 14 : 20,
          animationDelay: '0ms',
        }}
      >
        <ChannelAvatar
          name={c.title ?? c.username ?? c.channelKey}
          src={null}
          size={isMobile ? 48 : 64}
          title={c.title ?? c.username ?? id}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 className="text-display-md" style={{ margin: 0 }}>
            {c.title ?? c.channelKey ?? (c.username ? `@${c.username}` : id)}
          </h1>
          {c.publishPaused && (
            <span className="chip chip-warning" title={CHANNEL_FLAG_HELP.publishPaused}>
              <Icon name="pause" size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />paused
            </span>
          )}
          {c.trackingStatus === 'not_subscribed' && (
            <span className="chip chip-danger" title="The publishing bot is not subscribed to this channel.">not subscribed</span>
          )}
          {c.kind && (
            <span className="chip" title={CHANNEL_KIND_HELP[c.kind as 'public' | 'private'] ?? c.kind}>{c.kind}</span>
          )}
        </div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {c.kind === 'private' && c.tgChatId && (
            <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>
              {c.tgChatId}
            </span>
          )}
          {c.kind !== 'private' && c.username && (
            <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{c.username}</span>
          )}
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            <span className="tabular-nums">{fmtNumber(c.subsCount)}</span>
            <span style={{ color: 'var(--color-ink-muted)' }}> subscribers</span>
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>poll</span>
          <select
            value={c.pollTier}
            onChange={async (e) => {
              const next = e.target.value as 'hot' | 'warm' | 'cold';
              if (await confirm(`change poll tier to “${next}”`, { danger: false, confirmLabel: 'Change' })) {
                setTier.mutate(next);
              } else {
                revertTier(); // user cancelled — snap the select back to the saved tier
              }
            }}
            disabled={setTier.isPending}
            title={POLL_TIER_HELP[c.pollTier]}
            className="input-field tabular-nums"
            style={{ padding: '2px 8px', fontSize: 12, width: 'auto' }}
          >
            <option value="hot">hot</option>
            <option value="warm">warm</option>
            <option value="cold">cold</option>
          </select>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>added {fmtDate(c.addedAt)}</span>
          <div style={{
            marginLeft: isMobile ? 0 : 'auto',
            width: isMobile ? '100%' : 'auto',
            marginTop: isMobile ? 6 : 0,
            display: 'flex', flexWrap: 'wrap', gap: 6,
          }}>
            <button
              onClick={() => pollNow.mutate()}
              disabled={pollNow.isPending}
              className="btn-tiny"
              title="Queue an immediate stats fetch (meta + posts). Also checks the subscription."
            >
              <Icon name="refresh" size={12} style={{ marginRight: 4 }} />
              {pollNow.isPending ? 'Fetching…' : 'Fetch stats'}
            </button>
            {c.isMine && (
              <button
                onClick={async () => {
                  const ok = await confirm(
                    c.publishPaused ? 'resume publishing to this channel' : 'pause publishing to this channel',
                    { danger: !c.publishPaused, confirmLabel: c.publishPaused ? 'Resume' : 'Pause' },
                  );
                  if (ok) togglePause.mutate(!c.publishPaused);
                }}
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
          <p className="text-body" style={{ marginTop: 14, maxWidth: 720, color: 'var(--color-ink-muted)', lineHeight: 1.5 }}>
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
        <SectionCard title="Publishing strategies" icon="strategies" action={<SectionCaption>primary + forward bindings</SectionCaption>} delay={120}>
          <StrategiesPanel
            primary={primaryStrategies}
            forwards={forwardStrategies}
            isLoading={strategiesQ.isLoading}
          />
        </SectionCard>
      )}

      {c.isMine && (
        <SectionCard title="Forward routes" icon="connections" delay={160}>
          <ForwardRoutesPanel sourceChannelId={id} />
        </SectionCard>
      )}

      <SectionCard title="ROI estimate" icon="recommendations" delay={200}>
        <RoiPanel channelId={id} />
      </SectionCard>

      <SectionCard title="Subscribers over time" icon="graph" action={<SectionCaption>full history</SectionCaption>} delay={240}>
        {subsQ.data && subsQ.data.points.length > 0
          ? <SubsHistoryChart points={subsQ.data.points} />
          : subsQ.isLoading
            ? <LoadingState note="Loading history…" />
            : <EmptyState icon="graph" title="No history yet" note="Wait for the next poll cycle." />}
      </SectionCard>

      <SectionCard title="Views per post" icon="channels" action={<SectionCaption>last 30</SectionCaption>} delay={280}>
        {postsQ.data && postsQ.data.items.length > 0
          ? <ViewsBarChart posts={postsQ.data.items} />
          : postsQ.isLoading
            ? <LoadingState note="Loading posts…" />
            : <EmptyState icon="channels" title="No posts yet" />}
      </SectionCard>

      <SectionCard title="Engagement rate" icon="analytics" action={<SectionCaption>reactions + forwards / views</SectionCaption>} delay={320}>
        {postsQ.data && postsQ.data.items.length > 0
          ? <EngagementChart posts={postsQ.data.items} />
          : postsQ.isLoading
            ? <LoadingState note="Loading posts…" />
            : <EmptyState icon="analytics" title="No data" />}
      </SectionCard>

      <SectionCard title="Top posts by views" icon="graph" action={<SectionCaption>top 5</SectionCaption>} delay={360}>
        {topQ.data
          ? <PostsList posts={topQ.data.items} />
          : <LoadingState note="Loading top posts…" />}
      </SectionCard>

      <SectionCard title="Recent posts" icon="channels" action={<SectionCaption>latest first</SectionCaption>} delay={400}>
        {postsQ.data
          ? <PostsList posts={postsQ.data.items} />
          : <LoadingState note="Loading posts…" />}
      </SectionCard>
    </div>
  );
}

// ─── Hero stat strip ────────────────────────────────────────────────────────

function StatStrip({
  channel, strategiesCount, nextRunAt,
}: { channel: TrackedChannel; strategiesCount: number; nextRunAt: string | null }) {
  const themes = channel.themes ?? [];
  return (
    <div className="stat-grid">
      <StatTile
        label="Subscribers"
        icon="recommendations"
        value={fmtNumber(channel.subsCount)}
      />
      <StatTile
        label="Strategies"
        icon="strategies"
        accent={strategiesCount > 0}
        value={
          <span style={{ color: strategiesCount > 0 ? 'var(--color-ink)' : 'var(--color-ink-dim)' }}>
            {strategiesCount}
          </span>
        }
      />
      <StatTile
        label="Next post"
        icon="calendar"
        value={
          nextRunAt
            ? <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-accent)', fontWeight: 600 }} title={new Date(nextRunAt).toLocaleString()}>
                {formatRelativeFuture(nextRunAt)}
              </span>
            : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>paused</span>
        }
      />
      <StatTile
        label="Bot"
        icon="bots"
        value={
          channel.bot
            ? <span
                className="text-body-sm"
                style={{ color: channel.bot.active ? 'var(--color-ink)' : 'var(--color-ink-muted)' }}
                title={`${channel.bot.bot_id}${channel.bot.username ? ` (@${channel.bot.username})` : ''}${!channel.bot.active ? ' — ' + BOT_STATUS_HELP.inactive : ''}`}
              >
                {channel.bot.username ?? channel.bot.bot_id}
                {!channel.bot.active && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 6 }}>inactive</span>}
              </span>
            : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>none</span>
        }
      />
      <StatTile
        label="Channel key"
        icon="channels"
        value={
          <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)' }}>
            {channel.channelKey ?? <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
          </span>
        }
      />
      <StatTile
        label="Themes"
        icon="discovery"
        value={
          themes.length === 0
            ? <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>none</span>
            : <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {themes.slice(0, 3).map(t => <span key={t} className="chip">{t}</span>)}
                {themes.length > 3 && <span className="chip" style={{ color: 'var(--color-ink-muted)' }}>+{themes.length - 3}</span>}
              </span>
        }
      />
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
    return <LoadingState note="Loading strategies…" />;
  }
  const total = primary.length + forwards.length;
  if (total === 0) {
    return (
      <EmptyState
        icon="strategies"
        title="No strategies"
        note="No strategies publish to this channel."
        action={<Link to="/app/strategies" className="link-accent">Add a strategy</Link>}
      />
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
            <th>Content</th>
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
        <Link to="/app/strategies" className="link-accent" style={{ fontVariantNumeric: 'tabular-nums' }}>
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
        {s.last_run ? (() => {
          const tooltip = (RUN_STATUS_HELP[s.last_run.status] ?? s.last_run.status)
            + (s.last_run.error ? `\n\n${s.last_run.error}` : '');
          return s.last_run.status === 'ok' ? (
            <Badge tone="success" title={tooltip}>{s.last_run.status}</Badge>
          ) : s.last_run.status === 'error' ? (
            <Badge tone="danger" title={tooltip}>{s.last_run.status}</Badge>
          ) : s.last_run.status === 'skipped' ? (
            <Badge tone="warning" title={tooltip}>{s.last_run.status}</Badge>
          ) : (
            <span className="chip" title={tooltip}>{s.last_run.status}</span>
          );
        })() : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }} title="No execution recorded yet.">never</span>}
      </td>
      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
        {!FINITE_POOL_TYPES.has(s.type) || s.content_remaining == null ? (
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }} title="Live/feed source — unlimited supply, no runway.">—</span>
        ) : isLowContent(s) ? (
          <span title={`Low content: ${s.content_remaining} posts left (alert below ${s.low_content_threshold}). Load more content for this strategy.`}>
            <Badge tone="warning"><Icon name="warning" size={11} /> Low: {s.content_remaining} / {s.low_content_threshold}</Badge>
          </span>
        ) : (
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }} title={`${s.content_remaining} posts of content remaining (alert below ${s.low_content_threshold}).`}>
            {s.content_remaining.toLocaleString()}
          </span>
        )}
      </td>
      <td>
        {s.enabled
          ? <Badge tone="success" title={STRATEGY_STATUS_HELP.enabled}><Icon name="check" size={12} style={{ marginRight: 4 }} />enabled</Badge>
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

/** Right-aligned muted caption for a SectionCard header action slot. */
function SectionCaption({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-caption" style={{ color: 'var(--color-ink-dim)', fontSize: 11 }}>
      {children}
    </span>
  );
}

/** Dashed-icon in-card loading state (kept distinct from the empty state). */
function LoadingState({ note }: { note: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '36px 16px',
        minHeight: 120,
        border: '1px dashed var(--color-hairline-strong)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--color-ink-muted)',
        textAlign: 'center',
      }}
    >
      <span style={{ display: 'inline-flex', opacity: 0.5 }}>
        <Icon name="refresh" size={20} />
      </span>
      <span className="text-body-sm" style={{ margin: 0 }}>{note}</span>
    </div>
  );
}
