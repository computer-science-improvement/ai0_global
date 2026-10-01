import type { EditorRole } from '../llm/llm.types';
import type { SkillSource } from '../skills/skill-library';
import { Agent, AgentKind, isPaused, resourceRef } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import type { SkillStore } from './skill-store';

/** What a run needs from the registry: who runs, its skill set, and whether it may run at all. */
export interface RunAgentContext {
  /** The agent the run is recorded on (a role child, or the orchestrator itself in the chat). */
  agent:        Agent | null;
  /** The resource or network orchestrator above it (or itself). */
  orchestrator: Agent | null;
  skills:       SkillSource;
  paused:       boolean;
}

export interface AgentRuntimeDeps {
  agents:   Pick<AgentsRepository, 'findTop' | 'findChild' | 'get'>;
  store:    Pick<SkillStore, 'resolveForAgent'> | null;
  fallback: SkillSource;
  log?:     (msg: string) => void;
  now?:     () => Date;
}

const CARD_KINDS: Partial<Record<EditorRole, AgentKind>> = { planner: 'planner', executor: 'executor', reviewer: 'reviewer' };

/**
 * Resolves the registry agent and its DB skills for a run (spec 017 FR-003 /
 * FR-006). Never throws: a broken registry or skill table falls back to the
 * file skills and an unrecorded agent, so publishing keeps working.
 */
export class AgentRuntime {
  constructor(private readonly d: AgentRuntimeDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** A scheduled role of a Telegram channel (planner / executor / reviewer), or the channel agent in the chat (composer). */
  async forChannel(channelKey: string, role: EditorRole): Promise<RunAgentContext> {
    try {
      const orch = await this.d.agents.findTop('orchestrator', 'resource', resourceRef('telegram', channelKey));
      if (!orch) return this.bare();
      const kind = CARD_KINDS[role];
      const child = kind ? await this.d.agents.findChild(orch.id, kind) : null;
      return this.context(child ?? orch, orch, role);
    } catch (err: any) {
      this.d.log?.(`agent runtime for ${channelKey}/${role} failed: ${err?.message ?? err}`);
      return this.bare();
    }
  }

  /** Any registry agent running as `role` (manager, builder, orchestrator, idea reviewer…). */
  async forAgent(agent: Agent, role: EditorRole): Promise<RunAgentContext> {
    try {
      const orch = agent.parentId ? await this.d.agents.get(agent.parentId) : agent;
      return this.context(agent, orch ?? agent, role);
    } catch (err: any) {
      this.d.log?.(`agent runtime for @${agent.handle} failed: ${err?.message ?? err}`);
      return { agent, orchestrator: agent, skills: this.d.fallback, paused: isPaused(agent, this.now()) };
    }
  }

  private bare(): RunAgentContext {
    return { agent: null, orchestrator: null, skills: this.d.fallback, paused: false };
  }

  private async context(agent: Agent, orch: Agent, role: EditorRole): Promise<RunAgentContext> {
    const now = this.now();
    const paused = isPaused(orch, now) || isPaused(agent, now);
    let skills: SkillSource = this.d.fallback;
    if (this.d.store) {
      try {
        const view = await this.d.store.resolveForAgent([...new Set([agent.id, orch.id])], role);
        // An empty view means the builtins were never synced — the file library is the safe default.
        if (view.list().length) skills = view;
      } catch (err: any) {
        this.d.log?.(`skills of @${agent.handle} unavailable, using files: ${err?.message ?? err}`);
      }
    }
    return { agent, orchestrator: orch, skills, paused };
  }
}
