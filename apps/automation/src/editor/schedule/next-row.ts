import type { Pool } from 'pg';
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
  return async (resourceRef: string, dataset: string, category: string | null): Promise<string | null> => {
    const s = await new DataStore(pool).getSchema(dataset);
    if (!s || s.status !== 'active') return null;
    return (await nextInRound(pool, s, resourceRef, today(), category)).ref;
  };
}
