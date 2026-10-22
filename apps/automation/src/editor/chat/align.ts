import type { Agent } from '../agents/agent.types';
import { FIX_CONFIG_CONFLICTS_KIND, fixConflictsSummary } from '../agents/builder-tools';
import type { PendingActionsService } from '../agents/pending-actions';
import type { ConfigConflictsService } from '../rules/config-conflicts.service';
import type { SlashAlign } from './slash-commands';

/**
 * Spec 062 FR-008: `/align @channel` in code. In review 3 «Resolve in one card» ran a whole model turn (44 tools, $0.03–0.09)
 * for one deterministic `fix_config_conflicts` call; this is that call without the model: the agent of the channel (or the
 * agent named by its handle), the resolver's items, the same card.
 */
export interface AlignDeps {
  agents:        { getByHandle(handle: string): Promise<Agent | null>; get(id: string): Promise<Agent | null>; list(): Promise<Agent[]> };
  channelKeyOf:  (a: Agent) => Promise<string | null>;
  conflicts:     Pick<ConfigConflictsService, 'resolverFor'>;
  actions:       Pick<PendingActionsService, 'propose'>;
}

/** The orchestrator a `@name` points at: the agent with this handle, else the agent that works on this channel. */
async function orchestratorFor(d: AlignDeps, target: string): Promise<Agent | null> {
  const name = target.replace(/^telegram:/, '').replace(/^@+/, '').toLowerCase();
  if (!name) return null;
  let a = await d.agents.getByHandle(name);
  if (!a) {
    for (const x of await d.agents.list()) {
      if (x.parentId) continue;
      const key = await d.channelKeyOf(x).catch(() => null);
      if (key && key.replace(/^@+/, '').toLowerCase() === name) { a = x; break; }
    }
  }
  if (!a) return null;
  return a.parentId ? (await d.agents.get(a.parentId)) ?? a : a;
}

export async function alignAgent(d: AlignDeps, target: string, chatId: string | null): Promise<SlashAlign> {
  const orch = await orchestratorFor(d, target);
  if (!orch) return { ok: false, error: 'unknown_agent' };
  const items = await d.conflicts.resolverFor(orch);
  if (!items.length) return { ok: true, handle: orch.handle, action: null, items: [] };
  const action = await d.actions.propose({
    chatId, agentId: orch.id, kind: FIX_CONFIG_CONFLICTS_KIND, payload: { handle: orch.handle, items }, summary: fixConflictsSummary(orch.handle, items),
  });
  return { ok: true, handle: orch.handle, action, items: items.map((i) => i.detail) };
}
