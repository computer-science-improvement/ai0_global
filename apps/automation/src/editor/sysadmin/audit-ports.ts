import type { Agent } from '../agents/agent.types';
import { telegramKeyOf } from '../agents/agent.types';
import type { EditorCard } from '../card';
import type { NetworkRepository } from '../network/network.repository';
import { playbookWarnings, validatePlaybook } from '../network/playbook';
import { normalizePlaybook } from '../network/series-edit';
import type { SeriesSourceCatalog } from '../network/series';
import type { AuditQueriesDeps } from './audit-queries';

/**
 * Spec 055: the ports of the audit that read through existing services (kept out of editor.module.ts so the module only
 * wires them). Each one only reads.
 */

export interface PlaybookPortDeps {
  repo:    Pick<NetworkRepository, 'activePlaybook'>;
  card:    (channelKey: string) => Promise<EditorCard | null>;
  /** networkContext of the orchestrator: the resources and Telegram formats the playbook is checked against. */
  net:     (orch: Agent, card: EditorCard) => Promise<{ resources: Parameters<typeof validatePlaybook>[1]; telegramFormats: string[] } | null>;
  catalog: (card: EditorCard) => Promise<SeriesSourceCatalog | null>;
}

/**
 * The `memory_retire` fix (spec 064 FR-009). A reviewer row is retired as before; a row of the owner is retired only
 * because a finding of the report (a rule the lint flags) carries this fix and the owner applied it.
 */
export function retireMemoryPort(repo: { retireByReviewer(channel: string, id: number): Promise<boolean>; retireByOwner(channel: string, id: number): Promise<boolean> }) {
  return async (channel: string, id: number): Promise<boolean> => (await repo.retireByReviewer(channel, id)) || (await repo.retireByOwner(channel, id));
}

/** The active playbook of an orchestrator with its hard errors and soft warnings; null = no playbook or no network. */
export function playbookPort(d: PlaybookPortDeps): AuditQueriesDeps['playbook'] {
  return async (orch) => {
    const key = telegramKeyOf(orch);
    const card = key ? await d.card(key) : null;
    if (!card) return null;
    const row = await d.repo.activePlaybook(orch.id);
    if (!row) return null;
    const net = await d.net(orch, card);
    if (!net) return null;
    const body = normalizePlaybook(row.body);
    const errors = validatePlaybook(body, net.resources, net.telegramFormats, { sources: await d.catalog(card).catch(() => null) });
    return { version: row.version, errors, warnings: playbookWarnings(body).map((w) => ({ code: w.code, ref: w.ref, uk: w.uk, en: w.en })) };
  };
}
