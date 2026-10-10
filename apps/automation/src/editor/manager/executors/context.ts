import { telegramKeyOf, type Agent } from '../../agents/agent.types';
import { effectiveMode } from '../../card';
import type { EditorChannelsRepository } from '../../repo/editor-channels.repository';
import { networkContext, type NetworkContextDeps } from '../../network/network-context';
import { normalizePlaybook } from '../../network/series-edit';
import type { ResourcePauseService } from '../../pauses/resource-pauses';
import type { AudienceCaps } from '../../post/audience-asks';
import type { EvidencePost } from '../quality-digest';
import type { ExecContext } from './types';

export interface ExecContextDeps extends NetworkContextDeps {
  channels: Pick<EditorChannelsRepository, 'get'>;
  /** Spec 025 FR-013: active pauses (the pause_resource plan refuses a resource that is already paused). */
  pauses?:  Pick<ResourcePauseService, 'active'>;
  /** Spec 034 FR-006: rejected / critic-flagged posts a voice_fix may quote (14 days). */
  evidence?: (refs: string[], since: Date) => Promise<EvidencePost[]>;
  /** Spec 034 FR-006: caps and owner locks per resource (format_mix). */
  audience?: (refs: string[]) => Promise<Record<string, { caps: AudienceCaps; locks: string[] }>>;
  now?:     () => Date;
}

export const EVIDENCE_DAYS = 14;

/**
 * The scope an executor plans against (spec 025 FR-004/FR-009): the orchestrator's anchor card, its network
 * (resources usable now, with the group), the active playbook and the effective mode. Fresh on every call.
 */
export function executionContextOf(d: ExecContextDeps): (orch: Agent) => Promise<ExecContext> {
  return async (orch) => {
    const now = (d.now ?? (() => new Date()))();
    const key = telegramKeyOf(orch);
    const card = key ? await d.channels.get(key) : null;
    const net = card ? await networkContext(d, orch, card) : null;
    const refs = net?.resources.map((r) => r.ref) ?? [];
    return {
      orch, card, net, now,
      playbook: net?.playbook ? normalizePlaybook(net.playbook) : null,
      mode: card ? effectiveMode(orch.mode ?? null, card.mode) : undefined,
      ...(d.pauses ? { pauses: (await d.pauses.active(now)).map((p) => ({ ref: p.resourceRef, until: p.until })) } : {}),
      ...(d.evidence && refs.length ? { evidence: await d.evidence(refs, new Date(now.getTime() - EVIDENCE_DAYS * 86_400_000)) } : {}),
      ...(d.audience && refs.length ? { audience: await d.audience(refs) } : {}),
    };
  };
}
