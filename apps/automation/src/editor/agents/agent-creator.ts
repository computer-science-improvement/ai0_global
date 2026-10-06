import { z } from 'zod';
import type { EditorCard } from '../card';
import { makeDefaultCard } from '../chat/default-card';
import { Agent, parseResourceRef, validateHandle } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import type { AgentRegistrySync } from './agent-registry-sync';
import type { ResourceCatalog } from './resource-catalog';
import { ResourceProfileSchema, ResourceProfilesRepository, renderProfile } from './resource-profile';

/**
 * Spec 031 FR-002: a new resource and its agent start in `approve` — the agent
 * writes real posts and each one waits for the owner. This replaced the 3-day
 * shadow start; `shadow` stays a manual dry-run mode.
 */
export const NEW_RESOURCE_MODE = 'approve' as const;

export const CreateAgentSchema = z.object({
  resource_ref:     z.string().min(3).max(200).optional(),
  network_id:       z.string().uuid().optional(),
  name:             z.string().trim().min(1).max(60),
  handle:           z.string().trim().toLowerCase().transform((s) => s.replace(/^@/, '')),
  emoji:            z.string().trim().max(8).optional(),
  description:      z.string().trim().max(500).optional(),
  profile:          ResourceProfileSchema,
  brief:            z.string().trim().max(4000).optional(),
  schedule:         z.object({ times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(8) }).optional(),
  daily_budget_usd: z.number().min(0).max(50).optional(),
  model:            z.string().trim().min(3).max(100).optional(),
}).refine((v) => !!v.resource_ref !== !!v.network_id, { message: 'exactly one of resource_ref or network_id is required' });
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;

export interface AgentCreatorDeps {
  agents:   Pick<AgentsRepository, 'findTop' | 'handleTaken' | 'insert'>;
  registry: Pick<AgentRegistrySync, 'ensureChildren'>;
  catalog:  Pick<ResourceCatalog, 'list'>;
  profiles: Pick<ResourceProfilesRepository, 'setProfile'>;
  channels: { get(key: string): Promise<EditorCard | null>; insertIfMissing(c: EditorCard): Promise<boolean> };
  /** Spec 020: build the first playbook from the brief in the background. */
  onBrief?: (agent: Agent, brief: string) => Promise<void>;
  now?:     () => Date;
}

/** Brief for a new channel card when the owner gave none: the profile itself. */
export function briefFromProfile(input: CreateAgentInput): string {
  return input.brief?.trim() || renderProfile(input.profile);
}

/**
 * Creates an orchestrator from a resource profile (spec 018 FR-007). Dry-run
 * `validate` runs when the card is proposed and again when it is applied, so a
 * stale card (handle taken meanwhile) fails with a clear reason.
 */
export class AgentCreator {
  constructor(private readonly d: AgentCreatorDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async validate(raw: unknown): Promise<{ ok: true; input: CreateAgentInput; scope: 'resource' | 'network'; scopeId: string } | { error: string; details?: unknown }> {
    const p = CreateAgentSchema.safeParse(raw);
    if (!p.success) return { error: 'invalid_agent', details: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    const input = p.data;
    const herr = validateHandle(input.handle);
    if (herr) return { error: 'invalid_handle', details: herr };
    if (await this.d.agents.handleTaken(input.handle)) return { error: 'handle_taken', details: `@${input.handle} is already taken` };

    const resources = await this.d.catalog.list();
    if (input.resource_ref) {
      const r = resources.find((x) => x.ref === input.resource_ref);
      if (!r) return { error: 'resource_not_connected', details: `${input.resource_ref} is not connected — /app/connections` };
      if (r.agent) return { error: 'resource_has_agent', details: `the resource is already run by @${r.agent}` };
      if (!parseResourceRef(input.resource_ref)) return { error: 'invalid_ref' };
      return { ok: true, input, scope: 'resource', scopeId: input.resource_ref };
    }
    // A network is run by the orchestrator of its Telegram channel (spec 020): create that one.
    const members = resources.filter((x) => x.groupId === input.network_id);
    if (!members.length) return { error: 'network_not_found', details: 'the account group is empty or does not exist' };
    const anchor = members.find((x) => x.platform === 'telegram');
    if (!anchor) return { error: 'network_needs_telegram', details: 'a network is run by the agent of its Telegram channel — add the channel to the group' };
    if (anchor.agent) return { error: 'network_has_agent', details: `the network's channel is already run by @${anchor.agent} — turn on network mode on its page` };
    return { ok: true, input: { ...input, resource_ref: anchor.ref, network_id: undefined }, scope: 'resource', scopeId: anchor.ref };
  }

  async create(raw: unknown): Promise<{ agent: Agent; cardCreated: boolean } | { error: string; details?: unknown }> {
    const v = await this.validate(raw);
    if ('error' in v) return v;
    const { input, scope, scopeId } = v;

    // The agent first: the hourly registry sync then finds it and never creates a duplicate for the new card.
    const agent = await this.d.agents.insert({
      kind: 'orchestrator', scope, scopeId, name: input.name, handle: input.handle, emoji: input.emoji ?? '📣',
      description: input.description ?? input.profile.topic, mode: NEW_RESOURCE_MODE, shadowUntil: null,
      schedule: input.schedule ?? { times: ['06:30'] }, dailyBudgetUsd: input.daily_budget_usd ?? null, model: input.model ?? null,
      createdBy: 'builder',
    });
    await this.d.registry.ensureChildren(agent);
    await this.d.profiles.setProfile(scope === 'resource' ? scopeId : `network:${scopeId}`, input.profile, 'builder');

    let cardCreated = false;
    const tg = scope === 'resource' ? parseResourceRef(scopeId) : null;
    if (tg?.platform === 'telegram' && !(await this.d.channels.get(tg.id))) {
      cardCreated = await this.d.channels.insertIfMissing({
        ...makeDefaultCard(tg.id, input.name), mode: NEW_RESOURCE_MODE, brief: briefFromProfile(input), bannedTerms: input.profile.taboo.slice(0, 50),
      });
    }
    if (input.brief && this.d.onBrief) {
      try { await this.d.onBrief(agent, input.brief); } catch { /* the playbook job retries on its own schedule */ }
    }
    return { agent, cardCreated };
  }
}
