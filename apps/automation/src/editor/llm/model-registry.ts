import type { EditorRole } from './llm.types';
import type { Workspace } from './workspace';

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
  /** Spec 038: the workspace the model belongs to — the run's requests go to this provider (absent = openrouter). */
  workspace?:  Workspace;
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

/** Spec 038: the built-in default of the Anthropic workspace; `ai.anthropic.default_model` replaces it. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/**
 * Anthropic list prices (USD per 1M, pricing page 2026-10-15) — the last-resort fallback after llm_prices
 * (migration 077 seeds the same rows). Cache read is 0.05× input on Opus 5.5 / Sonnet 5.5, 0.1× elsewhere;
 * a 5-minute cache write is 1.25× input. Also the static part of the Anthropic model catalog.
 */
export const ANTHROPIC_PRICES: Readonly<Record<string, { name: string; inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number; contextLength: number }>> = {
  'claude-opus-5-5':   { name: 'Claude Opus 5.5',   inPerM: 4,    outPerM: 20,   cacheReadPerM: 0.2,  cacheWritePerM: 5,     contextLength: 1_000_000 },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', inPerM: 2,    outPerM: 10,   cacheReadPerM: 0.1,  cacheWritePerM: 2.5,   contextLength: 1_000_000 },
  'claude-haiku-5-5':  { name: 'Claude Haiku 5.5',  inPerM: 0.1,  outPerM: 0.5,  cacheReadPerM: 0.01, cacheWritePerM: 0.125, contextLength: 200_000 },
  'claude-opus-5':     { name: 'Claude Opus 5',     inPerM: 5,    outPerM: 25,   cacheReadPerM: 0.5,  cacheWritePerM: 6.25,  contextLength: 1_000_000 },
  'claude-sonnet-5':   { name: 'Claude Sonnet 5',   inPerM: 2,    outPerM: 10,   cacheReadPerM: 0.2,  cacheWritePerM: 2.5,   contextLength: 1_000_000 },
  'claude-haiku-4-5':  { name: 'Claude Haiku 4.5',  inPerM: 1,    outPerM: 5,    cacheReadPerM: 0.1,  cacheWritePerM: 1.25,  contextLength: 200_000 },
};

/** The built-in default model of a workspace. */
export function builtinDefaultModel(ws: Workspace = 'openrouter'): string {
  return ws === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_EDITOR_MODEL;
}

/** Every role a run can use (the env override keys are EDITOR_MODEL_<ROLE>). */
export const EDITOR_ROLES: readonly EditorRole[] = [
  'planner', 'executor', 'reviewer', 'checker', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder', 'onboarder',
];

/**
 * Spec 046 FR-010: the built-in model of each role in the Anthropic workspace while the owner has no default
 * there. Review 2: Sonnet everywhere (+ Opus on the manager, the critic and the weekly reviewers) cost ≈ $1.21 per
 * post against ≈ $0.06 on GLM. The writer, the critic, the manager and the owner-facing roles stay on Sonnet; the
 * structured, high-volume roles (plans, idea reviews, the daily orchestration) run on Haiku. Target: the owner's
 * $3/day for the agents at the current volume (spec 046 §Budget).
 */
export const ANTHROPIC_ROLE_MODELS: Readonly<Record<EditorRole, string>> = {
  executor: DEFAULT_ANTHROPIC_MODEL, checker: DEFAULT_ANTHROPIC_MODEL, manager: DEFAULT_ANTHROPIC_MODEL, reviewer: DEFAULT_ANTHROPIC_MODEL,
  composer: DEFAULT_ANTHROPIC_MODEL, builder: DEFAULT_ANTHROPIC_MODEL, onboarder: DEFAULT_ANTHROPIC_MODEL,
  planner: 'claude-haiku-5-5', orchestrator: 'claude-haiku-5-5', idea_reviewer: 'claude-haiku-5-5',
};

/**
 * Spec 041 FR-007: the critic's model for a low-risk draft (no external source, no quotes; evergreen, library).
 * Anthropic: env EDITOR_ANTHROPIC_MODEL_CHECKER_LIGHT, else Haiku. OpenRouter: env EDITOR_MODEL_CHECKER_LIGHT, else
 * null — the normal checker model (one default for every role there).
 */
export const ANTHROPIC_LIGHT_CHECKER = 'claude-haiku-5-5';
export function lightCheckerModel(env: (key: string) => string | undefined, ws: Workspace = 'openrouter'): string | null {
  const fromEnv = clean(env(ws === 'anthropic' ? 'EDITOR_ANTHROPIC_MODEL_CHECKER_LIGHT' : 'EDITOR_MODEL_CHECKER_LIGHT'));
  return fromEnv ?? (ws === 'anthropic' ? ANTHROPIC_LIGHT_CHECKER : null);
}

