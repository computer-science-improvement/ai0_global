// Logs / activity feed. Read-only union of strategy runs + scheduled posts
// (GET /activity). Platform + activity-type tabs, a time-range / strategy /
// channel filter row, 50-per-page pagination, and expandable rows that reveal
// the run's execution trace (service · action · duration, failing step flagged).
// Spec 078 C3: a day-grouped timeline in Kyiv time (mono time column, status mark on a spine).

import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Badge } from '../components/ui/Badge';
import { StatusMark } from '../components/ui/StatusMark';
import { Pagination } from '../components/Pagination';
import { Icon, type IconName } from '../components/ui/Icon';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { activityApi } from '../api/activity';
import { useStrategies } from '../api/strategies';
import { useMetaAccounts } from '../api/meta-accounts';
import { dayEyebrow, dayHeading, fmtDayShort, groupByDay } from '../lib/day-groups';
import { markTone, type MarkKind } from '../lib/status-tone';
import { KYIV_TZ, dayIn, fmtDateTimeIn, formatIn } from '../lib/zoned-time';
import type { ActivityEvent, ActivityType, RunStep } from '../api/types';
import { describeError } from '../components/ui/Toast';
import '../components/activity/activity.css';

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

// Time-range presets → hours back from now (0 = no lower bound).
const RANGE_TABS: ReadonlyArray<{ key: string; label: string; hours: number }> = [
  { key: 'all', label: 'All time', hours: 0 },
  { key: '24h', label: '24h',      hours: 24 },
  { key: '7d',  label: '7 days',   hours: 24 * 7 },
  { key: '30d', label: '30 days',  hours: 24 * 30 },
];

// An activity type is drawn with the mark (and the Badge tone) of the status it stands for: the one status map of the app.
const EVENT_MARK: Record<ActivityType, MarkKind> = { posted: 'published', error: 'failed', skipped: 'skipped', running: 'running' };
const EVENT_LABEL: Record<ActivityType, string> = { posted: 'Posted', error: 'Error', skipped: 'Skipped', running: 'Running' };

// A step of a run's trace (ok / error / skipped) is drawn with the same marks.
const STEP_MARK: Record<RunStep['status'], MarkKind> = { ok: 'published', error: 'failed', skipped: 'skipped' };
const STEP_LABEL: Record<RunStep['status'], string> = { ok: 'OK', error: 'Failed', skipped: 'Skipped' };

const PLATFORM_TABS: ReadonlyArray<{ key: string; label: string; icon: IconName }> = [
  { key: 'telegram', label: 'Telegram', icon: 'telegram' },
  { key: 'meta',     label: 'Meta',     icon: 'facebook' },
  { key: 'tiktok',   label: 'TikTok',   icon: 'tiktok' },
];

// The execution trace, lazy-loaded when a strategy-run row expands.
function RunStepsPanel({ runId }: { runId: string }) {
  const q = useQuery({
    queryKey: ['run-steps', runId],
    queryFn:  () => activityApi.runSteps(runId),
    staleTime: 30_000,
  });

  if (q.isLoading) return <div className="log-trace"><span className="log-trace-note">Loading trace…</span></div>;
  const steps = q.data ?? [];
  if (!steps.length) return <div className="log-trace"><span className="log-trace-note">No execution trace recorded for this run.</span></div>;

  return (
    <div className="log-trace">
      {steps.map((s) => (
        <div key={s.seq}>
          <div className="log-step-head">
            <StatusMark status={STEP_MARK[s.status]} label={STEP_LABEL[s.status]} size={10} />
            <span className="log-step-service">{s.service}</span>
            <span className="log-step-action">· {s.action}</span>
            <span className="log-step-ms mono tabular-nums">{s.durationMs} ms</span>
          </div>
          {s.error && <p className="log-step-body is-error">{s.error}</p>}
          {s.detail && !s.error && <p className="log-step-body is-detail clamp" style={{ ['--clamp' as string]: 2 }}>{s.detail}</p>}
        </div>
      ))}
    </div>
  );
}

