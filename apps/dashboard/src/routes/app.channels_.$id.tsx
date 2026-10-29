import { createFileRoute, Link } from '@tanstack/react-router';
import { Crumbs } from '../components/ui/Crumbs';
import { useCrumbs } from '../nav/hooks';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useReducer, useState } from 'react';
import { trackingApi } from '../api/tracking';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { useStrategies } from '../api/strategies';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { PostsList } from '../components/PostsList';
import { fmtNumber } from '../lib/format';
import { ownViewsSpark, splitReposts } from '../lib/reposts';
import { channelName } from '../lib/channel-view';
import { RoiPanel } from '../components/RoiPanel';
import { EditThemesModal } from '../components/EditThemesModal';
import { EditChannelModal } from '../components/EditChannelModal';
import { ForwardRoutesPanel } from '../components/ForwardRoutesPanel';
import { CrosspostSection } from '../components/CrosspostSection';
import { ChannelHeader } from '../components/channels/ChannelHeader';
import { ErrorCallout, LoadingNote, SectionCaption } from '../components/channels/ChannelsUi';
import { useChannelThemes } from '../api/discovery';
import { Icon } from '../components/ui/Icon';
import { Badge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { StatTile, StatStrip, SectionCard, EmptyState, type Tone } from '../components/ui/primitives';
import {
  CHANNEL_FLAG_HELP, STRATEGY_STATUS_HELP, STRATEGY_ROLE_HELP, RUN_STATUS_HELP, BOT_STATUS_HELP,
  describeStrategy, SOURCE_KIND_LABEL,
} from '../lib/labels';
import type { Strategy } from '../api/types';

export const Route = createFileRoute('/app/channels_/$id')({ component: ChannelDetailPage });

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${fmtNumber(n)}`;
}

function deltaTone(n: number | null | undefined): Tone {
  if (n == null || n === 0) return 'neutral';
  return n > 0 ? 'success' : 'danger';
}

function ChannelDetailPage() {
  const { id } = Route.useParams();
  const [themesOpen, setThemesOpen] = useState(false);
  const [editOpen,   setEditOpen]   = useState(false);
  const confirm = useConfirm();
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
  const trail = useCrumbs('channel-detail');

  if (channelQ.isLoading) {
    return (
      <div>
        <PageHeader title="Channel" eyebrow="Loading…" />
        <div className="panel"><LoadingNote note="Loading channel…" /></div>
      </div>
    );
  }
  if (channelQ.error) {
    return (
      <div>
        <Crumbs crumbs={trail} />
        <PageHeader title="Channel" />
        <ErrorCallout title="Couldn’t load channel" error={channelQ.error} />
        <Link to="/app/channels" search={{ filter: 'mine', page: 1, q: '' }} className="btn-secondary">All channels</Link>
      </div>
    );
  }
  if (!channelQ.data) return null;

  const c = channelQ.data;
  const name = channelName(c, id);
  // Spec 027 FR-013: own channels sit under "My channels", the rest under all channels.
  const crumbs = c.isMine ? trail : [...trail.slice(0, -1), { label: 'Channels', to: '/app/channels' }];

  // Legacy strategy bindings of this channel (history since spec 023 phase B). Two memberships count:
  //  • primary  — strategy.channel_id == this.id
  //  • forward  — channel.strategies[] entry with role='forward' (the
  //               strategy published elsewhere and forward-routed here)
  const primaryStrategies = (strategiesQ.data ?? []).filter(s => s.channel_id === id);

  // For forwards, look at c.strategies[].role === 'forward' and resolve back.
  const forwardStrategyIds = new Set(
    (c.strategies ?? []).filter(s => s.role === 'forward').map(s => s.id),
  );
  const forwardStrategies = (strategiesQ.data ?? []).filter(s => forwardStrategyIds.has(s.id));

  const allBound = [...primaryStrategies, ...forwardStrategies];

  // Hero numbers, read from the data the page already loads.
  const points = subsQ.data?.points ?? [];
  const posts = postsQ.data?.items ?? [];
  const subsDelta = points.length > 1 ? points[points.length - 1].subs - points[0].subs : null;
  const split = splitReposts(posts);
  // Views of the last 7 own posts, oldest first: the same posts the average reads (reposts carry a sibling's audience).
  const viewsSpark = ownViewsSpark(posts);
  const botInactive = c.bot && !c.bot.active;

  const onTier = async (next: 'hot' | 'warm' | 'cold') => {
    if (await confirm(`change poll tier to “${next}”`, { danger: false, confirmLabel: 'Change' })) {
      setTier.mutate(next);
    } else {
      revertTier(); // user cancelled — snap the select back to the saved tier
    }
  };

  const askPause = async (pause: boolean) => {
    const ok = await confirm(
      pause ? 'pause publishing to this channel' : 'resume publishing to this channel',
      { danger: pause, confirmLabel: pause ? 'Pause' : 'Resume' },
    );
    if (ok) togglePause.mutate(pause);
  };

  return (
    <div>
      <Crumbs crumbs={crumbs} />

      <ChannelHeader
        channel={c}
        name={name}
        themesCount={themesQ.data?.length ?? 0}
        busy={{ poll: pollNow.isPending, pause: togglePause.isPending, tier: setTier.isPending }}
        onPoll={() => pollNow.mutate()}
        onPause={() => askPause(true)}
        onThemes={() => setThemesOpen(true)}
        onEdit={() => setEditOpen(true)}
        onTier={onTier}
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

      {/* The human's call: publishing into this channel is held until they lift it. */}
      {c.isMine && c.publishPaused && (
        <div className="callout-warning compose-rise" role="status" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
          <Icon name="pause" size={18} />
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <div className="text-body-sm ch-callout-title">Publishing is paused</div>
            <div className="text-micro ch-muted" style={{ marginTop: 2 }}>{CHANNEL_FLAG_HELP.publishPaused}</div>
          </div>
          <button type="button" className="btn-warning btn-sm" disabled={togglePause.isPending} onClick={() => askPause(false)}>
            <Icon name="play" size={14} /> Resume publishing
          </button>
        </div>
      )}

      <div className="ch-stack">
        {/* At-a-glance numbers before scrolling. */}
        <div className="compose-rise" style={{ animationDelay: '40ms' }}>
          <StatStrip label="Channel numbers">
            <StatTile
              label="Subscribers"
              value={fmtNumber(c.subsCount)}
              delta={subsDelta != null ? `${signed(subsDelta)} · tracked range` : undefined}
              deltaTone={deltaTone(subsDelta)}
            />
            {/* Read from the posts only once they answered: "no posts" while they load would be false. */}
            <StatTile
              label="Avg views"
              value={postsQ.data ? fmtNumber(split.avgOwnViews) : '—'}
              delta={postsQ.data ? (split.own > 0 ? `last ${split.own} own posts` : 'no posts') : undefined}
              spark={viewsSpark.length > 1 ? viewsSpark : undefined}
            />
            <StatTile
              label="Own vs reposts"
              value={postsQ.data ? `${fmtNumber(split.own)} / ${fmtNumber(split.reposts)}` : '—'}
              delta={postsQ.data ? (split.share != null ? `${Math.round(split.share * 100)}% reposts` : 'no posts') : undefined}
            />
            <StatTile label="Legacy strategies" value={allBound.length} delta={allBound.length > 0 ? 'history only' : undefined} />
          </StatStrip>
        </div>

        <SectionCard title="Setup" delay={80}>
          <div className="ch-facts">
            <div className="inset">
              <div className="text-overline">Bot</div>
              <div className={`ch-fact-v${c.bot ? '' : ' is-empty'}`}>
                {c.bot ? (
                  <>
                    <span
                      className="mono"
                      title={`${c.bot.bot_id}${c.bot.username ? ` (@${c.bot.username})` : ''}${botInactive ? ' — ' + BOT_STATUS_HELP.inactive : ''}`}
                    >
                      {c.bot.username ? `@${c.bot.username}` : c.bot.bot_id}
                    </span>
                    {botInactive && <Badge tone="neutral">inactive</Badge>}
                  </>
                ) : 'none'}
              </div>
            </div>
            <div className="inset">
              <div className="text-overline">Channel key</div>
              <div className={`ch-fact-v${c.channelKey ? '' : ' is-empty'}`}>
                {c.channelKey ? <span className="mono">{c.channelKey}</span> : '—'}
              </div>
            </div>
            <div className="inset">
              <div className="text-overline">Themes</div>
              <div className={`ch-fact-v${(c.themes ?? []).length ? '' : ' is-empty'}`}>
                {(c.themes ?? []).length === 0
                  ? 'none'
                  : (c.themes ?? []).map(t => <span key={t} className="chip">{t}</span>)}
              </div>
            </div>
          </div>
        </SectionCard>

        {c.isMine && (
          <SectionCard
            title="Legacy strategy bindings"
            action={<SectionCaption>history · content is run by agents</SectionCaption>}
            delay={120}
          >
            <StrategiesPanel
              primary={primaryStrategies}
              forwards={forwardStrategies}
              isLoading={strategiesQ.isLoading}
            />
          </SectionCard>
        )}

        {c.isMine && <ForwardRoutesPanel sourceChannelId={id} delay={160} />}

        {/* Spec 023 phase B: crosspost targets moved here from the removed strategy page; the editor still uses them. */}
        {c.isMine && <CrosspostSection channelId={id} delay={180} />}

        <SectionCard title="ROI estimate" delay={200}>
          <RoiPanel channelId={id} />
        </SectionCard>

        <SectionCard title="Subscribers over time" action={<SectionCaption>full history</SectionCaption>} delay={240}>
          {subsQ.data && subsQ.data.points.length > 0
            ? <SubsHistoryChart points={subsQ.data.points} />
            : subsQ.isLoading
              ? <LoadingNote note="Loading history…" />
              : <EmptyState icon="graph" title="No history yet" note="Wait for the next poll cycle." />}
        </SectionCard>

        <SectionCard title="Views per post" action={<SectionCaption>last 30</SectionCaption>} delay={280}>
          {postsQ.data && postsQ.data.items.length > 0
            ? <ViewsBarChart posts={postsQ.data.items} />
            : postsQ.isLoading
              ? <LoadingNote note="Loading posts…" />
              : <EmptyState icon="channels" title="No posts yet" />}
        </SectionCard>

        <SectionCard title="Engagement rate" action={<SectionCaption>reactions + forwards / views</SectionCaption>} delay={320}>
          {postsQ.data && postsQ.data.items.length > 0
            ? <EngagementChart posts={postsQ.data.items} />
            : postsQ.isLoading
              ? <LoadingNote note="Loading posts…" />
              : <EmptyState icon="analytics" title="No data" />}
        </SectionCard>

        <SectionCard title="Top posts by views" flush action={<SectionCaption>top 5</SectionCaption>} delay={360}>
          {topQ.data
            ? <PostsList posts={topQ.data.items} />
            : topQ.isLoading
              ? <LoadingNote note="Loading top posts…" />
              : <EmptyState icon="warning" title="Couldn’t load top posts" />}
        </SectionCard>

        <SectionCard title="Recent posts" flush action={<SectionCaption>latest first</SectionCaption>} delay={400}>
          {postsQ.data
            ? <PostsList posts={postsQ.data.items} />
            : postsQ.isLoading
              ? <LoadingNote note="Loading posts…" />
              : <EmptyState icon="warning" title="Couldn’t load posts" />}
        </SectionCard>
      </div>
    </div>
  );
}

// ─── Strategies panel ──────────────────────────────────────────────────────

function StrategiesPanel({
  primary, forwards, isLoading,
}: { primary: Strategy[]; forwards: Strategy[]; isLoading: boolean }) {
  if (isLoading) {
    return <LoadingNote note="Loading strategies…" />;
  }
  const total = primary.length + forwards.length;
  if (total === 0) {
    return (
      <EmptyState
        icon="strategies"
        title="No legacy strategies"
        note="Strategies were removed: the channel's agent plans and writes its content."
        action={<Link to="/app/agents" className="btn-secondary btn-sm">Open Agents</Link>}
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
            />
          ))}
          {forwards.map(s => (
            <StrategyTableRow
              key={s.id}
              s={s}
              role="forward"
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Last-run tones of the old bindings: ok green, error red, anything else (skipped, running) neutral. */
function runTone(status: string): 'success' | 'danger' | 'neutral' {
  return status === 'ok' ? 'success' : status === 'error' ? 'danger' : 'neutral';
}

function StrategyTableRow({
  s, role,
}: {
  s: Strategy;
  role: 'primary' | 'forward';
}) {
  const meta = describeStrategy(s.type);
  const typeTooltip = meta
    ? `${meta.title} (${SOURCE_KIND_LABEL[meta.source]})\n\n${meta.description}`
    : s.type;
  return (
    <tr>
      <td>
        <span className="mono">{s.ext_id}</span>
        {role === 'forward' && (
          <span className="chip" style={{ marginLeft: 8 }} title={STRATEGY_ROLE_HELP.forward}>↩ forward</span>
        )}
      </td>
      <td><span className="chip mono" title={typeTooltip}>{s.type}</span></td>
      <td className="mono ch-muted">
        {/* Spec 023 phase B: history only — the schedule no longer runs. */}
        <span title="The binding's old cron schedule. Strategies no longer run.">
          {s.schedule}
          {role === 'forward' && (
            <span className="text-micro ch-faint" style={{ marginLeft: 6 }}>
              (forwarded)
            </span>
          )}
        </span>
      </td>
      <td>
        {s.last_run ? (() => {
          const tooltip = (RUN_STATUS_HELP[s.last_run.status] ?? s.last_run.status)
            + (s.last_run.error ? `\n\n${s.last_run.error}` : '');
          return <Badge tone={runTone(s.last_run.status)} title={tooltip}>{s.last_run.status}</Badge>;
        })() : <span className="text-body-sm ch-faint" title="No execution recorded yet.">never</span>}
      </td>
      <td>
        {s.enabled
          ? <Badge tone="warning" title={STRATEGY_STATUS_HELP.enabled}><Icon name="warning" size={12} />enabled, not running</Badge>
          : <Badge tone="neutral" title={STRATEGY_STATUS_HELP.paused}>paused</Badge>}
      </td>
    </tr>
  );
}