/** The built-in model of a role in a workspace (OpenRouter has one default for every role). */
export function builtinRoleModel(role: EditorRole, ws: Workspace = 'openrouter'): string {
  return ws === 'anthropic' ? ANTHROPIC_ROLE_MODELS[role] ?? DEFAULT_ANTHROPIC_MODEL : DEFAULT_EDITOR_MODEL;
}

// max_tokens includes reasoning tokens on reasoning models, so leave headroom above the visible output.
const ROLE_DEFAULTS: Record<EditorRole, { maxTokens: number; temperature: number; reasoningEffort: ReasoningEffort }> = {
  planner:  { maxTokens: 8000, temperature: 0.6, reasoningEffort: 'medium' },
  executor: { maxTokens: 6000, temperature: 0.7, reasoningEffort: 'low' },
  reviewer: { maxTokens: 8000, temperature: 0.3, reasoningEffort: 'medium' },
  // Spec 034 FR-004: the pre-publish critic (six scores, a verdict, notes ≤ 800 chars) with room for reasoning.
  checker:  { maxTokens: 3000, temperature: 0.0, reasoningEffort: 'low' },
  composer: { maxTokens: 6000, temperature: 0.6, reasoningEffort: 'low' },
  orchestrator:  { maxTokens: 8000, temperature: 0.6, reasoningEffort: 'medium' },
  idea_reviewer: { maxTokens: 6000, temperature: 0.2, reasoningEffort: 'low' },
  manager:       { maxTokens: 8000, temperature: 0.3, reasoningEffort: 'medium' },
  builder:       { maxTokens: 6000, temperature: 0.4, reasoningEffort: 'low' },
  // Spec 042 FR-003: one structured analysis of 20 posts (six sections with evidence).
  onboarder:     { maxTokens: 8000, temperature: 0.3, reasoningEffort: 'medium' },
};

/** The env key that overrides a role's model (it beats the owner's global default); the Anthropic workspace has its own keys. */
export function envModelKey(role: EditorRole, ws: Workspace = 'openrouter'): string {
  return ws === 'anthropic' ? `EDITOR_ANTHROPIC_MODEL_${role.toUpperCase()}` : `EDITOR_MODEL_${role.toUpperCase()}`;
}

export interface ModelOverrides {
  /** The agent's own model, or the one it inherits from its orchestrator. */
  agentModel?:      string | null;
  /** The owner's global default (`app_settings` `ai.default_model`); null/absent → DEFAULT_EDITOR_MODEL. */
  defaultModel?:    string | null;
  /** The agent's own reasoning effort (beats the env and the role default). */
  reasoningEffort?: ReasoningEffort | null;
  /** Spec 038: the active workspace (absent = openrouter). `agentModel` / `defaultModel` must be that workspace's values. */
  workspace?:       Workspace;
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
 * On OpenRouter every role defaults to the same model.
 * Anthropic workspace (spec 038): the channel cards' legacy overrides are OpenRouter ids and are skipped; the env
 * key is EDITOR_ANTHROPIC_MODEL_<ROLE>; without the owner's default each role has its own built-in model
 * (ANTHROPIC_ROLE_MODELS, spec 046 FR-010).
 */
export function pickModel(
  role: EditorRole,
  env: (key: string) => string | undefined,
  channelOverrides?: Partial<Record<EditorRole, string>> | null,
  o: ModelOverrides = {},
): { model: string; source: ModelSource } {
  const agent = clean(o.agentModel);
  if (agent) return { model: agent, source: 'agent' };
  const ws = o.workspace ?? 'openrouter';
  const channel = ws === 'openrouter' ? clean(channelOverrides?.[role]) : null;
  if (channel) return { model: channel, source: 'channel' };
  const fromEnv = clean(env(envModelKey(role, ws)));
  if (fromEnv) return { model: fromEnv, source: 'env' };
  return { model: clean(o.defaultModel) ?? builtinRoleModel(role, ws), source: 'default' };
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
  const ws = o.workspace ?? 'openrouter';
  const a = ws === 'anthropic' ? ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES[DEFAULT_ANTHROPIC_MODEL] : null;
  const price = a ? { inPerM: a.inPerM, outPerM: a.outPerM } : STATIC_PRICES[model] ?? STATIC_PRICES[DEFAULT_EDITOR_MODEL];
  const d = ROLE_DEFAULTS[role];
  return {
    model, source, ...price, maxTokens: d.maxTokens, temperature: d.temperature,
    reasoningEffort: pickReasoningEffort(role, env, o.reasoningEffort).effort,
    ...(ws === 'anthropic' ? { workspace: ws } : {}),
  };
}

export function estimateCostUsd(p: Pick<ModelProfile, 'inPerM' | 'outPerM'>, promptTokens: number, completionTokens: number): number {
  return (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1_000_000;
}
