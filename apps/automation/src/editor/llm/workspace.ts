import type { Pool } from 'pg';
import { CRITIC_MODEL_KEY, DEFAULT_MODEL_KEY, ModelDefaultsStore } from './model-defaults';

/**
 * Spec 038: the model workspace — which provider every editor run talks to. OpenRouter (the default) or
 * Anthropic directly (the Claude API, e.g. with the monthly credits of a Max plan). Each workspace keeps its own
 * model choices, so switching back and forth loses nothing:
 *   default model  `ai.default_model`  | `ai.anthropic.default_model`
 *   critic model   `ai.critic_model`   | `ai.anthropic.critic_model`
 *   agent model    `agents.model`      | `agents.anthropic_model`
 * The reasoning effort is shared. The workspace is bound to a run when its model is resolved (ModelProfile.workspace).
 */
export type Workspace = 'openrouter' | 'anthropic';
export const WORKSPACES: readonly Workspace[] = ['openrouter', 'anthropic'];
export const isWorkspace = (v: unknown): v is Workspace => v === 'openrouter' || v === 'anthropic';

/** app_settings key of the active workspace; absent → openrouter. Never an env override (`ai.*`). */
export const WORKSPACE_KEY = 'ai.workspace';
export const ANTHROPIC_DEFAULT_MODEL_KEY = 'ai.anthropic.default_model';
export const ANTHROPIC_CRITIC_MODEL_KEY = 'ai.anthropic.critic_model';

/** The Anthropic API key of the editor: its own EDITOR_ANTHROPIC_API_KEY (a key of the Console org linked to the plan's credits), else ANTHROPIC_API_KEY. */
export function anthropicApiKey(env: (key: string) => string | undefined): string | undefined {
  return env('EDITOR_ANTHROPIC_API_KEY')?.trim() || env('ANTHROPIC_API_KEY')?.trim() || undefined;
}

/** The active workspace, cached in process like the default model (a save updates the cache at once). */
export class WorkspaceStore {
  private readonly store: ModelDefaultsStore;

  constructor(pool: Pick<Pool, 'query'>, opts: { ttlMs?: number; now?: () => number; onError?: (msg: string) => void } = {}) {
    this.store = new ModelDefaultsStore(pool, opts, WORKSPACE_KEY);
  }

  async get(): Promise<Workspace> {
    const v = await this.store.get();
    return isWorkspace(v) ? v : 'openrouter';
  }

  /** openrouter deletes the row (the default); anthropic saves it. */
  async set(ws: Workspace): Promise<void> {
    await this.store.set(ws === 'openrouter' ? null : ws);
  }
}

/** One model setting (the default, or the critic's) kept per workspace. */
export class WorkspaceModelStore {
  private readonly stores: Record<Workspace, ModelDefaultsStore>;

  constructor(
    pool: Pick<Pool, 'query'>, kind: 'default' | 'critic', opts: { onError?: (msg: string) => void } = {},
    /** The active workspace (the runners read it through `workspace()`); absent → openrouter. */
    private readonly active?: Pick<WorkspaceStore, 'get'>,
  ) {
    this.stores = {
      openrouter: new ModelDefaultsStore(pool, opts, kind === 'default' ? DEFAULT_MODEL_KEY : CRITIC_MODEL_KEY),
      anthropic:  new ModelDefaultsStore(pool, opts, kind === 'default' ? ANTHROPIC_DEFAULT_MODEL_KEY : ANTHROPIC_CRITIC_MODEL_KEY),
    };
  }

  get(ws: Workspace = 'openrouter'): Promise<string | null> { return this.stores[ws].get(); }
  /** The active workspace. */
  workspace(): Promise<Workspace> { return this.active ? this.active.get() : Promise.resolve('openrouter'); }
  set(ws: Workspace, model: string | null): Promise<void> { return this.stores[ws].set(model); }
  /** A store bound to one workspace (the ModelDefaultsStore shape). */
  in(ws: Workspace): { get(): Promise<string | null>; set(model: string | null): Promise<void> } {
    return { get: () => this.get(ws), set: (m) => this.set(ws, m) };
  }
}

/** The agent's own model in a workspace. */
export function agentModelIn(a: { model: string | null; anthropicModel?: string | null } | null | undefined, ws: Workspace): string | null {
  if (!a) return null;
  return (ws === 'anthropic' ? a.anthropicModel : a.model) ?? null;
}

/** A runner's read of the workspace: never throws, openrouter when there is no store or the read fails. */
export async function readWorkspace(fn?: () => Promise<Workspace>): Promise<Workspace> {
  if (!fn) return 'openrouter';
  try { const ws = await fn(); return isWorkspace(ws) ? ws : 'openrouter'; } catch { return 'openrouter'; }
}

/** The model dependencies a runner gets (spec 035 + 038). */
export interface ModelContextDeps {
  /** The active workspace (WorkspaceStore.get); absent → openrouter. */
  workspace?:    () => Promise<Workspace>;
  /** The owner's default model of a workspace (WorkspaceModelStore.get); absent → the built-in one. */
  defaultModel?: (ws?: Workspace) => Promise<string | null>;
}

/** Read the run's workspace and that workspace's default model once (never throws). */
export async function readModelContext(d: ModelContextDeps): Promise<{ workspace: Workspace; defaultModel: string | null }> {
  const workspace = await readWorkspace(d.workspace);
  let defaultModel: string | null = null;
  try { defaultModel = d.defaultModel ? await d.defaultModel(workspace) : null; } catch { defaultModel = null; }
  return { workspace, defaultModel };
}
