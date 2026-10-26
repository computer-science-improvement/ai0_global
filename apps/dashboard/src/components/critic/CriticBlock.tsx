// The pre-publish critic's verdict (spec 034 FR-004): verdict badge, the scores
// (1–5; `owner_rules` when the channel has rules, spec 040), the owner rules the
// post broke, the critic's notes as written, (spec 067) its remarks one by one and
// (spec 041) the exact edits code applied before publishing. Used on approval cards, on chat
// draft cards (advisory there) and on plan slots (written posts, dry-run previews).

import { Badge } from '../ui/Badge';
import { coverageNote, criticFootnote, issueList, scoreList, verdictBadge, type CriticVerdict, type CriticWhere } from '../../lib/critic';

export function CriticBlock({ critic, where }: { critic: CriticVerdict; where: CriticWhere }) {
  const badge = verdictBadge(critic);
  const scores = scoreList(critic);
  const issues = issueList(critic);
  const coverage = coverageNote(critic);
  const foot = criticFootnote(critic, where);
  const earlier = critic.history?.[0];
  return (
    <div
      data-testid="critic-block"
      style={{
        marginTop: 10, padding: '8px 10px', background: 'var(--color-surface-1)',
        border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-md)', display: 'grid', gap: 6, minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {critic.model && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>{critic.model}</span>}
      </div>
      {scores.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {scores.map((s) => (
            <Badge key={s.key} tone={s.tone} title={s.hint}>
              {s.label} <span className="tabular-nums" style={{ fontWeight: 600 }}>{s.value}/5</span>
            </Badge>
          ))}
        </div>
      )}
      {critic.broken_rules?.length ? (
        <div className="text-micro" style={{ color: 'var(--color-danger)', overflowWrap: 'anywhere' }}>
          Breaks your rules: {critic.broken_rules.map((id) => `#${id}`).join(', ')}
        </div>
      ) : null}
      {critic.notes && (
        <div className="text-micro" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
          {critic.notes}
        </div>
      )}
      {issues.length > 0 && (
        <div data-testid="critic-issues" style={{ display: 'grid', gap: 4 }}>
          {issues.map((i, k) => (
            <div key={k} className="text-micro" style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
              <Badge tone={i.tone}>{i.kind}</Badge>
              <span style={{ color: 'var(--color-ink-dim)' }}>{i.label}</span>
              {i.quote && <span style={{ color: 'var(--color-ink-dim)' }}>«{i.quote}»</span>}
              <span style={{ color: 'var(--color-ink)' }}>{i.fix}</span>
            </div>
          ))}
        </div>
      )}
      {critic.edits_applied?.length ? (
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>
          Edits applied before publishing: {critic.edits_applied.map((e) => `«${e.from}» → «${e.to}»`).join('; ')}
        </div>
      ) : null}
      {earlier && (
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>
          First pass ({earlier.verdict}): {earlier.notes}
        </div>
      )}
      {coverage && <div className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>{coverage}</div>}
      {foot && <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{foot}</div>}
    </div>
  );
}
