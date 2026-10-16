// Reviews tab of /app/agents/manager (spec 021 FR-009): the timeline of
// manager runs — verdict (continue / directives / skipped), the summary and
// chips of the directives that run filed (linking into the Directives board) and,
// since spec 034, the content-quality checklist the manager answered per resource.
// Each run is a compact card (verdict, date, the first lines of the summary, counts);
// a click opens a dialog with the full summary, the checklist and the directive links.

import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { EmptyState, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { fmtDate, fmtRelative } from '../../lib/format';
import { CompactCard } from '../ui/CompactCard';
import { useDirectives, useManagerReviews, type Directive, type ManagerReview, type ReviewVerdict } from '../../api/manager';
import { NetworkError } from './NetworkUi';
import { DIRECTIVE_KIND_LABEL, DIRECTIVE_STATUS_LABEL, DIRECTIVE_STATUS_TONE } from './Directives';
import { CHECK_ITEM_LABEL, type QualityCheckEntry } from '../../lib/quality-view';

/** Spec 034 FR-006: the manager's quality checklist of one run. */
function QualityCheckList({ items }: { items: QualityCheckEntry[] }) {
  const issues = items.filter((x) => x.status === 'issue').length;
  return (
    <div>
      <div className="text-eyebrow" style={{ marginBottom: 6 }}>
        Quality check · {issues} issue{issues === 1 ? '' : 's'} on {items.length} resource{items.length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((x) => (
          <div key={x.resource_ref} className="text-micro" style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone={x.status === 'issue' ? 'warning' : 'success'}>{x.status === 'issue' ? 'issue' : 'ok'}</Badge>
              <span style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{x.resource_ref}</span>
              {x.issues.map((i) => <span key={i} className="chip" style={{ fontSize: 10 }}>{CHECK_ITEM_LABEL[i] ?? i.replace(/_/g, ' ')}</span>)}
            </div>
            <div style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', marginTop: 2 }}>{x.evidence}</div>
            {x.note && <div style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere', marginTop: 2 }}>Note: {x.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

const VERDICT: Record<ReviewVerdict, { tone: Tone; label: string; dot: string }> = {
  continue:   { tone: 'success', label: 'continue',   dot: 'var(--color-success)' },
  directives: { tone: 'accent',  label: 'directives', dot: 'var(--color-accent)' },
  skipped:    { tone: 'neutral', label: 'skipped',    dot: 'var(--color-ink-dim)' },
};

const DOT_TONE: Record<Tone, string> = {
  success: 'var(--color-success)', warning: 'var(--color-warning)', danger: 'var(--color-danger)', accent: 'var(--color-accent)', neutral: 'var(--color-ink-dim)',
};

export function ManagerReviews() {
  const q = useManagerReviews(50);
  const dq = useDirectives();
  const byId = useMemo(() => new Map((dq.data?.directives ?? []).map((d) => [d.id, d])), [dq.data]);

  if (q.error) return <NetworkError error={q.error} />;
  if (!q.data) return <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />;
  const reviews = q.data.reviews;
  if (!reviews.length) {
    return <EmptyState icon="history" title="No manager runs yet"
      note="Each scheduled run reads the KPI digest and the content quality, answers the quality checklist per resource, and files up to three directives or says “continue”. Runs with an unchanged digest are skipped without a model call." />;
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
      {reviews.map((r, i) => {
        const v = VERDICT[r.verdict] ?? VERDICT.skipped;
        const last = i === reviews.length - 1;
        return (
          <li key={r.id} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 10 }}>
            <div aria-hidden style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
              {!last && <span style={{ position: 'absolute', top: 18, bottom: -14, width: 1, background: 'var(--color-hairline)' }} />}
              <span style={{ marginTop: 14, width: 9, height: 9, borderRadius: 'var(--radius-pill)', background: v.dot, boxShadow: '0 0 0 3px var(--color-canvas)' }} />
            </div>
            <div style={{ paddingBottom: 10, minWidth: 0 }}>
              <ReviewCard r={r} byId={byId} delay={Math.min(i, 12) * 25} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "2 issues · 3 directives" — what a run found and filed. */
function reviewCounts(r: ManagerReview): string {
  const issues = (r.qualityCheck ?? []).filter((x) => x.status === 'issue').length;
  const parts: string[] = [];
  if (r.qualityCheck?.length) parts.push(`${issues} issue${issues === 1 ? '' : 's'}`);
  if (r.directiveIds.length) parts.push(`${r.directiveIds.length} directive${r.directiveIds.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** One manager run as a compact card; the dialog has the full summary, the quality checklist and the directives it filed. */
function ReviewCard({ r, byId, delay }: { r: ManagerReview; byId: Map<string, Directive>; delay: number }) {
  const v = VERDICT[r.verdict] ?? VERDICT.skipped;
  const counts = reviewCounts(r);
  return (
    <CompactCard delay={delay} hint="Open the review"
      top={<>
        <Badge tone={v.tone}>{v.label}</Badge>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{fmtDate(r.createdAt)}</span>
      </>}
      meta={fmtRelative(r.createdAt)}
      body={r.summary ? <span style={{ color: r.verdict === 'skipped' ? 'var(--color-ink-muted)' : 'var(--color-ink)' }}>{r.summary}</span> : undefined}
      extra={counts ? <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>{counts}</span> : undefined}
      dialog={{
        size: 'lg', icon: 'history', title: `Manager run · ${v.label}`,
        subtitle: `${fmtDate(r.createdAt)} · ${fmtRelative(r.createdAt)}${counts ? ` · ${counts}` : ''}`,
        body: () => <ReviewDetails r={r} byId={byId} />,
      }} />
  );
}

function ReviewDetails({ r, byId }: { r: ManagerReview; byId: Map<string, Directive> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {r.summary
        ? <div className="text-body-sm" style={{ color: r.verdict === 'skipped' ? 'var(--color-ink-muted)' : 'var(--color-ink)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{r.summary}</div>
        : <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No summary.</div>}
      {r.qualityCheck && r.qualityCheck.length > 0 && <QualityCheckList items={r.qualityCheck} />}
      {r.directiveIds.length > 0 && (
        <div>
          <div className="text-eyebrow" style={{ marginBottom: 6 }}>Directives filed</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {r.directiveIds.map((id) => {
              const d = byId.get(id);
              return (
                <Link key={id} to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: id }}
                  className="chip" title={d ? `${DIRECTIVE_STATUS_LABEL[d.status]} — ${d.body}` : 'Open on the Directives board'}
                  style={{ fontSize: 11, gap: 5, textDecoration: 'none', maxWidth: '100%', minWidth: 0 }}>
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: 'var(--radius-pill)', flexShrink: 0, background: d ? DOT_TONE[DIRECTIVE_STATUS_TONE[d.status]] : 'var(--color-ink-dim)' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d ? `${DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind}${d.to ? ` → @${d.to}` : ''}` : `directive ${id.slice(0, 6)}`}
                  </span>
                  <Icon name="chevron-right" size={11} />
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
