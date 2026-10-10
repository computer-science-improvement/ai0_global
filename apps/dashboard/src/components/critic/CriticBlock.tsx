// The pre-publish critic's verdict (spec 034 FR-004): verdict badge, six scores
// (1–5) and the critic's notes, as written. Used on approval cards and on chat
// draft cards (advisory there).

import { Badge } from '../ui/Badge';
import { criticFootnote, scoreList, verdictBadge, type CriticVerdict } from '../../lib/critic';

export function CriticBlock({ critic, where }: { critic: CriticVerdict; where: 'approval' | 'draft' }) {
  const badge = verdictBadge(critic);
  const scores = scoreList(critic);
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
      {critic.notes && (
        <div className="text-micro" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>
          {critic.notes}
        </div>
      )}
      {earlier && (
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>
          First pass ({earlier.verdict}): {earlier.notes}
        </div>
      )}
      {foot && <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{foot}</div>}
    </div>
  );
}
