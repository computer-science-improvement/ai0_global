import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { BudgetInput } from '../components/BudgetInput';
import { EditThemesModal } from '../components/EditThemesModal';
import { RecommendationsTable } from '../components/RecommendationsTable';
import { TargetChannelPicker } from '../components/TargetChannelPicker';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState, SectionCard, StatusDot } from '../components/ui/primitives';
import { useChannelThemes, useRecommendations } from '../api/discovery';

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
        title="Recommendations"
        subtitle="Channels worth buying ads on, sorted by theme overlap → ROI → price."
      />

      {/* ── Control panel ────────────────────────────────────────── */}
      <SectionCard title="Find placements" icon="discovery" delay={40} style={{ marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 20, alignItems: 'start' }}>
          <div>
            <label className="text-eyebrow" style={{ display: 'block', marginBottom: 6 }}>
              Target channel
            </label>
            <TargetChannelPicker value={targetId} onChange={setTargetId} />
            {targetId && (
              <button
                onClick={() => setEditOpen(true)}
                className="link-accent text-micro"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  marginTop: 8,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <Icon name="pencil" size={12} />
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
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-hairline-soft)',
              }}
            >
              <span style={{ display: 'inline-flex', color: 'var(--color-accent)' }}>
                <Icon name="sparkle" size={13} />
              </span>
              <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
                theme match → ROI → price
              </span>
            </div>
          </div>
        </div>

        {targetThemes && targetThemes.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              marginTop: 16,
              paddingTop: 16,
              borderTop: '1px solid var(--color-hairline-soft)',
            }}
          >
            <span className="text-micro" style={{ color: 'var(--color-ink-muted)', marginRight: 2 }}>
              Target themes
            </span>
            {targetThemes.map(t => (
              <span key={t} className="chip is-active">{t}</span>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── Result count ─────────────────────────────────────────── */}
      {recs.data && resultCount > 0 && (
        <div
          className="compose-rise"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginBottom: 12,
            animationDelay: '60ms',
          }}
        >
          <StatusDot tone="accent" size={7} />
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
            {resultCount} channel{resultCount === 1 ? '' : 's'} match your budget &amp; themes
          </span>
        </div>
      )}

      {/* ── States ───────────────────────────────────────────────── */}
      {recs.isLoading && (
        <SectionCard title="Computing recommendations…" icon="refresh" delay={60}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[0, 1, 2, 3].map(i => (
              <div
                key={i}
                style={{
                  height: 40,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-hairline-soft)',
                  opacity: 0.6 - i * 0.1,
                }}
              />
            ))}
          </div>
        </SectionCard>
      )}

      {recs.error && (
        <div className="compose-rise">
          <EmptyState
            icon="warning"
            title="Failed to load recommendations"
            note="Something went wrong while computing placements. Try again in a moment."
          />
        </div>
      )}

      {recs.data?.warning && (
        <div
          className="panel compose-rise"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 16,
            borderColor: 'var(--color-warning-soft)',
          }}
        >
          <span style={{ display: 'inline-flex', color: 'var(--color-warning)' }}>
            <Icon name="info" size={16} />
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            {recs.data.warning}
          </span>
        </div>
      )}

      {/* ── Empty state ──────────────────────────────────────────── */}
      {recs.data && resultCount === 0 && (
        <div className="compose-rise" style={{ animationDelay: '60ms' }}>
          <EmptyState
            icon="recommendations"
            title={targetId ? 'No matching channels' : 'Pick a target channel'}
            note={
              targetId
                ? 'Try widening the budget or editing the target themes to broaden the overlap.'
                : 'Choose a channel above and we’ll surface the best ad placements for it.'
            }
          />
        </div>
      )}

      {/* ── Results table ────────────────────────────────────────── */}
      {recs.data && resultCount > 0 && (
        <div className="compose-rise" style={{ animationDelay: '80ms' }}>
          <RecommendationsTable
            items={recs.data.recommendations}
            targetThemes={recs.data.targetThemes}
          />
        </div>
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
