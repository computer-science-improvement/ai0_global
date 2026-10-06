// Description fixes agents suggested for a dataset (spec 032 FR-010, pending action `edit_data_schema`).
// Agents never change structure; the owner applies a text edit with one click (no version bump).

import { Icon } from '../ui/Icon';
import { SectionCard } from '../ui/primitives';
import { describeError, toast } from '../ui/Toast';
import { fmtRelative } from '../../lib/format';
import { useDataSuggestions, useDecideSuggestion, type DataSuggestion } from '../../api/data';

const what = (s: DataSuggestion) =>
  s.target === 'field' ? `Field ${s.field ?? ''}` : s.target === 'suitable_for' ? 'Suitable for' : 'Dataset description';

export function DataSuggestions({ schema }: { schema: string }) {
  const q = useDataSuggestions(schema);
  const decide = useDecideSuggestion();
  const items = q.data ?? [];
  if (!items.length) return null;

  const act = (s: DataSuggestion, decision: 'apply' | 'discard') => decide.mutate({ id: s.id, decision }, {
    onSuccess: (r) => {
      if (r.action.status === 'failed') toast.error(r.action.error ?? 'Could not apply the suggestion');
      else if (r.action.status === 'expired') toast.error('The suggestion expired (24 h); ask the agent again');
      else toast.success(decision === 'apply' ? 'Description updated' : 'Suggestion discarded');
    },
    onError: (e) => toast.error(describeError(e)),
  });

  return (
    <SectionCard title={`Suggestions from agents · ${items.length}`} icon="sparkles">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((s) => (
          <div key={s.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong className="text-body-sm">{what(s)}</strong>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                {s.agent ? `@${s.agent}` : 'an agent'} · {fmtRelative(s.created_at)}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
              <div>
                <div className="text-eyebrow" style={{ marginBottom: 4 }}>Now</div>
                <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', textDecoration: s.old_text ? 'line-through' : undefined }}>
                  {s.old_text || <em>empty</em>}
                </div>
              </div>
              <div>
                <div className="text-eyebrow" style={{ marginBottom: 4 }}>Suggested</div>
                <div className="text-body-sm" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{s.new_text}</div>
              </div>
            </div>
            <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>Why: {s.evidence}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn-secondary" disabled={decide.isPending} onClick={() => act(s, 'discard')}>Discard</button>
              <button type="button" className="btn-primary" disabled={decide.isPending} onClick={() => act(s, 'apply')}>
                <Icon name="check" size={14} /> Apply
              </button>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
