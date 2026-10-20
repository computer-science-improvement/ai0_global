import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { ToolRegistry } from '../harness/tool-registry';
import type { Agent } from '../agents/agent.types';
import { parseResourceRef, roleOfKind } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { SkillStore } from '../agents/skill-store';
import type { LoadoutRepository } from './loadout.repository';
import type { LoadoutUsage } from './loadout-usage';
import { isProtectedSkill } from '../skills/skill-library';
import { coreOf, universeOf } from './loadout-profiles';
import { buildLoadoutView, type LoadoutView, type RulesView } from './loadout-view';

export interface LoadoutAdminDeps {
  agents:   Pick<AgentsRepository, 'getByHandle' | 'get'>;
  repo:     Pick<LoadoutRepository, 'mode' | 'enabledTools' | 'setTools' | 'reset'>;
  usage:    Pick<LoadoutUsage, 'forAgents'> & Partial<Pick<LoadoutUsage, 'peerRates'>>;
  registry: Pick<ToolRegistry, 'all'>;
  skills:   Pick<SkillStore, 'listForAgent'> & Partial<Pick<SkillStore, 'setToggle'>>;
  /** The channel's rules the agent follows (read-only counts). */
  rules:    (agent: Agent, orchestrator: Agent) => Promise<RulesView>;
}

const ToolsBody = z.object({ tools: z.array(z.string().min(1).max(100)).max(300) }).strict();
const toolName = z.string().min(1).max(100);
const ApplyBody = z.object({
  add: z.array(toolName).max(300).default([]), remove: z.array(toolName).max(300).default([]), disableSkills: z.array(toolName).max(100).default([]),
}).strict();

