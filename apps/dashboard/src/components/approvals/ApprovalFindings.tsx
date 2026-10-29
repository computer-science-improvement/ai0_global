// Spec 037 FR-014 (T14): what the code's checks found in a waiting post, shown on
// the approval card before the owner approves — story matches (with links to the
// earlier posts), numbers without a source, date checks and the other lint
// warnings. Each finding: the rule, the words of the post it is about, how to fix.
// Spec 078 D4: an inset with an overline per section. Styles: approvals.css (appr-).

import { Badge } from '../ui/Badge';
import { FindingRefs } from '../agents/PostAuditNotes';
import { findingsBySection, type ApprovalFinding } from '../../lib/audit-view';

export function ApprovalFindings({ findings }: { findings: ApprovalFinding[] | null | undefined }) {
  const sections = findingsBySection(findings);
  if (!sections.length) return null;
  return (
    <div data-testid="approval-findings" className="inset appr-findings">
      {sections.map((s) => (
        <div key={s.section} className="appr-findings-section">
          <span className="text-overline">{s.label} · {s.items.length}</span>
          {s.items.map((f, i) => (
            <div key={`${f.code}${i}`} className="appr-finding">
              <div className="appr-finding-head">
                <Badge tone={f.level === 'error' ? 'danger' : 'warning'}>{f.level}</Badge>
                <span className="text-caption appr-finding-title" title={f.explain}>{f.title}</span>
              </div>
              {f.excerpt && <div className="text-micro appr-excerpt">“{f.excerpt}”</div>}
              <div className="text-micro appr-muted appr-wrap">
                {f.explain} <span className="appr-ink">Fix: {f.fix}</span>
              </div>
              <FindingRefs extra={f.extra} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
