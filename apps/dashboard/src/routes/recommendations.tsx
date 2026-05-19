import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { BudgetInput } from '../components/BudgetInput';
import { EditThemesModal } from '../components/EditThemesModal';
import { RecommendationsTable } from '../components/RecommendationsTable';
import { TargetChannelPicker } from '../components/TargetChannelPicker';
import { useChannelThemes, useRecommendations } from '../api/discovery';

export const Route = createFileRoute('/recommendations')({
  component: RecommendationsPage,
});

function RecommendationsPage() {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [budget, setBudget] = useState<number>(50_000); // 500 UAH default
  const [editOpen, setEditOpen] = useState(false);

  const { data: targetThemes } = useChannelThemes(targetId);
  const recs = useRecommendations({ targetChannelId: targetId, budget });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold" style={{ color: 'var(--color-ink)' }}>
        Recommendations
      </h1>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase" style={{ color: 'var(--color-ink-muted)' }}>
            Target channel
          </label>
          <TargetChannelPicker value={targetId} onChange={setTargetId} />
          {targetId && (
            <button
              onClick={() => setEditOpen(true)}
              className="mt-2 text-xs text-blue-600 hover:underline"
            >
              Edit themes ({targetThemes?.length ?? 0})
            </button>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase" style={{ color: 'var(--color-ink-muted)' }}>
            Budget
          </label>
          <BudgetInput value={budget} onChange={setBudget} />
        </div>
        <div className="flex items-end">
          <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Sorted by theme match → ROI → price.
          </span>
        </div>
      </div>

      {targetThemes && targetThemes.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          <span className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
            Target themes:
          </span>
          {targetThemes.map(t => (
            <span
              key={t}
              className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {recs.isLoading && (
        <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Computing recommendations…
        </p>
      )}
      {recs.error && (
        <p className="text-sm text-red-600">Failed to load recommendations.</p>
      )}
      {recs.data?.warning && (
        <p className="mb-4 rounded-md border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm">
          {recs.data.warning}
        </p>
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
