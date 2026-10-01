import type { Agent, Platform } from '../agents/agent.types';
import { resourceRef, telegramKeyOf } from '../agents/agent.types';
import type { EditorCard } from '../card';
import { implementedFormats } from '../platform/capabilities';
import type { NetworkRepository } from './network.repository';
import type { NetworkResource, Playbook } from './playbook';

/** What an orchestrator run knows about its scope (put into ctx.extras.network). */
export interface NetworkCtx {
  orchestrator:    Agent;
  anchorKey:       string;
  groupId:         string | null;
  groupName:       string | null;
  /** 'orchestrated' → the day plan covers every resource of the group. */
  mode:            'single' | 'mirror' | 'orchestrated';
  resources:       NetworkResource[];
  playbook:        Playbook | null;
  playbookVersion: number | null;
  /** Telegram formats allowed by the anchor card. */
  telegramFormats: string[];
}

export interface NetworkContextDeps {
  repo: Pick<NetworkRepository, 'groupOfChannel' | 'groupResources' | 'activePlaybook'>;
  /** Resource usable for planning (019 health: not no_access / token_invalid). */
  usable?: (ref: string) => Promise<boolean>;
}

/** Build the scope of an orchestrator: its Telegram anchor and, when grouped, the group's resources. */
export async function networkContext(d: NetworkContextDeps, orch: Agent, card: EditorCard): Promise<NetworkCtx | null> {
  const anchorKey = telegramKeyOf(orch);
  if (!anchorKey) return null;
  const group = await d.repo.groupOfChannel(anchorKey);
  const raw = group ? await d.repo.groupResources(group.id) : [{ ref: resourceRef('telegram', anchorKey), platform: 'telegram', title: card.title }];
  const resources: NetworkResource[] = [];
  for (const r of raw) {
    if (d.usable && r.platform !== 'telegram' && !(await d.usable(r.ref))) continue;
    resources.push({ ref: r.ref, platform: r.platform as Platform });
  }
  if (!resources.some((r) => r.platform === 'telegram')) resources.unshift({ ref: resourceRef('telegram', anchorKey), platform: 'telegram' });
  const pb = await d.repo.activePlaybook(orch.id);
  const tgAllowed = new Set(implementedFormats('telegram'));
  return {
    orchestrator: orch, anchorKey, groupId: group?.id ?? null, groupName: group?.name ?? null,
    mode: !group ? 'single' : group.mode,
    resources, playbook: pb?.body ?? null, playbookVersion: pb?.version ?? null,
    telegramFormats: Object.entries(card.formats).filter(([f, w]) => Number(w) > 0 && tgAllowed.has(f)).map(([f]) => f),
  };
}
