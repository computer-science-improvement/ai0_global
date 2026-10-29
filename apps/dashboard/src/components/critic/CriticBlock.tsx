// The pre-publish critic's verdict (spec 034 FR-004): verdict badge, the scores
// (1–5; `owner_rules` when the channel has rules, spec 040), the owner rules the
// post broke, the critic's notes as written, (spec 067) its remarks one by one and
// (spec 041) the exact edits code applied before publishing. Used on approval cards, on chat
// draft cards (advisory there) and on plan slots (written posts, dry-run previews).
// Spec 078 D3: an .inset with amg-* classes (agent-manager.css); no inline colour.

import { Badge } from '../ui/Badge';
import { coverageNote, criticFootnote, issueList, scoreList, skippedRulesNote, verdictBadge, type CriticVerdict, type CriticWhere } from '../../lib/critic';

export function CriticBlock({ critic, where }: { critic: CriticVerdict; where: CriticWhere }) {
  const badge = verdictBadge(critic);
  const scores = scoreList(critic);
  const issues = issueList(critic);
  const coverage = coverageNote(critic);
  const skipped = skippedRulesNote(critic);
  const foot = criticFootnote(critic, where);
  const earlier = critic.history?.[0];
  return (
    <div data-testid="critic-block" className="inset amg-critic">
      <div className="amg-critic-head">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {critic.model && <span className="text-micro mono amg-dim amg-wrap">{critic.model}</span>}
      </div>
      {scores.length > 0 && (
        <div className="amg-critic-scores">
          {scores.map((s) => (
            <Badge key={s.key} tone={s.tone} title={s.hint}>
              {s.label} <span className="mono tabular-nums">{s.value}/5</span>
            </Badge>
          ))}
        </div>
      )}
      {critic.broken_rules?.length ? (
        <div className="text-micro amg-danger amg-wrap">
          Breaks your rules: {critic.broken_rules.map((id) => `#${id}`).join(', ')}
        </div>
      ) : null}
      {critic.notes && <div className="amg-critic-notes">{critic.notes}</div>}
      {issues.length > 0 && (
        <div data-testid="critic-issues" className="amg-critic-issues">
          {issues.map((i, k) => (
            <div key={k} className="text-micro amg-critic-issue">
              <Badge tone={i.tone}>{i.kind}</Badge>
              <span className="amg-dim">{i.label}</span>
              {i.quote && <span className="amg-dim">«{i.quote}»</span>}
              <span className="amg-ink">{i.fix}</span>
            </div>
          ))}
        </div>
      )}
      {critic.edits_applied?.length ? (
        <div className="text-micro amg-dim amg-wrap">
          Edits applied before publishing: {critic.edits_applied.map((e) => `«${e.from}» → «${e.to}»`).join('; ')}
        </div>
      ) : null}
      {earlier && (
        <div className="text-micro amg-dim amg-wrap">
          First pass ({earlier.verdict}): {earlier.notes}
        </div>
      )}
      {coverage && <div className="text-micro amg-dim amg-wrap">{coverage}</div>}
      {skipped && <div className="text-micro amg-dim amg-wrap">{skipped}</div>}
      {foot && <div className="text-micro amg-dim">{foot}</div>}
    </div>
  );
}
