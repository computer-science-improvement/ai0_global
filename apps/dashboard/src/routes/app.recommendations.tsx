import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { BudgetInput } from '../components/BudgetInput';
import { EditThemesModal } from '../components/EditThemesModal';
import { RecommendationsTable } from '../components/RecommendationsTable';
import { TargetChannelPicker } from '../components/TargetChannelPicker';
import { ErrorCallout, ListSkeleton, SectionCaption } from '../components/channels/ChannelsUi';
import { Icon } from '../components/ui/Icon';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, SectionCard } from '../components/ui/primitives';
import { useChannelThemes, useRecommendations } from '../api/discovery';
import '../components/channels/channels.css';

export const Route = createFileRoute('/app/recommendations')({
  component: RecommendationsPage,
});

function RecommendationsPage() {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [budget, setBudget]     = useState<number>(50_000); // 500 UAH default
  const [editOpen, setEditOpen] = useState(false);

  const { data: targetThemes } = useChannelThemes(targetId);
  const recs = useRecommendations({ targetChannelId: targetId, budget });

  const resultCount = recs.data?.recommendations.length ?? 0;

  return (
    <div>
      <PageHeader
        eyebrow="Insights · ads"
        title="Recommendations"
        subtitle="Channels worth buying ads on, sorted by theme overlap → ROI → price."
      />

      <div className="ch-stack">
        {/* ── Controls ─────────────────────────────────────────────── */}
        <SectionCard title="Find placements" delay={40}>
          <div className="rec-controls">
            <div>
              <label>
                <span className="text-eyebrow">Target channel</span>
                <TargetChannelPicker value={targetId} onChange={setTargetId} />
              </label>
              {targetId && (
                <button type="button" onClick={() => setEditOpen(true)} className="btn-ghost btn-sm rec-edit">
                  <Icon name="pencil" size={14} />
                  Edit themes ({targetThemes?.length ?? 0})
                </button>
              )}
            </div>
            <label>
              <span className="text-eyebrow">Budget</span>
              <BudgetInput value={budget} onChange={setBudget} />
            </label>
          </div>

          {targetThemes && targetThemes.length > 0 && (
            <div className="rec-themes">
              <span className="text-overline rec-themes-key">Target themes</span>
              {targetThemes.map(t => (
                <span key={t} className="chip is-active">{t}</span>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Results ──────────────────────────────────────────────── */}
        {!targetId ? (
          <div className="panel compose-rise" style={{ animationDelay: '80ms' }}>
            <EmptyState
              icon="recommendations"
              title="Pick a target channel"
              note="Choose one of your channels above and the best ad placements for it appear here."
            />
          </div>
        ) : budget <= 0 ? (
          <div className="panel compose-rise" style={{ animationDelay: '80ms' }}>
            <EmptyState
              icon="recommendations"
              title="Enter a budget"
              note="Set a budget above zero to see the placements it can buy."
            />
          </div>
        ) : recs.isLoading ? (
          <SectionCard title="Placements" flush delay={80} action={<SectionCaption>computing…</SectionCaption>}>
            <ListSkeleton rows={4} />
          </SectionCard>
        ) : recs.error ? (
          <ErrorCallout
            title="Couldn’t compute recommendations"
            message={(recs.error as Error).message}
            style={{ marginBottom: 0 }}
          />
        ) : recs.data ? (
          <>
            {recs.data.warning && (
              <div className="callout-warning compose-rise" role="status" style={{ marginBottom: 0 }}>
                <Icon name="info" size={18} />
                <div className="text-body-sm" style={{ flex: '1 1 260px', minWidth: 0 }}>{recs.data.warning}</div>
              </div>
            )}

            {resultCount === 0 ? (
              <div className="panel compose-rise" style={{ animationDelay: '80ms' }}>
                <EmptyState
                  icon="recommendations"
                  title="No matching channels"
                  note="Try widening the budget or editing the target themes to broaden the overlap."
                  action={
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setEditOpen(true)}>
                      <Icon name="pencil" size={14} />
                      Edit themes
                    </button>
                  }
                />
              </div>
            ) : (
              <SectionCard
                title="Placements"
                delay={80}
                action={<SectionCaption>{resultCount} channel{resultCount === 1 ? '' : 's'}</SectionCaption>}
              >
                <RecommendationsTable
                  items={recs.data.recommendations}
                  targetThemes={recs.data.targetThemes}
                />
              </SectionCard>
            )}
          </>
        ) : null}
      </div>

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
