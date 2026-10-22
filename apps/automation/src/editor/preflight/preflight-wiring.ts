import type { Pool } from 'pg';
import { ContentLedger } from '../../data/content-ledger';
import { PgHostFailures } from '../net/host-failures';
import type { NetworkRepository } from '../network/network.repository';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { freshnessHoursOf } from '../post/integrity/checks/dates';
import { resourceStyleOf } from '../post/style/style-store';
import { SlotPreflight, type PreflightIdeas } from './slot-preflight';

/** The idea pool as the pre-flight sees it (NetworkRepository). */
export function preflightIdeas(ideas: Pick<NetworkRepository, 'idea' | 'listIdeas' | 'claimIdea' | 'releaseIdea'>): PreflightIdeas {
  return {
    idea: (id) => ideas.idea(id),
    accepted: (agentId, limit) => ideas.listIdeas(agentId, ['accepted'], limit),
    claim: (id) => ideas.claimIdea(id),
    release: (id, to, reason) => ideas.releaseIdea(id, to, reason),
  };
}

/** The production pre-flight (spec 061 FR-001): the content ledger, the host-failure table, the idea pool and the resource style sheet. */
export function buildSlotPreflight(o: {
  pool: Pool; env: (key: string) => string | undefined; ideas: NetworkRepository; plans: Pick<EditorPlansRepository, 'retopicSlot'>; log?: (msg: string) => void;
}): SlotPreflight {
  return new SlotPreflight({
    ledger: new ContentLedger(o.pool, o.log),
    hosts: new PgHostFailures(o.pool),
    ideas: preflightIdeas(o.ideas),
    retopic: (id, patch) => o.plans.retopicSlot(id, patch),
    env: o.env,
    freshnessHours: async (slot, card) => {
      const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
      const style = (await resourceStyleOf(o.pool, ref)).effective;
      return freshnessHoursOf({ style: style ?? card.style });
    },
    log: o.log,
  });
}
