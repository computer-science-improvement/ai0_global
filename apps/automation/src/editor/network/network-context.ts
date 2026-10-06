import type { Agent, Platform } from '../agents/agent.types';
import { resourceRef, telegramKeyOf } from '../agents/agent.types';
import type { EditorCard } from '../card';
import { implementedFormats } from '../platform/capabilities';
import type { NetworkMode, NetworkRepository } from './network.repository';
import type { NetworkResource, Playbook } from './playbook';
import { DEFAULT_QUIET, DEFAULT_TZ, Quiet, ResourceTime } from '../time/resource-time';

/**
 * A network resource with its own clock (spec 024 FR-004): IANA zone and quiet
 * hours. networkContext always fills both; hand-built contexts may omit them
 * (then `resourceClock` falls back like networkContext without a resolver).
 */
export interface NetworkResourceClock extends NetworkResource {
  tz?:    string;
  quiet?: Quiet;
}

/** The effective clock of a context resource. */
export function resourceClock(r: NetworkResourceClock, card: Pick<EditorCard, 'channelKey' | 'timezone' | 'quietStartHour' | 'quietEndHour'>): { tz: string; quiet: Quiet } {
  const tg = r.ref === resourceRef('telegram', card.channelKey);
  return {
    tz: r.tz ?? (tg ? card.timezone : DEFAULT_TZ),
    quiet: r.quiet ?? (tg ? { start: card.quietStartHour, end: card.quietEndHour } : { ...DEFAULT_QUIET }),
  };
}

/** What an orchestrator run knows about its scope (put into ctx.extras.network). */
export interface NetworkCtx {
  orchestrator:    Agent;
  anchorKey:       string;
  groupId:         string | null;
  groupName:       string | null;
  /**
   * 'independent' → the day plan covers every resource of the group (spec 024);
   * 'legacy_duplicate' → only Telegram is planned and its posts are auto-duplicated.
   */
  mode:            'single' | NetworkMode;
  resources:       NetworkResourceClock[];
  playbook:        Playbook | null;
  playbookVersion: number | null;
  /** Telegram formats allowed by the anchor card. */
  telegramFormats: string[];
}

export interface NetworkContextDeps {
  repo: Pick<NetworkRepository, 'groupOfChannel' | 'groupResources' | 'activePlaybook'>;
  /** Resource usable for planning (019 health: not no_access / token_invalid). */
  usable?: (ref: string) => Promise<boolean>;
  /** Spec 024: per-resource zone and quiet hours. Without it Telegram uses the card, others Kyiv 23→8. */
  time?: Pick<ResourceTime, 'tzOf' | 'quietOf'>;
}

/** The clock of one resource: the resolver when wired, else the card for Telegram and the defaults for the rest. */
async function clockOf(d: NetworkContextDeps, r: NetworkResource, card: EditorCard): Promise<NetworkResourceClock> {
  if (d.time) {
    try { return { ...r, tz: await d.time.tzOf(r.ref), quiet: await d.time.quietOf(r.ref) }; } catch { /* defaults below */ }
  }
  return { ...r, ...resourceClock(r, card) };
}

/** Build the scope of an orchestrator: its Telegram anchor and, when grouped, the group's resources. */
export async function networkContext(d: NetworkContextDeps, orch: Agent, card: EditorCard): Promise<NetworkCtx | null> {
  const anchorKey = telegramKeyOf(orch);
  if (!anchorKey) return null;
  const group = await d.repo.groupOfChannel(anchorKey);
  const raw = group ? await d.repo.groupResources(group.id) : [{ ref: resourceRef('telegram', anchorKey), platform: 'telegram', title: card.title }];
  const plain: NetworkResource[] = [];
  for (const r of raw) {
    if (d.usable && r.platform !== 'telegram' && !(await d.usable(r.ref))) continue;
    plain.push({ ref: r.ref, platform: r.platform as Platform });
  }
  if (!plain.some((r) => r.platform === 'telegram')) plain.unshift({ ref: resourceRef('telegram', anchorKey), platform: 'telegram' });
  const resources: NetworkResourceClock[] = [];
  for (const r of plain) resources.push(await clockOf(d, r, card));
  const pb = await d.repo.activePlaybook(orch.id);
  const tgAllowed = new Set(implementedFormats('telegram'));
  return {
    orchestrator: orch, anchorKey, groupId: group?.id ?? null, groupName: group?.name ?? null,
    mode: !group ? 'single' : group.mode,
    resources, playbook: pb?.body ?? null, playbookVersion: pb?.version ?? null,
    telegramFormats: Object.entries(card.formats).filter(([f, w]) => Number(w) > 0 && tgAllowed.has(f)).map(([f]) => f),
  };
}
