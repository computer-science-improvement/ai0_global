import { z } from 'zod';
import { defineTool, EditorTool } from '../harness/tool';
import type { Agent } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import { proposeCard } from '../agents/builder-tools';
import type { PendingActionsService } from '../agents/pending-actions';
import type { NetworkMode } from './network.repository';
import { SWITCH_NOTE } from './network-offers';

export interface NetworkModeToolDeps {
  agents:  Pick<AgentsRepository, 'getByHandle' | 'get'>;
  actions: Pick<PendingActionsService, 'propose'>;
  /** The account group of an orchestrator's anchor channel; null when it has none. */
  groupOf: (orchestrator: Agent) => Promise<{ id: string; name: string; mode: NetworkMode } | null>;
}

/**
 * Spec 024 FR-010: @ai0 proposes a network mode change as a pending action
 * `set_network_mode` (an Apply card); Apply runs POST …/network-mode.
 */
export function buildNetworkModeTool(d: NetworkModeToolDeps): EditorTool[] {
  const tool = defineTool({
    name: 'set_network_mode',
    description: [
      'Запропонувати режим мережі агента: independent — кожен ресурс окрема одиниця, агент для кожного поста вирішує:',
      'дублювати, адаптувати, унікальний пост чи пропустити; legacy_duplicate — пости Telegram автоматично дублюються в інші ресурси (як раніше).',
      'Лише картка Apply / Discard: змінюється після кліку власника, з наступного дня плану.',
    ].join(' '),
    kind: 'act', roles: ['builder'],
    input: z.object({
      handle: z.string().min(2).max(40).describe('оркестратор мережі (або його роль)'),
      mode:   z.enum(['independent', 'legacy_duplicate']),
    }),
    execute: async ({ handle, mode }, ctx) => {
      const a = await d.agents.getByHandle(handle.replace(/^@/, ''));
      if (!a) return { error: 'unknown_agent', details: handle };
      const orch = a.parentId ? (await d.agents.get(a.parentId)) ?? a : a;
      if (orch.kind !== 'orchestrator') return { error: 'not_an_orchestrator', details: `@${orch.handle} не веде мережу` };
      const group = await d.groupOf(orch);
      if (!group) return { error: 'no_network', details: 'канал агента не входить у групу ресурсів (/app/connections/groups)' };
      if (group.mode === mode) return { error: 'already_in_mode', details: `мережа «${group.name}» вже ${mode}` };
      const summary = mode === 'independent'
        ? `Switch network "${group.name}" (@${orch.handle}) to independent resources: the agent decides per post whether to duplicate, adapt, write a unique post or skip. ${SWITCH_NOTE}`
        : `Switch network "${group.name}" (@${orch.handle}) back to auto-duplicate (legacy): Telegram posts are duplicated to the other resources from the next plan day.`;
      return proposeCard(d, ctx, 'set_network_mode', { handle: orch.handle, mode }, summary, orch.id);
    },
  });
  return [tool];
}
