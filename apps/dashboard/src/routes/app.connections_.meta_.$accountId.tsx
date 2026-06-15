import { createFileRoute, Link } from '@tanstack/react-router';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights, useRefreshMetaStats } from '../api/meta-accounts';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { StatCard } from '../components/ui/StatCard';
import { Icon } from '../components/Icon';

export const Route = createFileRoute('/app/connections_/meta_/$accountId')({ component: MetaAccountDetailPage });

function InsightLoading() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>Loading…</p>
    </div>
  );
}

function InsightEmpty({ platform }: { platform?: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
        {platform === 'threads'
          ? 'Not available on Threads.'
          : 'No insight data yet — collected daily once the account has been active.'}
      </p>
    </div>
  );
}

function fmtDelta(n: number | null): { text: string; tone: 'up' | 'down' | 'neutral' } {
  if (n == null) return { text: '—', tone: 'neutral' };
  if (n > 0) return { text: `+${n.toLocaleString()}`, tone: 'up' };
  if (n < 0) return { text: n.toLocaleString(), tone: 'down' };
  return { text: '0', tone: 'neutral' };
}

function MetaAccountDetailPage() {
  const { accountId } = Route.useParams();
  const acc = useMetaAccounts().data?.find(a => a.id === accountId);
  const histQ = useMetaFollowerHistory(accountId);
  const insQ = useMetaAccountInsights(accountId);
  const refresh = useRefreshMetaStats();
  const insPoints = insQ.data?.points ?? [];
  const insLoading = insQ.isPending;
  const hasReach = insPoints.some(p => p.reach != null || p.impressions != null);
  const hasProfileViews = insPoints.some(p => p.profileViews != null);

  const d24 = fmtDelta(histQ.data?.delta24h ?? null);
  const d7  = fmtDelta(histQ.data?.delta7d ?? null);
  const points = histQ.data?.points ?? [];

  return (
    <div>
      <Link to={'/app/connections/meta' as any} className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
        ← Back to Meta accounts
      </Link>

      <header style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0 24px' }}>
        {acc?.picture_url
          ? <img src={acc.picture_url} alt="" width={44} height={44} style={{ borderRadius: 10, objectFit: 'cover' }} />
          : <span style={{ display: 'inline-flex', width: 44, height: 44, borderRadius: 10, background: 'var(--color-surface-1)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={(acc?.platform ?? 'instagram') as any} size={20} />
            </span>}
        <div>
          <h1 className="text-display-md" style={{ margin: 0 }}>{acc?.display_name ?? acc?.account_id ?? accountId}</h1>
          <p className="text-caption" style={{ margin: '4px 0 0', color: 'var(--color-ink-muted)' }}>
            {acc?.username ? `@${acc.username}` : acc?.platform ?? ''}
          </p>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="btn-secondary"
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title="Fetch the latest followers + insights now"
        >
          <Icon name="refresh" size={13} />
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>
      {refresh.isError && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', margin: '0 0 12px' }}>
          {(refresh.error as Error).message}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Followers" value={histQ.data?.current != null ? histQ.data.current.toLocaleString() : '—'} />
        <StatCard label="Δ 24h" value={d24.text} deltaTone={d24.tone} />
        <StatCard label="Δ 7d"  value={d7.text}  deltaTone={d7.tone} />
      </div>

      <h2 className="text-eyebrow" style={{ margin: '0 0 10px' }}>Followers over time</h2>
      {points.length > 0
        ? <SubsHistoryChart points={points.map(p => ({ at: p.at, subs: p.followers }))} />
        : <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
              No follower data yet — collected hourly for Instagram &amp; Facebook (Threads needs insights access).
            </p>
          </div>}

      <h2 className="text-eyebrow" style={{ margin: '28px 0 10px' }}>Reach &amp; impressions</h2>
      {insLoading
        ? <InsightLoading />
        : hasReach
          ? <MetaReachImpressionsChart points={insPoints} />
          : <InsightEmpty platform={acc?.platform} />}

      <h2 className="text-eyebrow" style={{ margin: '28px 0 10px' }}>Profile views</h2>
      {insLoading
        ? <InsightLoading />
        : hasProfileViews
          ? <MetaProfileViewsChart points={insPoints} />
          : <InsightEmpty platform={acc?.platform} />}
    </div>
  );
}
