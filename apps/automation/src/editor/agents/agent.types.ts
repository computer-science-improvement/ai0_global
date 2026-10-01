import type { EditorRole } from '../llm/llm.types';

export const AGENT_KINDS = ['manager', 'builder', 'orchestrator', 'planner', 'ideator', 'idea_reviewer', 'executor', 'reviewer'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export type AgentScope = 'system' | 'network' | 'resource';
export type AgentMode = 'off' | 'shadow' | 'live';
export type AgentStatus = 'active' | 'paused';

/** Child roles every orchestrator gets (spec 017 FR-002); idea_reviewer arrives with spec 020. */
export const ORCHESTRATOR_CHILDREN: AgentKind[] = ['planner', 'executor', 'reviewer', 'idea_reviewer'];

export interface AgentSchedule {
  /** Kyiv wall-clock times "HH:MM" (manager runs, orchestrator daily run). */
  times?: string[];
}

export interface Agent {
  id:             string;
  kind:           AgentKind;
  scope:          AgentScope;
  /** `<platform>:<id>` for a resource, the group id for a network, null for system. */
  scopeId:        string | null;
  parentId:       string | null;
  name:           string;
  handle:         string;
  emoji:          string | null;
  description:    string | null;
  mode:           AgentMode;
  status:         AgentStatus;
  pausedUntil:    Date | null;
  model:          string | null;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
  schedule:       AgentSchedule;
  dailyBudgetUsd: number | null;
  shadowUntil:    Date | null;
  createdBy:      'owner' | 'builder' | 'migration' | 'sync';
  createdAt:      Date;
  updatedAt:      Date;
}

export const HANDLE_RE = /^[a-z][a-z0-9_]{2,31}$/;
export const RESERVED_HANDLES = new Set(['ai0', 'manager', 'all', 'owner', 'admin']);

/** The EditorRole an agent kind runs as (the AgentLoop role; tools and skills are selected by it). */
export function roleOfKind(kind: AgentKind): EditorRole {
  switch (kind) {
    case 'manager':       return 'manager';
    case 'builder':       return 'builder';
    case 'orchestrator':  return 'orchestrator';
    case 'ideator':       return 'orchestrator';
    case 'idea_reviewer': return 'idea_reviewer';
    case 'planner':       return 'planner';
    case 'executor':      return 'executor';
    case 'reviewer':      return 'reviewer';
  }
}

export function validateHandle(handle: string, opts: { allowReserved?: boolean } = {}): string | null {
  if (!HANDLE_RE.test(handle)) return 'handle: 3–32 символи, латиниця в нижньому регістрі, цифри й _, починається з літери';
  if (!opts.allowReserved && RESERVED_HANDLES.has(handle)) return `handle "${handle}" зарезервований`;
  return null;
}

/**
 * A handle derived from a channel key or a free-form name: lower-case, [a-z0-9_],
 * starts with a letter, 3–32 characters. Collisions are resolved by the caller.
 */
export function deriveHandle(source: string, fallbackPrefix = 'agent'): string {
  let h = source.trim().replace(/^@+/, '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(h)) h = `${fallbackPrefix}_${h}`.replace(/_+$/, '');
  if (h.length < 3) h = `${h}_${fallbackPrefix}`.slice(0, 32);
  h = h.slice(0, 32).replace(/_+$/, '');
  if (RESERVED_HANDLES.has(h)) h = `${h}_agent`;
  return h;
}

/** `handle`, then `handle_2`, `handle_3`… within 32 characters, skipping taken ones. */
export function withSuffix(base: string, taken: (h: string) => boolean): string {
  if (!taken(base) && !RESERVED_HANDLES.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const h = `${base.slice(0, 32 - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!taken(h)) return h;
  }
  throw new Error(`no free handle for ${base}`);
}

/** Resource reference helpers: `<platform>:<id>`. */
export const PLATFORMS = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube'] as const;
export type Platform = typeof PLATFORMS[number];

export function resourceRef(platform: Platform, id: string): string {
  return `${platform}:${id}`;
}

export function parseResourceRef(ref: string): { platform: Platform; id: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const platform = ref.slice(0, i) as Platform;
  const id = ref.slice(i + 1);
  return (PLATFORMS as readonly string[]).includes(platform) && id ? { platform, id } : null;
}

/** The Telegram channel key of a resource scope, if it is a Telegram resource. */
export function telegramKeyOf(agent: Pick<Agent, 'scope' | 'scopeId'>): string | null {
  if (agent.scope !== 'resource' || !agent.scopeId) return null;
  const r = parseResourceRef(agent.scopeId);
  return r?.platform === 'telegram' ? r.id : null;
}

export function isPaused(a: Pick<Agent, 'status' | 'pausedUntil'>, now: Date): boolean {
  return a.status === 'paused' || (!!a.pausedUntil && a.pausedUntil.getTime() > now.getTime());
}
