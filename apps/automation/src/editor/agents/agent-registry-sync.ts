import type { EditorCard } from '../card';
import { Agent, deriveHandle, ORCHESTRATOR_CHILDREN, resourceRef, withSuffix } from './agent.types';
import type { AgentsRepository } from './agents.repository';

export interface RegistrySyncDeps {
  agents:   Pick<AgentsRepository, 'findTop' | 'findChild' | 'insert' | 'update' | 'allHandles' | 'linkLegacyRuns'>;
  channels: { list(): Promise<EditorCard[]> };
  log?:     (msg: string) => void;
}

const CHILD_NAMES: Record<string, string> = {
  planner: 'Planner', executor: 'Executor', reviewer: 'Reviewer', idea_reviewer: 'Idea reviewer',
};

/**
 * Keeps the agent registry in step with the editorial cards (spec 017 FR-002):
 * every card gets a resource orchestrator (telegram:<channel_key>) plus its
 * role children, and the orchestrator's mode mirrors the card's mode (the card
 * stays the source of truth for publishing). Idempotent; safe on every boot.
 */
export class AgentRegistrySync {
  constructor(private readonly d: RegistrySyncDeps) {}

  async run(): Promise<{ created: number; updated: number; linkedRuns: number }> {
    const cards = await this.d.channels.list();
    const handles = await this.d.agents.allHandles();
    let created = 0;
    let updated = 0;

    for (const card of cards) {
      const scopeId = resourceRef('telegram', card.channelKey);
      let orch = await this.d.agents.findTop('orchestrator', 'resource', scopeId);
      if (!orch) {
        const handle = withSuffix(deriveHandle(card.channelKey, 'ch'), (h) => handles.has(h));
        handles.add(handle);
        orch = await this.d.agents.insert({
          kind: 'orchestrator', scope: 'resource', scopeId, name: card.title ?? card.channelKey, handle,
          emoji: '📣', mode: card.mode, createdBy: 'sync',
        });
        created++;
        this.d.log?.(`agent registry: @${handle} for ${card.channelKey}`);
      } else if (orch.mode !== card.mode) {
        await this.d.agents.update(orch.id, { mode: card.mode });
        updated++;
      }
      created += await this.ensureChildren(orch, handles);
    }
    const linkedRuns = await this.d.agents.linkLegacyRuns();
    return { created, updated, linkedRuns };
  }

  /** Planner, executor, reviewer and idea reviewer under an orchestrator (handles `<parent>_<kind>`). */
  async ensureChildren(orch: Agent, handles?: Set<string>): Promise<number> {
    const taken = handles ?? await this.d.agents.allHandles();
    let n = 0;
    for (const kind of ORCHESTRATOR_CHILDREN) {
      if (await this.d.agents.findChild(orch.id, kind)) continue;
      const handle = withSuffix(deriveHandle(`${orch.handle}_${kind === 'idea_reviewer' ? 'ideas' : kind}`), (h) => taken.has(h));
      taken.add(handle);
      await this.d.agents.insert({
        kind, scope: orch.scope, scopeId: orch.scopeId, parentId: orch.id, name: `${CHILD_NAMES[kind]} · ${orch.name}`,
        handle, mode: orch.mode, createdBy: 'sync',
      });
      n++;
    }
    return n;
  }
}
