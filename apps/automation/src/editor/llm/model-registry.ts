import type { EditorRole } from './llm.types';

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Where the effective model of a run came from (spec 035): shown as a badge on the Models page. */
export type ModelSource = 'agent' | 'channel' | 'env' | 'default';

export interface ModelProfile {
  model:       string;
  /** Which layer of the precedence chose `model`. */
  source:      ModelSource;
  /** USD per 1M prompt tokens — used only when the provider omits usage.cost. */
  inPerM:      number;
  /** USD per 1M completion tokens. */
  outPerM:     number;
  maxTokens:   number;
  temperature: number;
  /** Reasoning effort; low keeps GLM's mandatory thinking from consuming the whole max_tokens (measured: ~10x fewer tokens). */
  reasoningEffort: ReasoningEffort;
}

/** The built-in default for every role; the owner's `ai.default_model` setting (Models page) replaces it. */
export const DEFAULT_EDITOR_MODEL = 'z-ai/glm-5.3-flash';

/**
 * Known prices (OpenRouter, 2026-10) — the LAST-resort fallback only: costs come from OpenRouter's usage.cost,
 * then from the llm_prices table (spec 029, PriceService); this map is used when neither is available.
 * Unknown models fall back to the default's price.
 */
export const STATIC_PRICES: Readonly<Record<string, { inPerM: number; outPerM: number }>> = {
  'z-ai/glm-5.3-flash':  { inPerM: 0.15, outPerM: 0.50 },
  'z-ai/glm-5.3-flashx': { inPerM: 0.37, outPerM: 1.25 },
  'z-ai/glm-5.3':        { inPerM: 0.22, outPerM: 3.39 },
};

/** Every role a run can use (the env override keys are EDITOR_MODEL_<ROLE>). */
export const EDITOR_ROLES: readonly EditorRole[] = [
  'planner', 'executor', 'reviewer', 'checker', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder',
];

// max_tokens includes reasoning tokens on reasoning models, so leave headroom above the visible output.
const ROLE_DEFAULTS: Record<EditorRole, { maxTokens: number; temperature: number; reasoningEffort: ReasoningEffort }> = {
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

/** The env key that overrides a role's model (it beats the owner's global default). */
export function envModelKey(role: EditorRole): string {
  return `EDITOR_MODEL_${role.toUpperCase()}`;
}

export interface ModelOverrides {
  /** The agent's own model, or the one it inherits from its orchestrator. */
  agentModel?:      string | null;
  /** The owner's global default (`app_settings` `ai.default_model`); null/absent → DEFAULT_EDITOR_MODEL. */
  defaultModel?:    string | null;
  /** The agent's own reasoning effort (beats the env and the role default). */
  reasoningEffort?: ReasoningEffort | null;
}

const clean = (s: string | null | undefined): string | null => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t || null;
};

export const isReasoningEffort = (s: unknown): s is ReasoningEffort => s === 'low' || s === 'medium' || s === 'high';

/**
 * Pure model choice for a role (spec 035). Precedence: the agent's model
 * → the channel card's legacy `models[role]` → env EDITOR_MODEL_<ROLE>
 * → the owner's global default setting → DEFAULT_EDITOR_MODEL.
 * Every role defaults to the same model (there are no per-role defaults).
 */
export function pickModel(
  role: EditorRole,
  env: (key: string) => string | undefined,
  channelOverrides?: Partial<Record<EditorRole, string>> | null,
  o: ModelOverrides = {},
): { model: string; source: ModelSource } {
  const agent = clean(o.agentModel);
  if (agent) return { model: agent, source: 'agent' };
  const channel = clean(channelOverrides?.[role]);
  if (channel) return { model: channel, source: 'channel' };
  const fromEnv = clean(env(envModelKey(role)));
  if (fromEnv) return { model: fromEnv, source: 'env' };
  return { model: clean(o.defaultModel) ?? DEFAULT_EDITOR_MODEL, source: 'default' };
}

/** Reasoning effort: the agent's own → env EDITOR_REASONING_<ROLE> → env EDITOR_REASONING → the role default. */
export function pickReasoningEffort(
  role: EditorRole,
  env: (key: string) => string | undefined,
  agentEffort?: ReasoningEffort | null,
): { effort: ReasoningEffort; source: 'agent' | 'env' | 'default' } {
  if (isReasoningEffort(agentEffort)) return { effort: agentEffort, source: 'agent' };
  const fromEnv = env(`EDITOR_REASONING_${role.toUpperCase()}`) ?? env('EDITOR_REASONING');
  if (isReasoningEffort(fromEnv)) return { effort: fromEnv, source: 'env' };
  return { effort: ROLE_DEFAULTS[role].reasoningEffort, source: 'default' };
}

/**
 * Resolve the model profile for a role (see `pickModel` for the precedence).
 * Pure: the caller passes the owner's global default in (ModelDefaultsStore).
 */
export function resolveModel(
  role: EditorRole,
  env: (key: string) => string | undefined,
  channelOverrides?: Partial<Record<EditorRole, string>> | null,
  o: ModelOverrides = {},
): ModelProfile {
  const { model, source } = pickModel(role, env, channelOverrides, o);
  const price = STATIC_PRICES[model] ?? STATIC_PRICES[DEFAULT_EDITOR_MODEL];
  const d = ROLE_DEFAULTS[role];
  return {
    model, source, ...price, maxTokens: d.maxTokens, temperature: d.temperature,
    reasoningEffort: pickReasoningEffort(role, env, o.reasoningEffort).effort,
  };
}

export function estimateCostUsd(p: Pick<ModelProfile, 'inPerM' | 'outPerM'>, promptTokens: number, completionTokens: number): number {
  return (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1_000_000;
}
