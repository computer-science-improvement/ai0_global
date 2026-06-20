// Logs / activity feed. Read-only union of strategy runs + scheduled posts
// (GET /activity). Platform + activity-type tabs, a time-range / strategy /
// channel filter row, 50-per-page pagination, and expandable rows that reveal
// the run's execution trace (service · action · duration, failing step flagged).

import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { Badge } from '../components/ui/Badge';
import { Pagination } from '../components/Pagination';
import { Icon, type IconName } from '../components/ui/Icon';
import { SectionCard, EmptyState, StatusDot, type Tone } from '../components/ui/primitives';
import { activityApi } from '../api/activity';
import { useStrategies } from '../api/strategies';
import { useMetaAccounts } from '../api/meta-accounts';
import { fmtDate } from '../lib/format';
import type { ActivityEvent, ActivityType, RunStep } from '../api/types';

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

const TYPE_META: Record<ActivityType, {
  label: string;
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  dot: Tone;
  icon: IconName;
}> = {
  posted:  { label: 'Posted',  tone: 'success', dot: 'success', icon: 'check'   },
  error:   { label: 'Error',   tone: 'danger',  dot: 'danger',  icon: 'warning' },
  skipped: { label: 'Skipped', tone: 'warning', dot: 'warning', icon: 'pause'   },
  running: { label: 'Running', tone: 'neutral', dot: 'accent',  icon: 'refresh' },
};

