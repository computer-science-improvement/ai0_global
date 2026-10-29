import type { Pool } from 'pg';
import { buildCatalog } from '../../data/data-catalog';
import { DataStore } from '../../data/data-store';
import { kyivMonthDay, nextInRound } from '../../data/data-query';

/**
 * Spec 071 FR-005: `ScheduleServiceDeps.nextRow` — the next row (`data://<dataset>/<id>`) of a dataset that goes in order
 * (`reuse_policy` cycle / sequential), on a resource, optionally within one category. The executor's series note names it,
 * and `publishGuard` refuses another row of the series' dataset (`not_next_in_order`). Null for every other dataset (so
 * `never` / `after_days` and random-round datasets are untouched), for a dataset that is not active, and when nothing is
 * left; a cycle dataset with nothing left first rolls to the next round (data-query `nextInRound`).
 */
export function nextRowPort(pool: Pick<Pool, 'query'>, today: () => { month: number; day: number } = kyivMonthDay) {
  return async (resourceRef: string, dataset: string, category: string | null, o: { roll?: boolean } = {}): Promise<string | null> => {
    const s = await new DataStore(pool).getSchema(dataset);
    if (!s || s.status !== 'active') return null;
    return (await nextInRound(pool, s, resourceRef, today(), category, o)).ref;
  };
}

/**
 * `ScheduleServiceDeps.unposted`: the postable rows of a dataset not yet used on a resource. A cycle dataset with nothing left
 * first starts its next round (the run needs rows). Spec 073 I1: `o.roll: false` is the read-only count of the config check; it
 * writes nothing, and a cycle dataset whose round is done but that still has postable rows reads as «unknown» (null), because
 * the run will roll it: only a dataset with no postable row at all reads as empty.
 */
export function unpostedPort(pool: Pick<Pool, 'query'>, today: () => { month: number; day: number } = kyivMonthDay) {
  return async (resourceRef: string, dataset: string, o: { roll?: boolean } = {}): Promise<number | null> => {
    const e = (await buildCatalog(pool, { dataset, resource: resourceRef, today: today(), roll: o.roll }))[0];
    if (!e) return null;
    const left = e.unposted_here ?? null;
    if (o.roll === false && left === 0 && e.repeat && e.rows - (e.not_postable ?? 0) > 0) return null;
    return left;
  };
}
