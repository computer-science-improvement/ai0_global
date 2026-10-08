// "Network health" card on the overview page (spec 021 FR-009): the KPI digest
// the MANAGER reads — per resource its health and six KPIs (7-day value, delta
// against the 28-day baseline, anomaly and stale flags), a link to the AI spend
// card (spec 029) and the directives waiting for the owner. On phones the
// resources without anomalies collapse into one line.

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useKpiDigest, KPI_NAMES, type ComplianceRow, type DigestResource, type KpiName, type KpiValue } from '../../api/manager';
import type { HealthState } from '../../api/agents';
import { HEALTH } from './ResourceProfile';
import { PLATFORM_LABEL, PlatformIcon } from './NetworkUi';
import { fmtPct, metricLabel } from './Directives';
import { parseRef, useResourceLabels } from '../../api/network';

function fmtKpi(name: KpiName, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const compact = (n: number) => (Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}K` : Number(n.toFixed(n % 1 && Math.abs(n) < 100 ? 1 : 0)).toLocaleString('en-US'));
  switch (name) {
    case 'engagement_rate':  return `${v.toFixed(v < 10 ? 2 : 1)}%`;
    case 'followers_growth': return `${v > 0 ? '+' : v < 0 ? '−' : ''}${compact(Math.abs(v))}`;
    case 'revenue':          return `₴${compact(v)}`;
    default:                 return compact(v);
  }
}

function KpiRow({ name, k }: { name: KpiName; k: KpiValue | undefined }) {
  const stale = !!k?.stale;
  const anomaly = !!k?.anomaly;
  const d = k?.d ?? null;
  const dColor = stale || d == null || d === 0 ? 'var(--color-ink-dim)' : d > 0 ? 'var(--color-success)' : 'var(--color-danger)';
  const title = k
    ? `${metricLabel(name)}: 7-day ${fmtKpi(name, k.v)} · 28-day baseline ${fmtKpi(name, k.base)}${k.z != null ? ` · z ${k.z}` : ''}${stale ? ' · stale (no fresh data)' : ''}${anomaly ? ' · anomaly' : ''}`
    : `${metricLabel(name)}: no data`;
  return (
    <div title={title} style={{
      display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 58px', gap: 8, alignItems: 'center', padding: '3px 6px', borderRadius: 'var(--radius-sm)',
      opacity: stale ? 0.5 : 1, background: anomaly ? 'var(--color-warning-soft)' : undefined,
    }}>
      <span className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, color: anomaly ? 'var(--color-warning)' : 'var(--color-ink-muted)' }}>
        {anomaly && <Icon name="warning" size={11} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metricLabel(name)}</span>
        {stale && <span style={{ color: 'var(--color-ink-dim)' }}>· stale</span>}
      </span>
      <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 500, textAlign: 'right' }}>{fmtKpi(name, k?.v ?? null)}</span>
      <span className="text-micro tabular-nums" style={{ color: dColor, textAlign: 'right', fontWeight: 500 }}>{stale ? '—' : fmtPct(d, 0)}</span>
    </div>
  );
}

function ResourceTile({ r }: { r: DigestResource }) {
  const label = useResourceLabels();
  const l = label(r.ref);
  const platform = parseRef(r.ref).platform;
  const h = r.health ? HEALTH[r.health as HealthState] ?? HEALTH.unknown : null;
  return (
    <div style={{ padding: '10px 10px 8px', borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', minWidth: 0,
      border: `1px solid ${r.anomalies.length ? 'var(--color-warning-soft)' : 'var(--color-hairline)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, padding: '0 4px' }}>
        <PlatformIcon platform={platform} size={14} />
        <span style={{ color: 'var(--color-ink)', fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={r.ref}>
          {r.title || l.label}
        </span>
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
          {h ? <Badge tone={h.tone}>{h.label}</Badge> : <Badge tone="neutral" title="The resource has not been checked yet">not checked</Badge>}
        </span>
      </div>
      <div className="text-micro" style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 4px 6px', color: 'var(--color-ink-dim)', minWidth: 0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={r.ref}>
          {r.title ? l.label : platform ? PLATFORM_LABEL[platform] : r.ref}
        </span>
        {r.agent && <Link to="/app/agents/$handle" params={{ handle: r.agent }} className="link-accent" style={{ marginLeft: 'auto', flexShrink: 0 }}>@{r.agent}</Link>}
      </div>
      {KPI_NAMES.map((n) => <KpiRow key={n} name={n} k={r.kpis[n]} />)}
    </div>
  );
}

/** Spec 025 FR-017: how each orchestrator answered @manager over 30 days (the digest's compliance block). */
function ComplianceTable({ rows }: { rows: ComplianceRow[] }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="text-eyebrow" style={{ marginBottom: 6 }} title="Shadow directives are left out">Answers to @manager · 30 days</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>
            <th>Orchestrator</th>
            <th className="num" title="Advice accepted and acted on">Advice followed</th>
            <th className="num">Advice declined</th>
            <th className="num" title="Binding directives contested to you">Contested</th>
            <th className="num" title="Binding directives left unanswered for 24 h, applied by the code">Auto-applied</th>
            <th>Last decline reason</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const last = r.decline_reasons[0];
              return (
                <tr key={r.agent}>
                  <td><Link to="/app/agents/$handle" params={{ handle: r.agent }} search={{ tab: 'inbox' }} className="link-accent">@{r.agent}</Link></td>
                  <td className="num">{r.advice_followed}</td>
                  <td className="num">{r.advice_declined}</td>
                  <td className="num" style={{ color: r.contested ? 'var(--color-warning)' : undefined }}>{r.contested}</td>
                  <td className="num">{r.auto_applied}</td>
                  <td style={{ maxWidth: 320 }}>
                    {last
                      ? <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}
                          title={r.decline_reasons.map((x) => `${x.kind}: ${x.reason}`).join('\n')}>
                          <span className="chip" style={{ fontSize: 10, marginRight: 6 }}>{last.kind.replace(/_/g, ' ')}</span>{last.reason}
                        </span>
                      : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function NetworkHealthCard({ delay }: { delay?: number }) {
  const q = useKpiDigest();
  const phone = useMediaQuery('(max-width: 600px)');
  const [showAll, setShowAll] = useState(false);

  const head = q.data
    ? <span className="text-micro" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }} title={fmtDate(q.data.generatedAt)}>updated {fmtRelative(q.data.generatedAt)}</span>
    : undefined;

  if (q.error) {
    return (
      <SectionCard delay={delay} icon="analytics" title="Network health" style={{ marginBottom: 12 }}>
        <div className="callout-danger">{describeError(q.error)}</div>
      </SectionCard>
    );
  }
  if (!q.data) {
    return (
      <SectionCard delay={delay} icon="analytics" title="Network health" style={{ marginBottom: 12 }}>
        <div style={{ height: 120, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />
      </SectionCard>
    );
  }

  const dg = q.data;
  const awaiting = dg.directives.open.filter((d) => d.status === 'awaiting_owner' || d.status === 'contested').length;
  const open = dg.directives.open.length;
  const anomalies = dg.resources.reduce((s, r) => s + r.anomalies.length, 0);
  const spent = dg.budget.spentTodayUsd;
  const sorted = [...dg.resources].sort((a, b) => b.anomalies.length - a.anomalies.length);
  const flagged = sorted.filter((r) => r.anomalies.length > 0);
  const healthy = sorted.length - flagged.length;
  const shown = phone && !showAll ? flagged : sorted;

  return (
    <SectionCard delay={delay} icon="analytics" title="Network health" action={head} style={{ marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10, marginBottom: 12 }}>
        {/* Spec 029: the spend meter moved to the AI spend card (all LLM calls, not only the agents). */}
        <a href="#ai-spend" className="link-accent text-micro"
          onClick={(e) => { const el = document.getElementById('ai-spend'); if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'center' }}>
          <Icon name="spend" size={12} />
          Agents spent ${spent.toFixed(2)} today · see AI spend
          <Icon name="chevron-down" size={11} />
        </a>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: anomalies ? 'var(--color-warning)' : 'var(--color-ink-muted)' }}>
            <Icon name={anomalies ? 'warning' : 'check'} size={12} />
            {anomalies ? `${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}` : 'no anomalies'}
          </span>
          <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives' }} className="link-accent text-micro"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: awaiting ? 'var(--color-warning)' : undefined }}>
            <Icon name="inbox" size={12} />
            {awaiting ? `${awaiting} directive${awaiting === 1 ? '' : 's'} await you` : `${open} open directive${open === 1 ? '' : 's'}`}
            <Icon name="chevron-right" size={11} />
          </Link>
        </div>
      </div>

      {dg.resources.length === 0
        ? <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>No resources in the digest yet — connect a channel and give it an orchestrator.</p>
        : (
          <>
            {shown.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))', gap: 10 }}>
                {shown.map((r) => <ResourceTile key={r.ref} r={r} />)}
              </div>
            )}
            {phone && healthy > 0 && (
              <button type="button" className="btn-tiny" style={{ marginTop: shown.length ? 10 : 0, width: '100%', justifyContent: 'center', gap: 6 }}
                aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                <Icon name={showAll ? 'chevron-up' : 'check'} size={12} />
                {showAll ? 'Show only anomalies' : `${healthy} healthy resource${healthy === 1 ? '' : 's'}`}
              </button>
            )}
          </>
        )}
      {dg.compliance && dg.compliance.length > 0 && <ComplianceTable rows={dg.compliance} />}
    </SectionCard>
  );
}
