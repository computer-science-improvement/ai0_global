import type { EditorRole } from './llm.types';

export interface ModelProfile {
  model:       string;
  /** USD per 1M prompt tokens — used only when the provider omits usage.cost. */
  inPerM:      number;
  /** USD per 1M completion tokens. */
  outPerM:     number;
  maxTokens:   number;
  temperature: number;
}

export const DEFAULT_EDITOR_MODEL = 'z-ai/glm-5.3-flash';

/** Known prices (OpenRouter, 2026-10). Unknown models fall back to the default's price. */
const PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  'z-ai/glm-5.3-flash':  { inPerM: 0.15, outPerM: 0.50 },
  'z-ai/glm-5.3-flashx': { inPerM: 0.37, outPerM: 1.25 },
  'z-ai/glm-5.3':        { inPerM: 0.22, outPerM: 3.39 },
};

const ROLE_DEFAULTS: Record<EditorRole, { maxTokens: number; temperature: number }> = {
  planner:  { maxTokens: 2500, temperature: 0.6 },
  executor: { maxTokens: 3000, temperature: 0.7 },
  reviewer: { maxTokens: 2500, temperature: 0.3 },
  checker:  { maxTokens: 800,  temperature: 0.0 },
};

/**
 * Resolve the model for a role. Precedence: per-channel override (card.models)
 * → env EDITOR_MODEL_<ROLE> → DEFAULT_EDITOR_MODEL.
 */
export function resolveModel(
  role: EditorRole,
  env: (key: string) => string | undefined,
  channelOverrides?: Partial<Record<EditorRole, string>> | null,
): ModelProfile {
  const model = channelOverrides?.[role]
    ?? env(`EDITOR_MODEL_${role.toUpperCase()}`)
    ?? DEFAULT_EDITOR_MODEL;
  const price = PRICES[model] ?? PRICES[DEFAULT_EDITOR_MODEL];
  return { model, ...price, ...ROLE_DEFAULTS[role] };
}

export function estimateCostUsd(p: Pick<ModelProfile, 'inPerM' | 'outPerM'>, promptTokens: number, completionTokens: number): number {
  return (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1_000_000;
}
