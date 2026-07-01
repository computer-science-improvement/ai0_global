import type { ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights, useRefreshMetaStats } from '../api/meta-accounts';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { StatTile, SectionCard, EmptyState, StatusDot, HubGlyph, type Tone } from '../components/ui/primitives';
import { fmtDate } from '../lib/format';
import { Icon } from '../components/Icon';
import type { MetaAccount } from '../api/types';

export const Route = createFileRoute('/app/connections_/meta_/$accountId')({ component: MetaAccountDetailPage });

const PLATFORM_LABEL: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads',
};

// Token type → chip tone. PAGE tokens are preferred for posting (success);
// USER tokens work but are shorter-lived / less appropriate (warning).
const TOKEN_TYPE_TONE: Record<string, Tone> = {
  PAGE: 'success', SYSTEM_USER: 'neutral', USER: 'warning',
};

const CHIP_CLASS: Record<Tone, string> = {
  success: 'chip chip-success', warning: 'chip chip-warning', danger: 'chip chip-danger',
  accent: 'chip', neutral: 'chip',
};

/** Whole days from now until `iso` (negative = already past). */
function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function fmtDelta(n: number | null): { text: string; tone: Tone } {
  if (n == null) return { text: '—', tone: 'neutral' };
  if (n > 0) return { text: `+${n.toLocaleString()}`, tone: 'success' };
  if (n < 0) return { text: n.toLocaleString(), tone: 'danger' };
  return { text: '0', tone: 'neutral' };
}

// ── Identity avatar — picture, else a monogram on a subtle hub glyph ─────────

function Avatar({ url, label }: { url: string | null | undefined; label: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={52}
        height={52}
        style={{ borderRadius: 'var(--radius-md)', objectFit: 'cover', boxShadow: 'inset 0 0 0 1px var(--color-hairline)', flexShrink: 0 }}
      />
    );
  }
  return <HubGlyph size={52}>{(label.trim()[0] ?? '?').toUpperCase()}</HubGlyph>;
}

// ── Token-metadata panel — type chip, urgency-colored expiry, scope chips ────

function TokenPanel({ account: a }: { account: MetaAccount }) {
  // Threads accounts skip debug_token server-side, so token info is unobtainable
  // until ever populated — hide the panel rather than show meaningless data.
  if (a.platform === 'threads' && !a.token_checked_at) return null;

  const tokenInvalid = !!a.token_checked_at && a.token_valid === false;

  let expiryTone: Tone = 'neutral';
  let expiryText: ReactNode = 'Not checked — Verify to read';
  if (a.token_checked_at) {
    if (tokenInvalid) {
      expiryTone = 'danger';
      expiryText = 'Invalid token';
    } else if (!a.token_expires_at) {
      expiryTone = 'success';
      expiryText = 'Never expires';
    } else {
      const days = daysUntil(a.token_expires_at);
      expiryTone = days <= 0 ? 'danger' : days <= 30 ? 'warning' : 'success';
      const tail = days <= 0 ? 'expired' : `in ${days} day${days === 1 ? '' : 's'}`;
      expiryText = `${fmtDate(a.token_expires_at)} · ${tail}`;
    }
  }
  const expiryColor: Record<Tone, string> = {
    success: 'var(--color-success)', warning: 'var(--color-warning)', danger: 'var(--color-danger)',
    accent: 'var(--color-accent)', neutral: 'var(--color-ink-dim)',
  };

  const tokenTone: Tone = a.token_type ? TOKEN_TYPE_TONE[a.token_type] ?? 'neutral' : 'neutral';
  const scopes = a.token_scopes ?? [];

  return (
    <SectionCard title="Access token" icon="info" delay={60} style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, rowGap: 16 }}>
        <Field label="Type">
          <span className={CHIP_CLASS[tokenTone]}>{a.token_type ?? 'unknown'}</span>
        </Field>

        <Field label="Expiry">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: expiryColor[expiryTone], fontWeight: 500 }}>
            <StatusDot tone={expiryTone} size={7} />
            <span className="text-body-sm">{expiryText}</span>
          </span>
        </Field>

        <Field label="Source">
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{a.token_env || '—'}</span>
        </Field>
      </div>

      {scopes.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-hairline-soft)' }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 8 }}>
            Scopes · {scopes.length}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {scopes.map(s => <span key={s} className="chip" style={{ fontSize: 11 }}>{s}</span>)}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{label}</span>
      {children}
    </div>
  );
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

  const title = acc?.display_name ?? acc?.account_id ?? accountId;
  const platformLabel = acc?.platform ? PLATFORM_LABEL[acc.platform] ?? acc.platform : '';

  return (
    <div>
      <Link to={'/app/connections/meta' as any} className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-ink-muted)' }}>
        <Icon name="chevron-left" size={12} /> Back to Meta accounts
      </Link>

      {/* Identity header — avatar + handle + platform / status chips + refresh */}
      <header
        className="panel compose-rise"
        style={{ display: 'flex', alignItems: 'center', gap: 16, margin: '12px 0 24px' }}
      >
        <Avatar url={acc?.picture_url} label={title} />

        <div style={{ minWidth: 0 }}>
          <h1 className="text-display-md" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {acc?.username && (
              <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>@{acc.username}</span>
            )}
            {platformLabel && <span className="chip">{platformLabel}</span>}
            {acc && (
              acc.active
                ? <span className="chip chip-success">Active</span>
                : <span className="chip">Paused</span>
            )}
            {acc?.verify_error
              ? <span className="chip chip-danger" title={acc.verify_error}>Verify error</span>
              : acc?.username
                ? <span className="chip chip-success">Verified</span>
                : null}
          </div>
        </div>

        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="btn-secondary"
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
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

      {/* KPI stat tiles */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatTile label="Followers" value={histQ.data?.current != null ? histQ.data.current.toLocaleString() : '—'} />
        <StatTile label="Δ 24h" value={d24.text} deltaTone={d24.tone} />
        <StatTile label="Δ 7d"  value={d7.text}  deltaTone={d7.tone} />
      </div>

      {/* Token-metadata panel */}
      {acc && <TokenPanel account={acc} />}

      {/* Chart cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title="Followers over time" icon="graph" delay={120}>
          {points.length > 0
            ? <SubsHistoryChart points={points.map(p => ({ at: p.at, subs: p.followers }))} />
            : <EmptyState
                icon="info"
                title="No follower data yet"
                note="Collected hourly for Instagram & Facebook (Threads needs insights access)."
              />}
        </SectionCard>

        <SectionCard title="Reach & impressions" icon="graph" delay={180}>
          {insLoading
            ? <EmptyState icon="refresh" title="Loading insight data…" />
            : hasReach
              ? <MetaReachImpressionsChart points={insPoints} />
              : <InsightEmpty platform={acc?.platform} />}
        </SectionCard>

        <SectionCard title="Profile views" icon="graph" delay={240}>
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
