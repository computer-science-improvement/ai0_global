// Description fixes agents suggested for a dataset (spec 032 FR-010, pending action `edit_data_schema`).
// Agents never change structure; the owner applies a text edit with one click (no version bump).
// Each suggestion is a compact card (field, agent, "now → suggested"); the dialog has both texts and the actions.

import { Icon } from '../ui/Icon';
import { SectionCard } from '../ui/primitives';
import { CompactCard } from '../ui/CompactCard';
import { describeError, toast } from '../ui/Toast';
import { fmtRelative } from '../../lib/format';
import { useDataSuggestions, useDecideSuggestion, type DataSuggestion } from '../../api/data';
import './data.css';

const what = (s: DataSuggestion) =>
  s.target === 'field' ? `Field ${s.field ?? ''}` : s.target === 'suitable_for' ? 'Suitable for' : s.target === 'reuse' ? 'Reuse' : 'Dataset description';

export function DataSuggestions({ schema }: { schema: string }) {
  const q = useDataSuggestions(schema);
  const decide = useDecideSuggestion();
  const items = q.data ?? [];
  if (!items.length) return null;

  const act = (s: DataSuggestion, decision: 'apply' | 'discard', done: () => void) => decide.mutate({ id: s.id, decision }, {
    onSuccess: (r) => {
      if (r.action.status === 'failed') toast.error(r.action.error ?? 'Could not apply the suggestion');
      else if (r.action.status === 'expired') toast.error('The suggestion expired (24 h); ask the agent again');
      else toast.success(decision === 'apply' ? (s.target === 'reuse' ? 'Reuse setting updated' : 'Description updated') : 'Suggestion discarded');
      done();
    },
    onError: (e) => toast.error(describeError(e)),
  });

  return (
    <SectionCard title={`Suggestions from agents · ${items.length}`}>
      <div className="compact-grid">
        {items.map((s, i) => (
          <CompactCard key={s.id} delay={Math.min(i, 12) * 25} hint="Open the suggestion" lines={1}
            top={<span className="mono text-micro dx-dim">{s.agent ? `@${s.agent}` : 'an agent'}</span>}
            meta={fmtRelative(s.created_at)}
            title={what(s)}
            body={<>{s.old_text || 'empty'} → <span className="dx-ink">{s.new_text}</span></>}
            dialog={{
              size: 'lg', icon: 'sparkles', title: what(s), subtitle: `${s.agent ? `@${s.agent}` : 'an agent'} · ${fmtRelative(s.created_at)}`,
              body: () => (
                <div className="dx-col" style={{ gap: 12 }}>
                  <div className="dx-diff">
                    <div className="inset">
                      <div className="text-overline" style={{ marginBottom: 6 }}>Now</div>
                      <div className={`dx-text${s.old_text ? ' is-old' : ''}`}>{s.old_text || <em>empty</em>}</div>
                    </div>
                    <div className="inset">
                      <div className="text-overline" style={{ marginBottom: 6 }}>Suggested</div>
                      <div className="dx-text">{s.new_text}</div>
                    </div>
                  </div>
                  <p className="dx-note is-sm" style={{ overflowWrap: 'anywhere' }}>Why: {s.evidence}</p>
                </div>
              ),
              actions: (close) => (
                <>
                  <button type="button" className="btn-secondary" disabled={decide.isPending} style={{ marginLeft: 'auto' }} onClick={() => act(s, 'discard', close)}>Discard</button>
                  <button type="button" className="btn-primary" disabled={decide.isPending} onClick={() => act(s, 'apply', close)}>
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