const badRequest = (r: z.ZodError) => new BadRequestException({ error: 'invalid_body', issues: r.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

/** The owner surface of an agent's loadout (spec 054 FR-004): the view, the tool set, the reset. */
export class LoadoutAdminService {
  constructor(private readonly d: LoadoutAdminDeps) {}

  private async require(handle: string): Promise<Agent> {
    const a = await this.d.agents.getByHandle(handle);
    if (!a) throw new NotFoundException({ error: 'agent_not_found', handle });
    return a;
  }

  async view(handle: string): Promise<LoadoutView> {
    return this.viewOf(await this.require(handle));
  }

  async viewOf(a: Agent): Promise<LoadoutView> {
    const orch = a.parentId ? ((await this.d.agents.get(a.parentId)) ?? a) : a;
    const mode = await this.d.repo.mode(a.id);
    const [enabled, usage, skills, rules, peers] = await Promise.all([
      mode === 'custom' ? this.d.repo.enabledTools(a.id) : Promise.resolve([]),
      this.d.usage.forAgents([a.id]),
      this.d.skills.listForAgent(a.parentId ? [a.id, a.parentId] : [a.id]),
      this.d.rules(a, orch).catch(() => ({ ownerRules: 0, memory: 0, steeringSets: 0, playbookRules: 0, chars: 0 })),
      this.d.usage.peerRates?.(roleOfKind(a.kind), [a.id]).catch(() => null) ?? Promise.resolve(null),
    ]);
    return buildLoadoutView({
      role: roleOfKind(a.kind), mode, enabled, tools: this.d.registry.all(), usage: usage.get(a.id)!, skills, rules, peers,
    });
  }

  /**
   * Sets the agent's enabled tools to exactly `tools` and the mode to `custom`. Core tools cannot be dropped
   * (`core_tool`); a name that is not a tool of the agent's role is refused (`unknown_tool`). The terminal tools are
   * always offered, so they are stored whether the list names them or not.
   */
  async putTools(handle: string, body: unknown): Promise<LoadoutView> {
    const a = await this.require(handle);
    const p = ToolsBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const names = await this.checked(a, p.data.tools);
    await this.d.repo.setTools(a.id, names, 'owner');
    return this.viewOf(a);
  }

  /**
   * Applies suggestions (FR-004/FR-005): the agent's effective tools plus `add` minus `remove`, as a custom loadout
   * written by 'recommend'; `disableSkills` switches skills off for the agent. Validated like a PUT: a core tool in
   * `remove` is `core_tool`, an unknown name in `add` is `unknown_tool` (a stale name in `remove` is fine).
   */
  async apply(handle: string, body: unknown): Promise<LoadoutView> {
    const a = await this.require(handle);
    const p = ApplyBody.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const { add, remove, disableSkills } = p.data;
    if (disableSkills.length) await this.disableSkills(a, disableSkills);
    if (add.length || remove.length) {
      const now = await this.viewOf(a);
      const wanted = new Set(now.tools.filter((t) => t.enabled).map((t) => t.name));
      for (const n of add) wanted.add(n);
      for (const n of remove) wanted.delete(n);
      const names = await this.checked(a, [...wanted]);
      await this.d.repo.setTools(a.id, names, 'recommend');
    }
    return this.viewOf(a);
  }

  private async disableSkills(a: Agent, wanted: string[]): Promise<void> {
    const role = roleOfKind(a.kind);
    const entries = await this.d.skills.listForAgent(a.parentId ? [a.id, a.parentId] : [a.id]);
    const picked = [...new Set(wanted)].map((n) => ({ n, e: entries.find((x) => x.skill.name === n && x.skill.appliesTo.includes(role)) }));
    const unknown = picked.filter((x) => !x.e).map((x) => x.n);
    if (unknown.length) throw new BadRequestException({ error: 'unknown_skill', details: `not a skill of the ${role} role: ${unknown.join(', ')}`, skills: unknown });
    const locked = picked.filter((x) => x.e!.skill.safety || isProtectedSkill(x.n)).map((x) => x.n);
    if (locked.length) throw new BadRequestException({ error: 'safety_skill', details: `safety and voice skills stay on: ${locked.join(', ')}`, skills: locked });
    if (!this.d.skills.setToggle) throw new BadRequestException({ error: 'skills_unavailable' });
    for (const x of picked) await this.d.skills.setToggle(a.id, x.e!.skill.id, { enabled: false });
  }

  /** Back to the role default. */
  async reset(handle: string): Promise<LoadoutView> {
    const a = await this.require(handle);
    await this.d.repo.reset(a.id);
    return this.viewOf(a);
  }

  /** The names validated against the agent's role, plus its terminal tools. */
  async checked(a: Agent, wanted: string[]): Promise<string[]> {
    const role = roleOfKind(a.kind);
    const universe = universeOf(role, this.d.registry.all());
    const known = new Set(universe.map((t) => t.name));
    const unknown = [...new Set(wanted)].filter((n) => !known.has(n));
    if (unknown.length) throw new BadRequestException({ error: 'unknown_tool', details: `not a tool of the ${role} role: ${unknown.join(', ')}`, tools: unknown });
    const core = coreOf(role, universe);
    const terminal = new Set(universe.filter((t) => t.kind === 'terminal').map((t) => t.name));
    const missing = [...core].filter((n) => !terminal.has(n) && !wanted.includes(n));
    if (missing.length) throw new BadRequestException({ error: 'core_tool', details: `core tools cannot be dropped: ${missing.join(', ')}`, tools: missing });
    return universe.map((t) => t.name).filter((n) => wanted.includes(n) || terminal.has(n));
  }
}

/** The channel a loadout's rules belong to: the agent's own resource (a network's anchor for a network). */
export function rulesTarget(orch: Agent, channelKey: string | null): { channelKey: string | null; resourceRef: string | null; orchestratorId: string | null } {
  const ref = orch.scope === 'resource' && orch.scopeId && parseResourceRef(orch.scopeId) ? orch.scopeId : channelKey ? `telegram:${channelKey}` : null;
  return { channelKey, resourceRef: ref, orchestratorId: orch.kind === 'orchestrator' ? orch.id : null };
}
