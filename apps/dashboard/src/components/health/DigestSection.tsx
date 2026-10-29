// The KPI digest on /app/health (spec 021 FR-009, brought back by spec 078 D4): what the MANAGER reads from GET /api/kpi/digest —
// per resource its health and KPIs (7-day value, change against the 28-day baseline, anomaly and stale flags) and, from spec 034
// FR-006 and spec 037 FR-014, its 7-day content quality (critic pass rate, polls against the cap, your rejections and edits, the
// code's quality flags, notes, sample texts, the post audit and the feed fit); the directives waiting for the owner; and how each
// orchestrator answered @manager over 30 days (spec 025 FR-017).
// It used to be the "Network health" card on the old Overview; the Today page no longer shows it. Flagged resources come first;
// on a phone only they show, with a toggle for the healthy ones. Each resource is a compact card that opens a dialog.
// The pure parts (order, counts, KPI texts) are in lib/digest-view.ts. Styles: digest.css (hd-), loaded by routes/app.tsx.

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { EmptyState, SectionCard, StatStrip, StatTile } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { CompactCard } from '../ui/CompactCard';
import { Icon, type IconName } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { HEALTH } from '../agents/ResourceProfile';
import { PLATFORM_LABEL, PlatformIcon } from '../agents/NetworkUi';
import { fmtPct, metricLabel } from '../agents/Directives';
import { FeedFitList, PostAuditNotes } from '../agents/PostAuditNotes';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { tabSearch } from '../../lib/agent-tabs';
import { awaitingLine, deltaTone, fmtKpi, healthyToggleLabel, issueCount, kpiTitle, sortByIssues, summarize, visibleResources } from '../../lib/digest-view';
import { flagLabel, qualityActive, qualityStats, type ResourceQuality } from '../../lib/quality-view';
import { KPI_NAMES, useKpiDigest, type ComplianceRow, type DigestResource, type KpiName, type KpiValue } from '../../api/manager';
import type { HealthState } from '../../api/agents';
import { parseRef, useResourceLabels } from '../../api/network';

const PLATFORM_ICON: Record<string, IconName> = {
  telegram: 'telegram', facebook: 'facebook', instagram: 'instagram', threads: 'threads', tiktok: 'tiktok', youtube: 'globe',
};

/** The KPIs a resource card shows; its dialog has all six. */
const HEADLINE_KPIS: KpiName[] = ['views_per_post', 'engagement_rate', 'followers_growth'];

/** The health badge of a resource: its state, or "not checked" when the digest has none. */
function HealthChip({ health }: { health: string | null }) {
  if (!health) return <Badge tone="neutral" title="The resource has not been checked yet">not checked</Badge>;
  const h = HEALTH[health as HealthState] ?? HEALTH.unknown;
  return <Badge tone={h.tone}>{h.label}</Badge>;
}

// ── a resource ───────────────────────────────────────────────────────────────

/** One headline KPI on a card: its 7-day value and the change against the baseline. */
function KpiCell({ name, k }: { name: KpiName; k: KpiValue | undefined }) {
  const stale = !!k?.stale;
  return (
    <span className={`hd-kpi${stale ? ' is-stale' : ''}${k?.anomaly ? ' is-anomaly' : ''}`} title={kpiTitle(name, metricLabel(name), k)}>
      <span className="hd-kpi-label">{metricLabel(name)}</span>
      <span className="hd-kpi-row">
        <span className="hd-kpi-value">{fmtKpi(name, k?.v)}</span>
        <span className={`hd-kpi-delta is-${deltaTone(k)}`}>{stale ? '—' : fmtPct(k?.d ?? null, 0)}</span>
      </span>
    </span>
  );
}