// A single feed row: Kyiv time, status mark on the spine, what happened. Strategy-run rows are buttons that expand to the
// execution trace.
function LogRow({ e }: { e: ActivityEvent }) {
  const expandable = e.source === 'strategy_run';
  const [open, setOpen] = useState(false);
  const runId = expandable ? e.id.slice(e.source.length + 1) : null;
  const detail =
    e.detail != null ? e.detail
    : e.durationMs != null ? `Completed in ${(e.durationMs / 1000).toFixed(1)} s`
    : null;
  const kind = EVENT_MARK[e.type];

  const content = (
    <>
      <span className="log-time mono tabular-nums" title={`${fmtDateTimeIn(e.at, KYIV_TZ)} Kyiv`}>{formatIn(e.at, KYIV_TZ)}</span>
      <span className="log-mark"><StatusMark status={kind} label={EVENT_LABEL[e.type]} decorative /></span>
      <span className="log-main">
        <span className="log-title">
          <Badge tone={markTone(kind)}>{EVENT_LABEL[e.type]}</Badge>
          <span className="text-body-sm log-channel">{e.channel ?? 'Unknown destination'}</span>
          {e.strategy && <span className="log-strategy mono">› {e.strategy}</span>}
        </span>
        {detail && (
          <span className={`text-body-sm log-detail clamp${e.type === 'error' ? ' is-error' : ''}`} style={{ ['--clamp' as string]: 2 }} title={e.detail ?? undefined}>
            {detail}
          </span>
        )}
      </span>
      {expandable && <span className="log-chevron" aria-hidden><Icon name="chevron-right" size={14} /></span>}
    </>
  );

  return (
    <div className="log-ev">
      {expandable
        ? <button type="button" className="panel-row log-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{content}</button>
        : <div className="panel-row log-row">{content}</div>}
      {open && runId && <RunStepsPanel runId={runId} />}
    </div>
  );
}

