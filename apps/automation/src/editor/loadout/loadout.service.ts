import type { EditorRole } from '../llm/llm.types';
import type { ToolRegistry } from '../harness/tool-registry';
import { roleOfKind, type Agent } from '../agents/agent.types';
import type { LoadoutRepository } from './loadout.repository';

/**
 * A name no tool has. `forRole` reads an empty allowlist as "no limit", so "nothing but the terminal tools" is an
 * allowlist with this one name in it.
 */
export const NO_TOOL = '(none)';

/**
 * The intersection of two allowlists, `null` (or no list) meaning "no limit" (spec 054 FR-002). An empty result is
 * `[NO_TOOL]`, never `[]`.
 */
export function intersectAllow(a: string[] | null | undefined, b: string[] | null | undefined): string[] | null {
  const x = a && a.length ? a : null;
  const y = b && b.length ? b : null;
  if (!x) return y;
  if (!y) return x;
  const both = new Set(y);
  const out = x.filter((n) => both.has(n));
  return out.length ? out : [NO_TOOL];
}

export interface AllowOptions {
  /** The role the run has (the chat composer is `composer` whatever its agent is). */
  role:     EditorRole;
  registry: Pick<ToolRegistry, 'forRole'>;
  /** An owner chat turn: the role's tools outside the agent's own set (the composer's, the chat-only ones) stay. */
  chat?:    boolean;
}

/**
 * The tools an agent is offered (spec 054). Mode `role` is the role default (no limit); mode `custom` is the agent's own
 * enabled set. The result is an allowlist for `ToolRegistry.forRole`, resolved once per run by the caller (053 FR-002).
 */
export class LoadoutService {
  constructor(private readonly d: { repo: Pick<LoadoutRepository, 'mode' | 'enabledTools'>; log?: (msg: string) => void }) {}

  /** `null` for mode `role`; the enabled names (sorted, `[NO_TOOL]` when none) for `custom`. */
  async toolsAllow(agentId: string): Promise<string[] | null> {
    if ((await this.d.repo.mode(agentId)) !== 'custom') return null;
    const names = await this.d.repo.enabledTools(agentId);
    return names.length ? names : [NO_TOOL];
  }

  /**
   * The loadout of the agent that runs, as an allowlist for a run with `opts.role`. Never throws: a loadout that cannot
   * be read leaves the role default (the run goes on rather than stops).
   *
   * The loadout covers the tools of the agent's own role. A run with another role (the chat composer of an
   * orchestrator, a planner run on the orchestrator because the child is missing) keeps the tools outside that set as
   * they are: in the chat they are all added back, in an autonomous run the loadout is not applied.
   */
  async allowFor(agent: Pick<Agent, 'id' | 'kind' | 'handle'> | null | undefined, opts: AllowOptions): Promise<string[] | null> {
    if (!agent) return null;
    try {
      const own = roleOfKind(agent.kind);
      if (!opts.chat && own !== opts.role) return null;
      const allow = await this.toolsAllow(agent.id);
      if (!allow || !opts.chat) return allow;
      const inOwn = new Set(opts.registry.forRole(own, null).map((t) => t.name));
      const outside = opts.registry.forRole(opts.role, null, { chat: true }).map((t) => t.name).filter((n) => !inOwn.has(n));
      return [...new Set([...allow, ...outside])];
    } catch (err: any) {
      this.d.log?.(`loadout of @${agent.handle} unavailable, using the role default: ${err?.message ?? err}`);
      return null;
    }
  }
}