/** All six KPIs of a resource: value over the last 7 days and the change against the 28-day baseline. */
function KpiTable({ r }: { r: DigestResource }) {
  return (
    <div className="table-wrap">
      <table className="table" aria-label="KPIs over the last 7 days">
        <thead><tr>
          <th>KPI · 7 days</th>
          <th className="num">Value</th>
          <th className="num" title="Change against the 28-day baseline">vs 28 days</th>
        </tr></thead>
        <tbody>
          {KPI_NAMES.map((n) => {
            const k = r.kpis[n];
            const stale = !!k?.stale;
            return (
              <tr key={n} title={kpiTitle(n, metricLabel(n), k)} className={stale ? 'hd-row-stale' : undefined}>
                <td>
                  <span className="hd-kpi-name">
                    {metricLabel(n)}
                    {k?.anomaly && <Badge tone="warning" title="Far from the 28-day baseline">anomaly</Badge>}
                    {stale && <Badge tone="neutral" title="No fresh data for this KPI">stale</Badge>}
                  </span>
                </td>
                <td className="num">{fmtKpi(n, k?.v)}</td>
                <td className={`num hd-kpi-delta is-${deltaTone(k)}`}>{stale ? '—' : fmtPct(k?.d ?? null, 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Spec 034 FR-006: the resource's content-quality block (in the resource dialog, notes and samples shown in full). */
function QualityBlock({ q, resource }: { q: ResourceQuality | null | undefined; resource: string }) {
  if (!qualityActive(q)) return <p className="hd-quality-empty">Content quality · no posts in 7 days</p>;
  const notes = [
    ...q.critic.notes.map((n) => ({ tag: 'Critic', text: n })),
    ...q.owner.reasons.map((n) => ({ tag: 'You rejected', text: n })),
    ...q.owner.edits.map((n) => ({ tag: 'You edited', text: n })),
  ];
  const hasMore = notes.length > 0 || q.samples.length > 0 || !!q.audit || (q.feeds?.length ?? 0) > 0 || q.posts > 0;
  return (
    <section className="hd-quality" aria-label="Content quality">
      <div className="hd-quality-head">
        <span className="text-overline">Content quality · {q.days} d</span>
        <span className="mono hd-dim">{q.posts} post{q.posts === 1 ? '' : 's'}</span>
      </div>
      <div className="inset hd-stats">
        {qualityStats(q).map((s) => (
          <div key={s.key} className={`hd-stat is-${s.tone}`} title={s.title}>
            <span className="hd-stat-label">{s.label}</span>
            <span className="hd-stat-value">{s.value}</span>
          </div>
        ))}
      </div>
      {q.flags.length > 0 && (
        <div className="hd-flags">
          {q.flags.map((f) => <Badge key={f} tone={f === 'owner_edits' || f === 'critic_failed' ? 'warning' : 'danger'}>{flagLabel(f)}</Badge>)}
        </div>
      )}
      {hasMore && (
        <div className="hd-notes">
          <span className="text-overline">Notes and sample posts{q.audit?.findings ? ` · ${q.audit.findings} issue${q.audit.findings === 1 ? '' : 's'}` : ''}</span>
          <PostAuditNotes resource={resource} summary={q.audit} open />
          {q.feeds && q.feeds.length > 0 && <FeedFitList feeds={q.feeds} />}
          {notes.map((n, i) => (
            <div key={`n${i}`} className="text-micro hd-note-line">
              <span className="chip hd-tag">{n.tag}</span>{n.text}
            </div>
          ))}
          {q.samples.map((s, i) => (
            <div key={`s${i}`} className="inset hd-sample">
              <div className="text-micro mono hd-dim">{s.format} · {s.status.replace(/_/g, ' ')} · {fmtRelative(s.at)}</div>
              <div className="text-body-sm hd-sample-text">{s.text}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A resource of the digest as a compact card: name, platform, health, three headline KPIs and the count of anomalies and
 * quality flags. A click opens the dialog with all KPIs, the content quality, notes, samples and the post audit.
 */
function ResourceTile({ r, delay }: { r: DigestResource; delay: number }) {
  const label = useResourceLabels();
  const l = label(r.ref);
  const platform = parseRef(r.ref).platform;
  const name = r.title || l.label;
  const sub = r.title ? l.label : platform ? PLATFORM_LABEL[platform] : r.ref;
  const anomalies = r.anomalies.length;
  const flags = r.quality?.flags.length ?? 0;
  const note = [
    anomalies ? `${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}` : '',
    flags ? `${flags} quality flag${flags === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <CompactCard delay={delay} attention={issueCount(r) > 0} hint="Open the resource"
      top={<><PlatformIcon platform={platform} size={13} /><HealthChip health={r.health} /></>}
      meta={r.agent ? <span className="mono">@{r.agent}</span> : undefined}
      title={<span title={r.ref}>{name}</span>}
      extra={<span className="hd-kpis">{HEADLINE_KPIS.map((n) => <KpiCell key={n} name={n} k={r.kpis[n]} />)}</span>}
      note={note || undefined}
      noteTone={flags ? 'danger' : 'warning'}
      dialog={{
        size: 'md', icon: platform ? PLATFORM_ICON[platform] ?? 'globe' : 'globe', title: name, subtitle: sub,
        body: () => (
          <div className="hd-dialog">
            <div className="hd-dialog-head">
              <HealthChip health={r.health} />
              <span className="text-micro mono hd-dim hd-ref">{r.ref}</span>
              {r.agent && <Link to="/app/agents/$handle" params={{ handle: r.agent }} className="link-accent text-micro mono hd-agent">@{r.agent}</Link>}
            </div>
            <KpiTable r={r} />
            {r.quality !== undefined && <QualityBlock q={r.quality} resource={r.ref} />}
          </div>
        ),
      }} />
  );
}

// ── answers to @manager ──────────────────────────────────────────────────────

/** Spec 025 FR-017: how each orchestrator answered @manager over 30 days (the digest's compliance block). */
function ComplianceCard({ rows, delay }: { rows: ComplianceRow[]; delay: number }) {
  return (
    <SectionCard title="Answers to @manager" icon="inbox" delay={delay} style={{ marginBottom: 16 }}
      action={<span className="mono hd-count" title="Shadow directives are left out">30 days</span>}>
      {!rows.length ? <p className="hd-clear">No directive was answered in the last 30 days.</p> : (
        <>
          <p className="text-caption hd-lead">How each orchestrator answered @manager's directives. Shadow directives are left out.</p>
          <div className="table-wrap">
            <table className="table" aria-label="Answers to @manager over 30 days">
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
                      <td><Link to="/app/agents/$handle" params={{ handle: r.agent }} search={tabSearch('inbox')} className="link-accent mono">@{r.agent}</Link></td>
                      <td className="num">{r.advice_followed}</td>
                      <td className="num">{r.advice_declined}</td>
                      <td className="num">{r.contested ? <Badge tone="warning">{r.contested}</Badge> : r.contested}</td>
                      <td className="num">{r.auto_applied}</td>
                      <td className="hd-reason">
                        {last
                          ? <span className="text-micro hd-reason-text" title={r.decline_reasons.map((x) => `${x.kind}: ${x.reason}`).join('\n')}>
                              <span className="chip mono hd-tag">{last.kind.replace(/_/g, ' ')}</span>{last.reason}
                            </span>
                          : <span className="hd-dim">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ── the section ──────────────────────────────────────────────────────────────

/** The line that titles the block: a group overline and how fresh the digest is. */
function Head({ generatedAt }: { generatedAt?: string }) {
  return (
    <div className="hd-head">
      <span className="text-overline">KPI digest</span>
      {generatedAt && <span className="mono hd-age" title={fmtDate(generatedAt)}>updated {fmtRelative(generatedAt)}</span>}
    </div>
  );
}

export function DigestSection({ delay = 0 }: { delay?: number }) {
  const q = useKpiDigest();
  const phone = useMediaQuery('(max-width: 600px)');
  const [showAll, setShowAll] = useState(false);

  if (q.error) {
    return (
      <div className="hd-digest">
        <Head />
        <div className="callout-danger" role="alert">{describeError(q.error)}</div>
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="hd-digest">
        <Head />
        <div className="hd-skeleton" aria-busy="true" />
      </div>
    );
  }

  const dg = q.data;
  const s = summarize(dg);
  const sorted = sortByIssues(dg.resources);
  const shown = visibleResources(sorted, phone, showAll);
  const noneVisible = shown.length === 0;

  return (
    <div className="hd-digest">
      <Head generatedAt={dg.generatedAt} />
      <StatStrip label="KPI digest at a glance" style={{ marginBottom: 16 }}>
        <StatTile label="Resources" value={s.resources}
          delta={!s.resources ? 'none yet' : s.flagged ? `${s.flagged} flagged` : 'none flagged'} deltaTone={s.flagged ? 'warning' : s.resources ? 'success' : 'neutral'} />
        <StatTile label="Anomalies" value={s.anomalies}
          delta={s.anomalies ? 'KPIs off their baseline' : 'all within baseline'} deltaTone={s.anomalies ? 'warning' : 'success'} />
        <StatTile label="Quality flags" value={s.qualityFlagged}
          delta={s.qualityFlagged ? (s.qualityFlagged === 1 ? 'resource flagged' : 'resources flagged') : 'none flagged'} deltaTone={s.qualityFlagged ? 'danger' : 'success'} />
        <StatTile label="Open directives" value={s.open}
          delta={<Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={tabSearch('directives')} className={`hd-link${s.awaiting ? ' is-warn' : ''}`}>{awaitingLine(s.awaiting)} →</Link>}
          deltaTone={s.awaiting ? 'warning' : 'neutral'} />
        <StatTile label="Agents spent today" value={`$${s.spentTodayUsd.toFixed(2)}`}
          delta={<Link to="/app/spend" className="hd-link">AI spend →</Link>} />
      </StatStrip>

      <SectionCard title="Resources" icon="analytics" delay={delay} style={{ marginBottom: 16 }}
        action={s.resources ? <span className={`mono hd-count${s.flagged ? ' is-warn' : ''}`}>{s.flagged} flagged · {s.healthy} healthy</span> : undefined}>
        {!s.resources ? (
          <EmptyState icon="globe" title="No resources in the digest yet" note="Connect a channel and give it an orchestrator." />
        ) : (
          <>
            {noneVisible
              ? <p className="hd-clear">No resource is flagged.</p>
              : <div className="hd-grid">{shown.map((r, i) => <ResourceTile key={r.ref} r={r} delay={Math.min(i, 12) * 25} />)}</div>}
            {phone && s.healthy > 0 && (
              <button type="button" className="btn-secondary btn-sm hd-toggle" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                <Icon name={showAll ? 'chevron-up' : 'check'} size={14} />
                {healthyToggleLabel(s.healthy, showAll)}
              </button>
            )}
          </>
        )}
      </SectionCard>

      {dg.compliance && <ComplianceCard rows={dg.compliance} delay={delay + 60} />}
    </div>
  );
}
