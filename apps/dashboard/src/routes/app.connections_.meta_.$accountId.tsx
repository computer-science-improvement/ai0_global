import type { ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights, useRefreshMetaStats } from '../api/meta-accounts';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { StatTile, StatStrip, SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { describeError } from '../components/ui/Toast';
import { ConnFact, ConnRow } from '../components/connections/ConnUi';
import { fmtDate } from '../lib/format';
import type { MetaAccount } from '../api/types';

export const Route = createFileRoute('/app/connections_/meta_/$accountId')({ component: MetaAccountDetailPage });

const PLATFORM_LABEL: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads',
};

// Token type → Badge tone. PAGE tokens are preferred for posting (success);
// USER tokens work but are shorter-lived / less appropriate (warning).
const TOKEN_TYPE_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  PAGE: 'success', SYSTEM_USER: 'neutral', USER: 'warning',
};

/** Whole days from now until `iso` (negative = already past). */
function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** A follower change as text, with the direction that colours it (`is-up` / `is-down`, '' for none). */
function fmtDelta(n: number | null): { text: string; dir: 'is-up' | 'is-down' | '' } {
  if (n == null) return { text: '—', dir: '' };
  if (n > 0) return { text: `+${n.toLocaleString()}`, dir: 'is-up' };
  if (n < 0) return { text: n.toLocaleString(), dir: 'is-down' };
  return { text: '0', dir: '' };
}

// ── Access token: type, urgency-coloured expiry, source and the granted scopes ───────────────────────

