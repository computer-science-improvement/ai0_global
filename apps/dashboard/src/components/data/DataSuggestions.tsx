// Description fixes agents suggested for a dataset (spec 032 FR-010, pending action `edit_data_schema`).
// Agents never change structure; the owner applies a text edit with one click (no version bump).
// Each suggestion is a compact card (field, agent, "now → suggested"); the dialog has both texts and the actions.

import { Icon } from '../ui/Icon';
import { SectionCard } from '../ui/primitives';
import { CompactCard } from '../ui/CompactCard';
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

  const act = (s: DataSuggestion, decision: 'apply' | 'discard', done: () => void) => decide.mutate({ id: s.id, decision }, {
    onSuccess: (r) => {
      if (r.action.status === 'failed') toast.error(r.action.error ?? 'Could not apply the suggestion');
      else if (r.action.status === 'expired') toast.error('The suggestion expired (24 h); ask the agent again');
      else toast.success(decision === 'apply' ? 'Description updated' : 'Suggestion discarded');
      done();
    },
    onError: (e) => toast.error(describeError(e)),
  });

  return (
    <SectionCard title={`Suggestions from agents · ${items.length}`} icon="sparkles">
      <div className="compact-grid">
        {items.map((s, i) => (
          <CompactCard key={s.id} delay={Math.min(i, 12) * 25} hint="Open the suggestion" lines={1}
            top={<span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{s.agent ? `@${s.agent}` : 'an agent'}</span>}
            meta={fmtRelative(s.created_at)}
            title={what(s)}
            body={<>{s.old_text || 'empty'} → <span style={{ color: 'var(--color-ink)' }}>{s.new_text}</span></>}
            dialog={{
              size: 'lg', icon: 'sparkles', title: what(s), subtitle: `${s.agent ? `@${s.agent}` : 'an agent'} · ${fmtRelative(s.created_at)}`,
              body: () => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                    <div>
                      <div className="text-eyebrow" style={{ marginBottom: 4 }}>Now</div>
                      <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', textDecoration: s.old_text ? 'line-through' : undefined }}>
                        {s.old_text || <em>empty</em>}
                      </div>
                    </div>
                    <div>
                      <div className="text-eyebrow" style={{ marginBottom: 4 }}>Suggested</div>
                      <div className="text-body-sm" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{s.new_text}</div>
                    </div>
                  </div>
                  <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>Why: {s.evidence}</div>
                </div>
              ),
              actions: (close) => (
                <>
                  <button type="button" className="btn-secondary" disabled={decide.isPending} style={{ marginLeft: 'auto' }} onClick={() => act(s, 'discard', close)}>Discard</button>
                  <button type="button" className="btn-primary" disabled={decide.isPending} onClick={() => act(s, 'apply', close)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="check" size={14} /> Apply
                  </button>
                </>
              ),
            }} />
        ))}
      </div>
    </SectionCard>
  );
}
