import type { EditorRole } from './llm.types';

export interface ModelProfile {
  model:       string;
  /** USD per 1M prompt tokens — used only when the provider omits usage.cost. */
  inPerM:      number;
  /** USD per 1M completion tokens. */
  outPerM:     number;
  maxTokens:   number;
  temperature: number;
  /** Reasoning effort; low keeps GLM's mandatory thinking from consuming the whole max_tokens (measured: ~10x fewer tokens). */
  reasoningEffort: 'low' | 'medium' | 'high';
}

export const DEFAULT_EDITOR_MODEL = 'z-ai/glm-5.3-flash';

/** Known prices (OpenRouter, 2026-10). Unknown models fall back to the default's price. */
const PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  'z-ai/glm-5.3-flash':  { inPerM: 0.15, outPerM: 0.50 },
  'z-ai/glm-5.3-flashx': { inPerM: 0.37, outPerM: 1.25 },
  'z-ai/glm-5.3':        { inPerM: 0.22, outPerM: 3.39 },
};

// max_tokens includes reasoning tokens on reasoning models, so leave headroom above the visible output.
const ROLE_DEFAULTS: Record<EditorRole, { maxTokens: number; temperature: number; reasoningEffort: 'low' | 'medium' | 'high' }> = {
  planner:  { maxTokens: 8000, temperature: 0.6, reasoningEffort: 'medium' },
  executor: { maxTokens: 6000, temperature: 0.7, reasoningEffort: 'low' },
  reviewer: { maxTokens: 8000, temperature: 0.3, reasoningEffort: 'medium' },
  checker:  { maxTokens: 2000, temperature: 0.0, reasoningEffort: 'low' },
  composer: { maxTokens: 6000, temperature: 0.6, reasoningEffort: 'low' },
  orchestrator:  { maxTokens: 8000, temperature: 0.6, reasoningEffort: 'medium' },
  idea_reviewer: { maxTokens: 6000, temperature: 0.2, reasoningEffort: 'low' },
  manager:       { maxTokens: 8000, temperature: 0.3, reasoningEffort: 'medium' },
  builder:       { maxTokens: 6000, temperature: 0.4, reasoningEffort: 'low' },
};

/** Roles whose default model is not DEFAULT_EDITOR_MODEL (the idea reviewer judges, so it uses the stronger model). */
const ROLE_MODEL_DEFAULTS: Partial<Record<EditorRole, string>> = { idea_reviewer: 'z-ai/glm-5.3' };

/**
 * Resolve the model for a role. Precedence: per-channel / per-agent override
 * → env EDITOR_MODEL_<ROLE> → the role's default → DEFAULT_EDITOR_MODEL.
 */
export function resolveModel(
  role: EditorRole,
  env: (key: string) => string | undefined,
  channelOverrides?: Partial<Record<EditorRole, string>> | null,
): ModelProfile {
  const model = channelOverrides?.[role]
    ?? env(`EDITOR_MODEL_${role.toUpperCase()}`)
    ?? ROLE_MODEL_DEFAULTS[role]
    ?? DEFAULT_EDITOR_MODEL;
  const price = PRICES[model] ?? PRICES[DEFAULT_EDITOR_MODEL];
  const effort = env(`EDITOR_REASONING_${role.toUpperCase()}`) ?? env('EDITOR_REASONING');
  const d = ROLE_DEFAULTS[role];
  return { model, ...price, ...d, reasoningEffort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : d.reasoningEffort };
}

export function estimateCostUsd(p: Pick<ModelProfile, 'inPerM' | 'outPerM'>, promptTokens: number, completionTokens: number): number {
  return (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1_000_000;
}