function TokenPanel({ account: a }: { account: MetaAccount }) {
  // Threads accounts skip debug_token server-side, so token info is unobtainable
  // until ever populated — hide the panel rather than show meaningless data.
  if (a.platform === 'threads' && !a.token_checked_at) return null;

  const tokenInvalid = !!a.token_checked_at && a.token_valid === false;

  let expiryClass = '';
  let expiryText: ReactNode = 'Not checked — Verify to read';
  if (a.token_checked_at) {
    if (tokenInvalid) {
      expiryClass = 'is-bad';
      expiryText = 'Invalid token';
    } else if (!a.token_expires_at) {
      expiryClass = 'is-ok';
      expiryText = 'Never expires';
    } else {
      const days = daysUntil(a.token_expires_at);
      expiryClass = days <= 0 ? 'is-bad' : days <= 30 ? 'is-warn' : 'is-ok';
      const tail = days <= 0 ? 'expired' : `in ${days} day${days === 1 ? '' : 's'}`;
      expiryText = `${fmtDate(a.token_expires_at)} · ${tail}`;
    }
  }

  const tokenTone = a.token_type ? TOKEN_TYPE_TONE[a.token_type] ?? 'neutral' : 'neutral';
  const scopes = a.token_scopes ?? [];

  return (
    <SectionCard title="Access token" icon="info" delay={120} style={{ marginBottom: 20 }}>
      <div className="conn-facts" style={{ marginTop: 0 }}>
        <ConnFact label="Type"><Badge tone={tokenTone}>{a.token_type ?? 'unknown'}</Badge></ConnFact>
        <ConnFact label="Expiry">
          <span className={`conn-token-expiry ${expiryClass}`}>
            {expiryClass && <span className="conn-dot" aria-hidden />}
            {expiryText}
          </span>
        </ConnFact>
        <ConnFact label="Source"><span className="mono">{a.token_env || '—'}</span></ConnFact>
      </div>

      {scopes.length > 0 && (
        <div className="meta-scopes">
          <div className="text-overline">Scopes · {scopes.length}</div>
          <div className="conn-scopes">
            {scopes.map(s => <span key={s} className="conn-scope">{s}</span>)}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ── The account: picture, handle, platform and state ────────────────────────────────────────────────

function AccountPanel({ account: a }: { account: MetaAccount }) {
  const platformLabel = PLATFORM_LABEL[a.platform] ?? a.platform;
  const initial = ((a.display_name ?? a.account_id).trim()[0] ?? '?').toUpperCase();
  return (
    <SectionCard title="Account" flush delay={60} style={{ marginBottom: 20 }}>
      <ConnRow lead={a.picture_url ? <img src={a.picture_url} alt="" width={36} height={36} /> : initial}>
        <div className="conn-title">
          {a.username
            ? <span className="conn-name">@{a.username}</span>
            : <span className="conn-name">{a.display_name ?? a.account_id}</span>}
          <span className="chip">{platformLabel}</span>
          {a.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Paused</Badge>}
          {a.verify_error
            ? <Badge tone="danger" title={a.verify_error}>Verify error</Badge>
            : a.username
              ? <Badge tone="success">Verified</Badge>
              : null}
        </div>
        <div className="conn-sub">
          <span>id <span className="mono">{a.target_id}</span></span>
          {a.last_verified_at && <><span aria-hidden>·</span><span>verified <span className="mono">{fmtDate(a.last_verified_at)}</span></span></>}
        </div>
      </ConnRow>
      {a.verify_error && <p className="conn-error" role="alert">{a.verify_error}</p>}
    </SectionCard>
  );
}

function MetaAccountDetailPage() {
  const { accountId } = Route.useParams();
  const acc = useMetaAccounts().data?.find(a => a.id === accountId);
  const histQ = useMetaFollowerHistory(accountId);
  const insQ = useMetaAccountInsights(accountId);
  const refresh = useRefreshMetaStats();
  const trail = useCrumbs('meta-account');
  const insPoints = insQ.data?.points ?? [];
  const insLoading = insQ.isPending;
  const hasReach = insPoints.some(p => p.reach != null || p.impressions != null);
  const hasProfileViews = insPoints.some(p => p.profileViews != null);

  const d24 = fmtDelta(histQ.data?.delta24h ?? null);
  const d7  = fmtDelta(histQ.data?.delta7d ?? null);
  const points = histQ.data?.points ?? [];

  const title = acc?.display_name ?? acc?.account_id ?? accountId;
  // Spec 027 FR-013: Connections / Meta accounts (?tab= the account's platform).
  const crumbs = trail.map((c, i) => (i === trail.length - 1 && acc?.platform ? { ...c, search: { ...c.search, tab: acc.platform } } : c));
  const platformLabel = acc?.platform ? PLATFORM_LABEL[acc.platform] ?? acc.platform : '';

  return (
    <div>
      <PageHeader
        crumbs={crumbs}
        eyebrow={platformLabel ? `Meta account · ${platformLabel}` : 'Meta account'}
        title={title}
        actions={
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="btn-secondary"
            title="Fetch the latest followers + insights now"
          >
            <Icon name="refresh" size={14} /> {refresh.isPending ? 'Refreshing…' : 'Refresh stats'}
          </button>
        }
      />

      {refresh.isError && (
        <div className="callout-danger" role="alert" style={{ marginBottom: 16 }}>{describeError(refresh.error)}</div>
      )}

      {/* Followers now, and the change over a day and a week */}
      <StatStrip label="Followers" style={{ marginBottom: 20 }}>
        <StatTile
          label="Followers"
          value={histQ.data?.current != null ? histQ.data.current.toLocaleString() : '—'}
          spark={points.length > 1 ? points.slice(-30).map(p => p.followers) : undefined}
        />
        <StatTile label="Change · 24 h" value={<span className={`meta-delta ${d24.dir}`}>{d24.text}</span>} />
        <StatTile label="Change · 7 days" value={<span className={`meta-delta ${d7.dir}`}>{d7.text}</span>} />
      </StatStrip>

      {acc && <AccountPanel account={acc} />}
      {acc && <TokenPanel account={acc} />}

      {/* Chart cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title="Followers over time" icon="graph" delay={180}>
          {points.length > 0
            ? <SubsHistoryChart points={points.map(p => ({ at: p.at, subs: p.followers }))} />
            : <EmptyState
                icon="info"
                title="No follower data yet"
                note="Collected hourly for Instagram & Facebook (Threads needs insights access)."
              />}
        </SectionCard>

        <SectionCard title="Reach & impressions" icon="graph" delay={240}>
          {insLoading
            ? <EmptyState icon="refresh" title="Loading insight data…" />
            : hasReach
              ? <MetaReachImpressionsChart points={insPoints} />
              : <InsightEmpty platform={acc?.platform} />}
        </SectionCard>

        <SectionCard title="Profile views" icon="graph" delay={300}>
          {insLoading
            ? <EmptyState icon="refresh" title="Loading insight data…" />
            : hasProfileViews
              ? <MetaProfileViewsChart points={insPoints} />
              : <InsightEmpty platform={acc?.platform} />}
        </SectionCard>
      </div>
    </div>
  );
}

function InsightEmpty({ platform }: { platform?: string }) {
  return platform === 'threads'
    ? <EmptyState icon="info" title="Not available on Threads." />
    : <EmptyState
        icon="info"
        title="No insight data yet"
        note="Collected daily once the account has been active."
      />;
}
