import type { Pool } from 'pg';
import { ContentLedger } from '../../data/content-ledger';
import { buildCatalog } from '../../data/data-catalog';
import { kyivMonthDay } from '../../data/data-query';
import { parseDataRef, resolveContentRef } from '../../data/data-refs';
import { PgHostFailures } from '../net/host-failures';
import type { NetworkRepository } from '../network/network.repository';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { freshnessHoursOf } from '../post/integrity/checks/dates';
import { resourceStyleOf } from '../post/style/style-store';
import { SlotPreflight, type PreflightIdeas, type PreflightMaterial } from './slot-preflight';

/** The idea pool as the pre-flight sees it (NetworkRepository). */
export function preflightIdeas(ideas: Pick<NetworkRepository, 'idea' | 'listIdeas' | 'claimIdea' | 'releaseIdea'>): PreflightIdeas {
  return {
    idea: (id) => ideas.idea(id),
    accepted: (agentId, limit) => ideas.listIdeas(agentId, ['accepted'], limit),
    claim: (id) => ideas.claimIdea(id),
    release: (id, to, reason) => ideas.releaseIdea(id, to, reason),
  };
}

/**
 * Spec 068 FR-006: library rows and datasets from the data store. One statement per row (by `data://` id or by the legacy
 * `library://` ref), through the dataset's own `post_requires`; a dataset's unposted count is the catalog's `unposted_here`
 * (the same number the series guard and library_catalog show).
 */
export function pgPreflightMaterial(pool: Pick<Pool, 'query'>): PreflightMaterial {
  return {
    row: async (ref) => {
      const d = parseDataRef(ref);
      const { rows } = await pool.query(
        `SELECT d.status, data_postable(s.post_requires, d.data) AS ok, data_post_missing(s.post_requires, d.data) AS miss
           FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
          WHERE ($1::text IS NOT NULL AND s.key = $1::text AND d.id = $2::bigint) OR ($3::text IS NOT NULL AND d.legacy_ref = $3::text)
          LIMIT 1`,
        [d?.schemaKey ?? null, d?.id ?? null, d ? null : ref]);
      const r = rows[0];
      return r ? { active: r.status === 'active', postable: !!r.ok, missing: (r.miss ?? []) as string[] } : null;
    },
    unposted: async (resourceRef, dataset) => (await buildCatalog(pool, { dataset, resource: resourceRef, today: kyivMonthDay() }))[0]?.unposted_here ?? null,
  };
}

/** The production pre-flight (spec 061 FR-001): the content ledger, the host-failure table, the idea pool and the resource style sheet. */
export function buildSlotPreflight(o: {
  pool: Pool; env: (key: string) => string | undefined; ideas: NetworkRepository; plans: Pick<EditorPlansRepository, 'retopicSlot'>; log?: (msg: string) => void;
}): SlotPreflight {
  return new SlotPreflight({
    ledger: new ContentLedger(o.pool, o.log),
    material: pgPreflightMaterial(o.pool),
    hosts: new PgHostFailures(o.pool),
    ideas: preflightIdeas(o.ideas),
    retopic: (id, patch) => o.plans.retopicSlot(id, patch),
    env: o.env,
    canonicalRef: async (ref) => (await resolveContentRef(o.pool, ref).catch(() => null))?.dataRef ?? ref,
    freshnessHours: async (slot, card) => {
      const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
      const style = (await resourceStyleOf(o.pool, ref)).effective;
      return freshnessHoursOf({ style: style ?? card.style });
    },
    log: o.log,
  });
}
