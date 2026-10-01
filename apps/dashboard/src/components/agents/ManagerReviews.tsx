// Reviews tab of /app/agents/manager (spec 021 FR-009): the timeline of
// manager runs — verdict (continue / directives / skipped), the summary and
// chips of the directives that run filed (linking into the Directives board).

import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { EmptyState, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useDirectives, useManagerReviews, type ReviewVerdict } from '../../api/manager';
import { NetworkError } from './NetworkUi';
import { DIRECTIVE_KIND_LABEL, DIRECTIVE_STATUS_LABEL, DIRECTIVE_STATUS_TONE } from './Directives';

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
      note="Each scheduled run reads the KPI digest and either says “continue” or files up to three directives. Runs with an unchanged digest are skipped without a model call." />;
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
      {reviews.map((r, i) => {
        const v = VERDICT[r.verdict] ?? VERDICT.skipped;
        const last = i === reviews.length - 1;
        return (
          <li key={r.id} className="compose-rise" style={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr)', gap: 10, animationDelay: `${Math.min(i, 12) * 25}ms` }}>
            <div aria-hidden style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
              {!last && <span style={{ position: 'absolute', top: 16, bottom: -2, width: 1, background: 'var(--color-hairline)' }} />}
              <span style={{ marginTop: 6, width: 9, height: 9, borderRadius: 'var(--radius-pill)', background: v.dot, boxShadow: '0 0 0 3px var(--color-canvas)' }} />
            </div>
            <div style={{ paddingBottom: 16, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <Badge tone={v.tone}>{v.label}</Badge>
                <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }} title={fmtDate(r.createdAt)}>{fmtDate(r.createdAt)}</span>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{fmtRelative(r.createdAt)}</span>
              </div>
              {r.summary && (
                <div className="text-body-sm" style={{ color: r.verdict === 'skipped' ? 'var(--color-ink-muted)' : 'var(--color-ink)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                  {r.summary}
                </div>
              )}
              {r.directiveIds.length > 0 && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
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
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
