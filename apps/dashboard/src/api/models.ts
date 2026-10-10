import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AgentKind, AgentScope, ReasoningEffort } from './agents';

// Models page (spec 035): GET /api/models (OpenRouter catalog, tool-capable only,
// cached 24 h server-side), GET /api/models/overview, PUT /api/models/default, PUT /api/models/critic (spec 034),
// POST /api/models/bulk, POST /api/models/channels/clear. An agent's own model and
// reasoning effort go through PATCH /api/agents/:handle (validated server-side).

export type ModelSource = 'agent' | 'channel' | 'env' | 'default';

export interface CatalogModel {
  id:                string;
  name:              string;
  contextLength:     number | null;
  inPerM:            number | null;
  outPerM:           number | null;
  supportsReasoning: boolean;
}

export interface ModelCatalog {
  models:       CatalogModel[];
  fetchedAt:    string | null;
  stale:        boolean;
  source:       'openrouter' | 'fallback';
  defaultModel: string;
}

export interface ModelPrice { inPerM: number; outPerM: number; source: 'llm_prices' | 'catalog' | 'static' }

export interface AgentModelRow {
  id:              string;
  handle:          string;
  name:            string;
  emoji:           string | null;
  kind:            AgentKind;
  role:            string;
  scope:           AgentScope;
  parentId:        string | null;
  parentHandle:    string | null;
  model:           string | null;
  reasoningEffort: ReasoningEffort | null;
  effective: {
    model:           string;
    source:          ModelSource;
    inheritedFrom:   string | null;
    reasoningEffort: ReasoningEffort;
    reasoningSource: 'agent' | 'env' | 'default';
  };
  price:      ModelPrice | null;
  channelKey: string | null;
}

export interface ChannelModelOverride {
  channelKey: string;
  title:      string | null;
  models:     Record<string, string>;
}

export interface ModelsOverview {
  defaultModel:     { model: string; saved: string | null; builtin: string; price: ModelPrice | null };
  /** Spec 034 FR-004: the pre-publish critic's model — the owner's choice, else env EDITOR_MODEL_CHECKER, else the default. */
  criticModel?:     { model: string; saved: string | null; source: 'critic' | 'env' | 'default'; price: ModelPrice | null };
  envOverrides:     Array<{ role: string; key: string }>;
  agents:           AgentModelRow[];
  channelOverrides: ChannelModelOverride[];
}

const KEY = ['models'] as const;

export function useModelCatalog() {
  return useQuery({ queryKey: [...KEY, 'catalog'], queryFn: () => api<ModelCatalog>('/api/models'), staleTime: 10 * 60_000 });
}

export function useModelsOverview() {
  return useQuery({ queryKey: [...KEY, 'overview'], queryFn: () => api<ModelsOverview>('/api/models/overview') });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: ['agents'] })]);
}

export function useSetDefaultModel() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (model: string | null) =>
      api<{ ok: true; defaultModel: string; saved: string | null }>('/api/models/default', { method: 'PUT', body: JSON.stringify({ model }) }),
    onSuccess: done,
  });
}

export function useSetCriticModel() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (model: string | null) =>
      api<{ ok: true; criticModel: string | null }>('/api/models/critic', { method: 'PUT', body: JSON.stringify({ model }) }),
    onSuccess: done,
  });
}

export type BulkModelsAction = { action: 'apply_all'; model: string } | { action: 'reset_all' };

export function useBulkModels() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (body: BulkModelsAction) =>
      api<{ ok: true; action: BulkModelsAction['action']; updated: number }>('/api/models/bulk', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: done,
  });
}

export function useClearChannelModels() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (body: { channelKey: string; role?: string }) =>
      api<{ ok: true; channelKey: string; models: Record<string, string> }>('/api/models/channels/clear', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: done,
  });
}

export function useSetAgentModel() {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: ({ handle, ...patch }: { handle: string; model?: string | null; reasoning_effort?: ReasoningEffort | null }) =>
      api<{ agent: unknown }>(`/api/agents/${encodeURIComponent(handle)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: done,
  });
}
