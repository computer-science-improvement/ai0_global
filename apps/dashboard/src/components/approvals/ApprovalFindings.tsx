// Spec 037 FR-014 (T14): what the code's checks found in a waiting post, shown on
// the approval card before the owner approves — story matches (with links to the
// earlier posts), numbers without a source, date checks and the other lint
// warnings. Each finding: the rule, the words of the post it is about, how to fix.

import { Badge } from '../ui/Badge';
import { FindingRefs } from '../agents/PostAuditNotes';
import { findingsBySection, type ApprovalFinding } from '../../lib/audit-view';

export function ApprovalFindings({ findings }: { findings: ApprovalFinding[] | null | undefined }) {
  const sections = findingsBySection(findings);
  if (!sections.length) return null;
  return (
    <div data-testid="approval-findings" style={{
      marginTop: 10, padding: '8px 10px', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)',
      borderRadius: 'var(--radius-md)', display: 'grid', gap: 8, minWidth: 0,
    }}>
      {sections.map((s) => (
        <div key={s.section} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>
            {s.label} · {s.items.length}
          </div>
          {s.items.map((f, i) => (
            <div key={`${f.code}${i}`} style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
                <Badge tone={f.level === 'error' ? 'danger' : 'warning'}>{f.level}</Badge>
                <span className="text-micro" style={{ color: 'var(--color-ink)', fontWeight: 500, overflowWrap: 'anywhere' }} title={f.explain}>{f.title}</span>
              </div>
              {f.excerpt && (
                <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', borderLeft: '2px solid var(--color-hairline)', paddingLeft: 6 }}>
                  “{f.excerpt}”
                </div>
              )}
              <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>
                {f.explain} <span style={{ color: 'var(--color-ink)' }}>Fix: {f.fix}</span>
              </div>
              <FindingRefs extra={f.extra} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
