import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import type { HostFailures } from '../net/host-failures';
import { safeGet } from '../net/safe-http';
import { readFeed } from '../live/feed-items';
import { API_ADAPTERS, makeAdapterContext, type ApiSourceName } from '../tools/api-adapters';
import type { OwnerInbox } from '../agents/owner-inbox';
import { SourceHealthRepository } from './source-health.repository';
import { DECLINED_DAYS, SourceHealthService } from './source-health.service';
import { SOURCE_CHANGE_KIND, type CandidateDeps } from './source-change';

/** Spec 049 FR-003: the source health service over the run trace and the blocked hosts. */
export function sourceHealthOf(pool: Pool, channels: { get(key: string): Promise<EditorCard | null> }, inbox?: Pick<OwnerInbox, 'post'>): SourceHealthService {
  return new SourceHealthService({ repo: new SourceHealthRepository(pool), channels, pool, ...(inbox ? { inbox } : {}) });
}

/** Spec 049 FR-004: how a candidate source is read before the owner sees it. */
export function candidateDeps(pool: Pick<Pool, 'query'>, env: (k: string) => string | undefined, hosts?: HostFailures): CandidateDeps {
  return {
    readFeed: (url) => readFeed(url, new Date()),
    page: (url) => safeGet(url, {}),
    api: async (name) => {
      const a = API_ADAPTERS[name as ApiSourceName];
      if (!a) throw new Error(`unknown fetch_api source "${name}"`);
      return (await a.fetch(a.params.parse({}), makeAdapterContext({ env }))).items.length;
    },
    dataset: async (key) => {
      const { rows } = await pool.query(
        `SELECT s.status, (SELECT count(*) FROM data_items i WHERE i.schema_id = s.id AND i.status = 'active')::int AS n
           FROM data_schemas s WHERE s.key = $1`, [key]);
      return rows[0] ? { active: rows[0].status === 'active', rows: Number(rows[0].n) } : null;
    },
    ...(hosts ? { hosts } : {}),
  };
}

/** A change card for this source waits for the owner, or the owner discarded one this week. */
export function sourceChangeHandled(pool: Pick<Pool, 'query'>) {
  return async (channelKey: string, sourceId: string | null, ref: string | null): Promise<'pending' | 'declined' | null> => {
    const { rows } = await pool.query(
      `SELECT status FROM pending_actions
        WHERE kind = $1 AND payload->>'channelKey' = $2
          AND (($3::text IS NOT NULL AND payload->>'sourceId' = $3) OR ($4::text IS NOT NULL AND payload->'source'->>'ref' = $4))
          AND (status = 'pending' OR (status = 'discarded' AND decided_at > now() - make_interval(days => $5)))
        ORDER BY (status = 'pending') DESC LIMIT 1`,
      [SOURCE_CHANGE_KIND, channelKey, sourceId, ref, DECLINED_DAYS]);
    return rows[0] ? (rows[0].status === 'pending' ? 'pending' : 'declined') : null;
  };
}