const STEP_TONE: Record<RunStep['status'], Tone> = { ok: 'success', error: 'danger', skipped: 'warning' };

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

  if (q.isLoading) return <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '4px 0 0 40px' }}>Loading trace…</p>;
  const steps = q.data ?? [];
  if (!steps.length) return <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '4px 0 0 40px' }}>No execution trace recorded for this run.</p>;

  return (
    <div style={{ margin: '6px 0 2px 40px', paddingLeft: 14, borderLeft: '1px solid var(--color-hairline)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map((s) => (
        <div key={s.seq}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusDot tone={STEP_TONE[s.status]} size={7} />
            <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{s.service}</span>
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>· {s.action}</span>
            <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
              {s.durationMs}ms
            </span>
          </div>
          {s.error && (
            <p className="text-micro" style={{ margin: '2px 0 0 15px', color: 'var(--color-danger)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {s.error}
            </p>
          )}
          {s.detail && !s.error && (
            <p className="text-micro" style={{ margin: '2px 0 0 15px', color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.detail}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

// A single feed row — status-rail dot + timeline spine, actor hierarchy, hover
// lift. Strategy-run rows expand to reveal the execution trace.
function LogRow({ e, index, isLast }: { e: ActivityEvent; index: number; isLast: boolean }) {
  const m = TYPE_META[e.type];
  const expandable = e.source === 'strategy_run';
  const [open, setOpen] = useState(false);
  const runId = expandable ? e.id.slice(e.source.length + 1) : null;
  const detail =
    e.detail != null ? e.detail
    : e.durationMs != null ? `Completed in ${(e.durationMs / 1000).toFixed(1)} s`
    : null;
  const spinning = e.type === 'running';

  return (
    <div
      className="compose-rise"
      style={{ animationDelay: `${Math.min(index, 16) * 22}ms`, position: 'relative' }}
      onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--color-surface-3)'; }}
      onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
    >
      <div
        style={{
          display: 'flex', gap: 14, alignItems: 'flex-start',
          padding: '14px 16px', borderRadius: 'var(--radius-md)',
          transition: 'background 130ms ease', cursor: expandable ? 'pointer' : 'default',
        }}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        {/* status rail: StatusDot + connecting spine (spinner ring while running) */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', width: 26 }}>
          <span style={{
            position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, flex: 'none',
          }}>
            <StatusDot tone={m.dot} size={10} />
            {spinning && (
              <span aria-hidden style={{
                position: 'absolute', inset: 4, borderRadius: 'var(--radius-pill)',
                border: '1.5px solid transparent', borderTopColor: 'var(--color-accent)',
                animation: 'logs-spin 1s linear infinite',
              }} />
            )}
          </span>
          {!isLast && (
            <span style={{ flex: 1, width: 1, minHeight: 14, marginTop: 4, background: 'var(--color-hairline)' }} />
          )}
        </div>

        {/* body */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: detail ? 4 : 0 }}>
            <Badge tone={m.tone}><Icon name={m.icon} size={10} />{m.label}</Badge>
            <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.channel ?? 'Unknown destination'}
            </span>
            {e.strategy && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-ink-dim)', fontSize: 12 }}>
                <Icon name="chevron-right" size={11} />
                <Icon name="strategies" size={11} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220, color: 'var(--color-ink-muted)' }}>{e.strategy}</span>
              </span>
            )}
          </div>
          {detail && (
            <p className="text-body-sm" style={{ margin: 0, color: e.type === 'error' ? 'var(--color-danger)' : 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.detail ?? undefined}>
              {detail}
            </p>
          )}
          {open && runId && <RunStepsPanel runId={runId} />}
        </div>

        {/* expand chevron + timestamp */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none', paddingTop: 2 }}>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }} title={e.at}>
            {fmtDate(e.at)}
          </span>
          {expandable && (
            <span aria-hidden style={{ display: 'inline-flex', color: 'var(--color-ink-dim)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 130ms ease' }}>
              <Icon name="chevron-right" size={14} />
            </span>
          )}
        </div>
      </div>
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

  const selectStyle: React.CSSProperties = { padding: '6px 10px', fontSize: 12, minWidth: 130 };

  return (
    <div>
      <style>{`@keyframes logs-spin { to { transform: rotate(360deg); } }`}</style>

      <PageHeader title="Logs" subtitle="Automation activity — posts, errors, skips. Click a run to see its execution trace." />

      {/* Filter row 1: platform + type */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <SegmentedTabs
          value={platform}
          onChange={(p) => { setPlatform(p); setStrategy(''); setChannelId(''); setPage(1); }}
          options={PLATFORM_TABS}
        />
        <div style={{ overflowX: 'auto', paddingBottom: 2 }}>
          <SegmentedTabs value={type} onChange={resetPage(setType)} options={TYPE_TABS} />
        </div>
        {!q.isLoading && !q.error && (
          <span style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {total} event{total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Filter row 2: time range + strategy + channel */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <SegmentedTabs value={range} onChange={resetPage(setRange)} options={[...RANGE_TABS.map(r => ({ key: r.key, label: r.label })), { key: 'custom', label: 'Custom' }]} />
        {range === 'custom' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="date" value={customFrom} onChange={(e) => resetPage(setCustomFrom)(e.target.value)} className="input-field" style={selectStyle} />
            <span style={{ color: 'var(--color-ink-dim)', fontSize: 12 }}>→</span>
            <input type="date" value={customTo} onChange={(e) => resetPage(setCustomTo)(e.target.value)} className="input-field" style={selectStyle} />
          </span>
        )}
        <select value={strategy} onChange={(e) => resetPage(setStrategy)(e.target.value)} className="input-field" style={selectStyle}>
          <option value="">All strategies</option>
          {strategyOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={channelId}
          onChange={(e) => resetPage(setChannelId)(e.target.value)}
          className="input-field"
          style={{ ...selectStyle, opacity: resourceOptions.length ? 1 : 0.5 }}
          disabled={resourceOptions.length === 0}
          title={resourceOptions.length === 0 ? 'No accounts for this platform' : undefined}
        >
          <option value="">{resourceLabel}</option>
          {resourceOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>

      {q.isLoading && (
        <SectionCard title="Activity" icon="logs">
          <div style={{ margin: '0 -10px' }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="compose-rise" style={{ animationDelay: `${i * 40}ms`, display: 'flex', gap: 14, alignItems: 'center', padding: '14px 16px' }}>
                <span style={{ width: 26, height: 26, borderRadius: 'var(--radius-pill)', background: 'var(--color-surface-3)', flex: 'none' }} />
                <span style={{ height: 12, width: `${42 + ((i * 13) % 34)}%`, borderRadius: 'var(--radius-pill)', background: 'var(--color-surface-3)' }} />
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {q.error && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderColor: 'var(--color-danger-soft)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 'var(--radius-pill)', background: 'var(--color-danger-soft)', color: 'var(--color-danger)', flex: 'none' }}>
            <Icon name="warning" size={15} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink)', fontWeight: 500 }}>Couldn’t load activity</p>
            <p className="text-body-sm" style={{ margin: '2px 0 0', color: 'var(--color-ink-muted)' }}>{(q.error as Error).message}</p>
          </div>
          <button className="btn-secondary" onClick={() => q.refetch()}>
            <span style={{ display: 'inline-flex', marginRight: 6, verticalAlign: '-2px' }}><Icon name="refresh" size={13} /></span>
            Retry
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
          <SectionCard title="Activity" icon="logs">
            <div style={{ margin: '0 -10px' }}>
              {items.map((e, i) => (
                <LogRow key={e.id} e={e} index={i} isLast={i === items.length - 1} />
              ))}
            </div>
          </SectionCard>
          <Pagination page={page} pageSize={PAGE} total={total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
