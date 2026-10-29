// Reviews tab of /app/agents/manager (spec 021 FR-009): the timeline of
// manager runs — verdict (continue / directives / skipped), the summary and
// chips of the directives that run filed (linking into the Directives board) and,
// since spec 034, the content-quality checklist the manager answered per resource.
// Each run is a compact card (verdict, date, the first lines of the summary, counts);
// a click opens a dialog with the full summary, the checklist and the directive links.
// Spec 078 D3: the timeline, the checklist rows and the directive chips are classes (amg-* in agent-manager.css).

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
    <div className="amg-section">
      <div className="amg-sechead">
        <span className="text-overline">Quality check</span>
        <span className="amg-count">{issues} issue{issues === 1 ? '' : 's'} on {items.length} resource{items.length === 1 ? '' : 's'}</span>
      </div>
      <div className="inset amg-rows">
        {items.map((x) => (
          <div key={x.resource_ref} className="panel-row amg-qrow">
            <div className="amg-qrow-top">
              <Badge tone={x.status === 'issue' ? 'warning' : 'success'}>{x.status === 'issue' ? 'issue' : 'ok'}</Badge>
              <span className="text-micro mono amg-ink amg-wrap">{x.resource_ref}</span>
              {x.issues.map((i) => <span key={i} className="chip mono">{CHECK_ITEM_LABEL[i] ?? i.replace(/_/g, ' ')}</span>)}
            </div>
            <div className="text-micro amg-muted amg-wrap">{x.evidence}</div>
            {x.note && <div className="text-micro amg-dim amg-wrap">Note: {x.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

const VERDICT: Record<ReviewVerdict, { tone: Tone; label: string }> = {
  continue:   { tone: 'success', label: 'continue' },
  directives: { tone: 'accent',  label: 'directives' },
  skipped:    { tone: 'neutral', label: 'skipped' },
};

export function ManagerReviews() {
  const q = useManagerReviews(50);
  const dq = useDirectives();
  const byId = useMemo(() => new Map((dq.data?.directives ?? []).map((d) => [d.id, d])), [dq.data]);

  if (q.error) return <NetworkError error={q.error} />;
  if (!q.data) return <div className="amg-skeleton" aria-hidden />;
  const reviews = q.data.reviews;
  if (!reviews.length) {
    return <EmptyState icon="history" title="No manager runs yet"
      note="Each scheduled run reads the KPI digest and the content quality, answers the quality checklist per resource, and files up to three directives or says “continue”. Runs with an unchanged digest are skipped without a model call." />;
  }

  return (
    <ol className="amg-tl" aria-label="Manager runs, newest first">
      {reviews.map((r, i) => {
        const v = VERDICT[r.verdict] ?? VERDICT.skipped;
        const last = i === reviews.length - 1;
        return (
          <li key={r.id} className={`amg-tl-item${last ? ' is-last' : ''}`}>
            <div aria-hidden className="amg-tl-rail"><span className={`amg-dot amg-tl-dot is-${v.tone}`} /></div>
            <div className="amg-tl-card">
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
        <span className="text-micro mono amg-muted">{fmtDate(r.createdAt)}</span>
      </>}
      meta={fmtRelative(r.createdAt)}
      body={r.summary ? <span className={r.verdict === 'skipped' ? 'amg-muted' : 'amg-ink'}>{r.summary}</span> : undefined}
      extra={counts ? <span className="amg-count">{counts}</span> : undefined}
      dialog={{
        size: 'lg', icon: 'history', title: `Manager run · ${v.label}`,
        subtitle: `${fmtDate(r.createdAt)} · ${fmtRelative(r.createdAt)}${counts ? ` · ${counts}` : ''}`,
        body: () => <ReviewDetails r={r} byId={byId} />,
      }} />
  );
}

function ReviewDetails({ r, byId }: { r: ManagerReview; byId: Map<string, Directive> }) {
  return (
    <div className="amg-stack is-roomy">
      {r.summary
        ? <div className={`text-body-sm amg-wrap amg-pre ${r.verdict === 'skipped' ? 'amg-muted' : 'amg-ink'}`}>{r.summary}</div>
        : <div className="text-micro amg-dim">No summary.</div>}
      {r.qualityCheck && r.qualityCheck.length > 0 && <QualityCheckList items={r.qualityCheck} />}
      {r.directiveIds.length > 0 && (
        <div className="amg-section">
          <div className="amg-sechead"><span className="text-overline">Directives filed</span></div>
          <div className="amg-chips">
            {r.directiveIds.map((id) => {
              const d = byId.get(id);
              return (
                <Link key={id} to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: id }}
                  className="chip mono amg-dchip" title={d ? `${DIRECTIVE_STATUS_LABEL[d.status]} — ${d.body}` : 'Open on the Directives board'}>
                  <span aria-hidden className={`amg-dot${d ? ` is-${DIRECTIVE_STATUS_TONE[d.status]}` : ''}`} />
                  <span className="amg-trunc">
                    {d ? `${DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind}${d.to ? ` → @${d.to}` : ''}` : `directive ${id.slice(0, 6)}`}
                  </span>
                  <Icon name="chevron-right" size={12} />
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
