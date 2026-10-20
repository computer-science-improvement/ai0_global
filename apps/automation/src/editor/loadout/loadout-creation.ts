import type { ToolRegistry } from '../harness/tool-registry';
import { Agent, parseResourceRef, roleOfKind, type Platform } from '../agents/agent.types';
import type { LoadoutRepository } from './loadout.repository';
import type { LoadoutUsage } from './loadout-usage';
import { creationLoadout, needsOf, PEER_MIN_RUNS, PEER_START_RATE } from './loadout-profiles';

export interface LoadoutCreationDeps {
  repo:     Pick<LoadoutRepository, 'initTools'>;
  usage:    Pick<LoadoutUsage, 'peerTools'>;
  /** The tool registry; it is built after the agent infrastructure, so it is read when an agent is created. */
  registry: () => Pick<ToolRegistry, 'all'> | null;
  /** The platforms the agent's resource publishes to (its own and its network's). */
  platforms: (agent: Agent) => Promise<Platform[]>;
  log?:     (msg: string) => void;
}

/**
 * The loadout of a new agent (spec 054 FR-003): formed once, when the agent is created, as mode `custom` with the core
 * tools, the tools its resource needs and the tools its peers use. Never throws and never touches an agent that already
 * has a loadout, so the registry sync can call it for every agent it creates and a second sync changes nothing.
 */
export class LoadoutCreation {
  constructor(private readonly d: LoadoutCreationDeps) {}

  /** Returns whether a loadout was written. */
  async form(agent: Agent): Promise<boolean> {
    try {
      const registry = this.d.registry();
      if (!registry) return false;
      const role = roleOfKind(agent.kind);
      const platforms = await this.d.platforms(agent);
      const peers = await this.d.usage.peerTools(role, [agent.id], PEER_START_RATE, PEER_MIN_RUNS);
      const tools = creationLoadout(role, registry.all(), needsOf(platforms), peers);
      if (!tools.length) return false;
      const wrote = await this.d.repo.initTools(agent.id, tools, 'creation');
      if (wrote) this.d.log?.(`loadout of @${agent.handle} (${role}): ${tools.length} tools`);
      return wrote;
    } catch (err: any) {
      // The agent keeps the role default (mode role): a creation never fails on its loadout.
      this.d.log?.(`loadout of @${agent.handle} not formed: ${err?.message ?? err}`);
      return false;
    }
  }
}

/**
 * The platforms of an agent's resource: its own, and for a Telegram resource in a network the platforms of the other
 * members. `members` returns the platforms of the group a Telegram channel belongs to (none when it has no group).
 */
export function resourcePlatforms(members: (channelKey: string) => Promise<string[]>) {
  return async (agent: Pick<Agent, 'scope' | 'scopeId' | 'parentId'>): Promise<Platform[]> => {
    const own = agent.scope === 'resource' && agent.scopeId ? parseResourceRef(agent.scopeId) : null;
    if (!own) return agent.scope === 'system' ? [] : ['telegram'];
    const out = new Set<string>([own.platform]);
    if (own.platform === 'telegram') for (const p of await members(own.id).catch(() => [])) out.add(p);
    return [...out] as Platform[];
  };
}
