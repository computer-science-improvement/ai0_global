// apps/dashboard/src/api/strategies.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { PendingAction, Strategy, StrategyRun, StrategyPreview } from './types';

export function useStrategyRuns(strategyId: string | null) {
  return useQuery({
    queryKey: ['strategy-runs', strategyId],
    queryFn:  () => api<StrategyRun[]>(`/api/strategies/${strategyId}/runs`),
    enabled:  !!strategyId,
    refetchInterval: 10_000,
  });
}

export function useStrategyPreview(strategyId: string | null) {
  return useQuery({
    queryKey: ['strategy-preview', strategyId],
    queryFn:  () => api<StrategyPreview>(`/api/strategies/${strategyId}/preview`),
    enabled:  !!strategyId,
    staleTime: 60_000,
  });
}

export type CaptionPartSource = 'recipe' | 'computed' | 'static' | 'generated' | 'custom';
export interface CaptionPart {
  key:       string;
  label:     string;
  source:    CaptionPartSource;
  value:     string;
  platforms: string[];
  editable:  boolean;
}
export interface RecipePostPreview {
  parts:    CaptionPart[];
  rendered: Record<'facebook' | 'instagram' | 'threads' | 'telegram', string>;
}
export interface MetaCaptionOverrides {
  cta?:         string;
  hashtags?:    string[];
  intro?:       string;
  outro?:       string;
  tgLinkLabel?: string;
}

/** Caption parts + per-platform rendered captions for a recipe-carousel binding. */
export function useRecipePostPreview(strategyId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['recipe-post-preview', strategyId],
    queryFn:  () => api<RecipePostPreview>(`/api/strategies/${strategyId}/post-preview`),
    enabled:  !!strategyId && enabled,
    staleTime: 30_000,
  });
}

export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn:  () => api<Strategy[]>('/api/strategies'),
    // Recompute next-run timestamps reasonably often (every 30s in foreground).
    refetchInterval: 30_000,
  });
}

/**
 * Spec 023 FR-013 phase A: strategies are read-only legacy — the API accepts only pausing and notes
 * (anything else is 410 strategies_legacy), so the type allows nothing more.
 */
export interface PatchStrategyInput {
  enabled?: false;
  notes?:   string | null;
}

export function usePatchStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchStrategyInput }) =>
      api<Strategy>(`/api/strategies/${id}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strategies'] }),
  });
}

export function useDeleteStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/strategies/${id}`, { method: 'DELETE' }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['strategies'] }),
  });
}

// ── Spec 023 T6/T7: migration of the bindings into agent series ─────────────

export type MigrationState = 'no_agent' | 'not_migrated' | 'draft_pending' | 'shadow' | 'cutover_ready' | 'retired' | 'legacy';

export interface ShadowStats { since: string | null; days: number; expected: number; realised: number; ratio: number; ready: boolean }

export interface MigrationCard { id: string; kind: 'migrate_strategies' | 'strategy_cutover' | 'strategy_rollback'; summary: string; createdAt: string }

export interface MigrationChannel {
  channel_key: string;
  agent:       { handle: string; mode: string } | null;
  state:       MigrationState;
  enabled:     string[];
  retired:     string[];
  draft:       { id: string; version: number } | null;
  shadow:      ShadowStats | null;
  cards:       MigrationCard[];
}

export type BindingOutcome = {
  ext_id: string; type: string; resource_ref: string | null; schedule: string; warnings: string[];
} & (
  | { outcome: 'series'; series: string; cadence: string; format: string; source: string | null; source_mode: 'suggested' | 'required'; per_day: number }
  | { outcome: 'frequency'; per_day: number; format: string; source: string | null; reason: string }
  | { outcome: 'unmappable'; reason: string }
);

export interface MigrationProposal {
  channel_key:    string;
  agent:          { id: string; handle: string } | null;
  active_version: number | null;
  bindings:       BindingOutcome[];
  rationale:      string;
  errors:         string[];
  mapped:         number;
  total:          number;
}

export type MigrationOp = 'migrate' | 'cutover' | 'rollback';

const MIGRATION_KEY = ['strategies', 'migration'] as const;

/** Per-channel migration state and the pending migration cards (/app/strategies banner). */
export function useStrategyMigration() {
  return useQuery({
    queryKey: MIGRATION_KEY,
    queryFn:  () => api<{ channels: MigrationChannel[] }>('/api/strategies/migration'),
    refetchInterval: 60_000,
  });
}

/** The dry run of one channel: how each enabled binding would map (writes nothing). */
export function useMigrationProposal(channel: string | null) {
  return useQuery({
    queryKey: [...MIGRATION_KEY, 'proposal', channel],
    queryFn:  () => api<MigrationProposal>(`/api/strategies/migration/proposal?channel=${encodeURIComponent(channel ?? '')}`),
    enabled:  !!channel,
    retry:    false,
  });
}

/** Propose a migrate / cutover / rollback card (Apply / Discard through /api/agents/actions/:id/…). */
export function useProposeMigration() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { op: MigrationOp; channel: string }) =>
      api<{ action: PendingAction; proposal?: MigrationProposal }>(`/api/strategies/migration/${v.op}`, {
        method: 'POST', body: JSON.stringify({ channel: v.channel }),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: MIGRATION_KEY }),
  });
}