function LogsPage() {
  const [platform, setPlatform] = useState('telegram');
  const [type, setType] = useState<TypeFilter>('all');
  const [range, setRange] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [strategy, setStrategy] = useState('');
  const [channelId, setChannelId] = useState('');
  const [page, setPage] = useState(1);

  const { data: strategies } = useStrategies();
  const { data: metaAccounts } = useMetaAccounts();

  // Which concrete binding platforms the active tab covers.
  const tabPlatforms = platform === 'meta' ? ['instagram', 'facebook', 'threads']
    : platform === 'tiktok' ? ['tiktok'] : ['telegram'];

  // Strategy options scoped to the active platform tab (e.g. Meta tab → only
  // Meta-publishing strategies).
  const strategyOptions = useMemo(
    () => (strategies ?? []).filter((s) => tabPlatforms.includes(s.platform)).map((s) => s.ext_id).sort(),
    [strategies, platform],
  );

  // The resource selector adapts to the tab: Telegram → channels, Meta → Meta
  // accounts (IG/FB/Threads), TikTok → its accounts. There are no "channels"
  // for Meta/TikTok, so we never offer them there.
  const resourceLabel = platform === 'meta' ? 'All accounts' : platform === 'tiktok' ? 'All TikTok accounts' : 'All channels';
  const resourceOptions = useMemo(() => {
    if (platform === 'telegram') {
      const map = new Map<string, string>();
      for (const s of strategies ?? []) {
        if (s.platform === 'telegram' && s.channel_id) map.set(s.channel_id, s.channel_key ?? s.channel_id);
      }
      return [...map.entries()].map(([id, label]) => ({ id, label }));
    }
    return (metaAccounts ?? [])
      .filter((a) => tabPlatforms.includes(a.platform))
      .map((a) => ({ id: a.id, label: a.username ? `@${a.username}` : a.account_id }));
  }, [strategies, metaAccounts, platform]);

  // Resolve the time-range preset → ISO `from` (recomputed only when the preset
  // changes). Custom range uses the date inputs directly.
  const { from, to } = useMemo(() => {
    if (range === 'custom') {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : null,
        to:   customTo ? new Date(customTo).toISOString() : null,
      };
    }
    const preset = RANGE_TABS.find((r) => r.key === range);
    if (!preset || preset.hours === 0) return { from: null, to: null };
    return { from: new Date(Date.now() - preset.hours * 3600_000).toISOString(), to: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, customFrom, customTo]);

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); };

  const q = useQuery({
    queryKey: ['activity', platform, type, from, to, strategy, channelId, page],
    queryFn: () =>
      activityApi.list({
        platform,
        type: type === 'all' ? null : type,
        from, to,
        strategy: strategy || null,
        channelId: channelId || null,
        limit: PAGE,
        offset: (page - 1) * PAGE,
      }),
    placeholderData: (prev) => prev,
  });

  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const groups = useMemo(() => groupByDay(items), [items]);
  const today = dayIn(Date.now(), KYIV_TZ);
  // The API counts only the filter in force, so the number sits on the selected type tab (never a stale one while a new filter loads).
  const typeOptions = TYPE_TABS.map((t) => (t.key === type && q.data && !q.isPlaceholderData ? { ...t, count: total } : t));

  const selectStyle: React.CSSProperties = { padding: '6px 10px', fontSize: 12, minWidth: 130 };

  return (
    <div>
      <PageHeader eyebrow={dayEyebrow(today)} title="Logs" subtitle="Automation activity — posts, errors, skips. Click a run to see its execution trace." />

      {/* Filter row 1: platform + type */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <SegmentedTabs
          value={platform}
          onChange={(p) => { setPlatform(p); setStrategy(''); setChannelId(''); setPage(1); }}
          options={PLATFORM_TABS}
          ariaLabel="Platform"
        />
        <div style={{ overflowX: 'auto', paddingBottom: 2, maxWidth: '100%' }}>
          <SegmentedTabs value={type} onChange={resetPage(setType)} options={typeOptions} ariaLabel="Event type" />
        </div>
      </div>

      {/* Filter row 2: time range + strategy + channel */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <SegmentedTabs value={range} onChange={resetPage(setRange)} ariaLabel="Time range"
          options={[...RANGE_TABS.map(r => ({ key: r.key, label: r.label })), { key: 'custom', label: 'Custom' }]} />
        {range === 'custom' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <input type="date" aria-label="From" value={customFrom} onChange={(e) => resetPage(setCustomFrom)(e.target.value)} className="input-field" style={selectStyle} />
            <span className="text-micro ink-dim">→</span>
            <input type="date" aria-label="To" value={customTo} onChange={(e) => resetPage(setCustomTo)(e.target.value)} className="input-field" style={selectStyle} />
          </span>
        )}
        <select aria-label="Strategy" value={strategy} onChange={(e) => resetPage(setStrategy)(e.target.value)} className="input-field" style={selectStyle}>
          <option value="">All strategies</option>
          {strategyOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          aria-label={resourceLabel}
          value={channelId}
          onChange={(e) => resetPage(setChannelId)(e.target.value)}
          className="input-field"
          style={selectStyle}
          disabled={resourceOptions.length === 0}
          title={resourceOptions.length === 0 ? 'No accounts for this platform' : undefined}
        >
          <option value="">{resourceLabel}</option>
          {resourceOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>

      {q.isLoading && <div className="panel compose-rise" aria-busy="true" style={{ height: 160, opacity: 0.55 }} />}

      {q.error && (
        <div className="callout-danger" style={{ flexWrap: 'wrap' }}>
          <Icon name="warning" size={16} />
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div className="text-heading-md">Couldn’t load activity</div>
            <div className="text-body-sm ink-muted" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{describeError(q.error)}</div>
          </div>
          <button className="btn-secondary btn-sm" onClick={() => q.refetch()}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        </div>
      )}

      {!q.isLoading && !q.error && items.length === 0 && (
        <EmptyState
          icon="logs"
          title="Nothing here yet"
          note="No activity matches these filters. Try widening the time range or clearing a filter."
        />
      )}

      {!q.isLoading && !q.error && items.length > 0 && (
        <>
          <SectionCard title="Activity" flush delay={40}
            action={<span className="mono text-caption ink-dim">Kyiv time</span>}>
            {groups.map((g, gi) => {
              const heading = dayHeading(g.day, today);
              return (
                <div key={`${g.day}-${gi}`} className="log-group">
                  <div className="log-day">
                    <span className="text-overline">{heading}</span>
                    {(heading === 'Today' || heading === 'Yesterday') && <span className="mono text-micro ink-dim">{fmtDayShort(g.day)}</span>}
                    <span className="log-day-count mono tabular-nums">{g.items.length}</span>
                  </div>
                  <div>
                    {g.items.map((e) => <LogRow key={e.id} e={e} />)}
                  </div>
                </div>
              );
            })}
          </SectionCard>
          <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
