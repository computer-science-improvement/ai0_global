import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { BudgetInput } from '../components/BudgetInput';
import { EditThemesModal } from '../components/EditThemesModal';
import { RecommendationsTable } from '../components/RecommendationsTable';
import { TargetChannelPicker } from '../components/TargetChannelPicker';
import { Icon } from '../components/Icon';
import { useChannelThemes, useRecommendations } from '../api/discovery';

export const Route = createFileRoute('/recommendations')({
  component: RecommendationsPage,
});

function RecommendationsPage() {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [budget, setBudget]     = useState<number>(50_000); // 500 UAH default
  const [editOpen, setEditOpen] = useState(false);

  const { data: targetThemes } = useChannelThemes(targetId);
  const recs = useRecommendations({ targetChannelId: targetId, budget });

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <h1 className="text-display-md" style={{ margin: 0 }}>Recommendations</h1>
        <p className="text-caption" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>
          Channels worth buying ads on, sorted by theme overlap → ROI → price.
        </p>
      </header>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 20, alignItems: 'end' }}>
          <div>
            <label className="text-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Target channel
            </label>
            <TargetChannelPicker value={targetId} onChange={setTargetId} />
            {targetId && (
              <button
                onClick={() => setEditOpen(true)}
                className="link-accent text-micro"
                style={{ marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Edit themes ({targetThemes?.length ?? 0})
              </button>
            )}
          </div>
          <div>
            <label className="text-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Budget
            </label>
            <BudgetInput value={budget} onChange={setBudget} />
          </div>
          <div>
            <label className="text-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Sort
            </label>
            <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
              theme match → ROI → price
            </p>
          </div>
        </div>

        {targetThemes && targetThemes.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-hairline-soft)' }}>
            <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
              Target themes:
            </span>
            {targetThemes.map(t => (
              <span key={t} className="chip is-active">{t}</span>
            ))}
          </div>
        )}
      </div>

      {recs.isLoading && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Computing recommendations…
        </p>
      )}
      {recs.error && (
        <div className="callout-danger">
          <Icon name="warning" size={16} />
          Failed to load recommendations.
        </div>
      )}
      {recs.data?.warning && (
        <div className="callout-warning" style={{ marginBottom: 16 }}>
          <Icon name="info" size={16} />
          {recs.data.warning}
        </div>
      )}

      {recs.data && (
        <RecommendationsTable
          items={recs.data.recommendations}
          targetThemes={recs.data.targetThemes}
        />
      )}

      {targetId && editOpen && (
        <EditThemesModal
          channelId={targetId}
          channelTitle="Target channel"
          open={editOpen}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}
