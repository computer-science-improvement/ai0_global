import type { Pool } from 'pg';
import { FIELD_NAME_RE, ORDERABLE_TYPES, type DataSchema, type FieldDef, type ReusePolicy } from './data.types';
import { resolveContentRef, resourceKeys } from './data-refs';

/**
 * Datasets that repeat in rounds (spec 071, migration 096). A cycle dataset posts every row once per round on each
 * resource; when the resource has used them all, `data_round_roll()` starts the next round. The rules live in SQL
 * (`content_ledger_blocks` with the round start of the ledger row's resource, `data_round_roll`, two triggers); this file
 * holds what the TypeScript side needs:
 *   • the policy helpers and the ORDER BY of a round (sequential: `order_by` fields, then import order);
 *   • the lazy roll — a read that finds nothing left asks the database to roll, then reads again;
 *   • the rounds of a dataset per resource.
 * Code that may run before 096 is applied touches `data_reuse_rounds` / `data_round_roll` only for cycle datasets, and the
 * old CHECK forbids those.
 */

export type CyclePolicy = Extract<ReusePolicy, { kind: 'cycle' }>;

export const isCycle = (p: ReusePolicy | null | undefined): p is CyclePolicy => p?.kind === 'cycle';
/** `{kind:'cycle'}` with no order (written by SQL) is random. */
export const cycleOrder = (p: CyclePolicy): 'sequential' | 'random' => (p.order === 'sequential' ? 'sequential' : 'random');
export const isSequential = (p: ReusePolicy | null | undefined): p is CyclePolicy => isCycle(p) && cycleOrder(p) === 'sequential';

/** In random mode, a row published on the resource within this many days goes last (the last row of round k is not the first of round k+1). */
export const RECENT_TAIL_DAYS = 7;

const NUMERIC_TYPES: ReadonlySet<FieldDef['type']> = new Set(['int', 'number']);

/**
 * The ORDER BY of a sequential round (no `ORDER BY` keyword): `order_by` fields typed like the filter SQL — numbers through
 * a jsonb_typeof guard, blank text as missing, NULLS LAST — then import order (`d.id`). A name that is no longer an orderable
 * field is left out (fields are never removed or retyped, and the owner's edit was checked when it was saved); names reach
 * SQL only through FIELD_NAME_RE.
 */
export function roundOrderSql(policy: CyclePolicy, fields: Pick<FieldDef, 'name' | 'type'>[]): string {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const parts: string[] = [];
  for (const name of policy.order_by ?? []) {
    const f = byName.get(name);
    if (!f || !FIELD_NAME_RE.test(name) || !ORDERABLE_TYPES.includes(f.type)) continue;
    const col = `d.data->'${name}'`;
    const txt = `d.data->>'${name}'`;
    parts.push(NUMERIC_TYPES.has(f.type)
      ? `(CASE WHEN jsonb_typeof(${col}) = 'number' THEN (${txt})::numeric END) ASC NULLS LAST`
      : `NULLIF(${txt}, '') ASC NULLS LAST`);
  }
  parts.push('d.id ASC');
  return parts.join(', ');
}

/**
 * The random tail of a round: SQL that is true for a row published on the resource in the last RECENT_TAIL_DAYS days.
 * `rr` and `key` are placeholders the query already uses (the resource ref and the dataset key), so the count query that
 * drops the ORDER BY keeps every parameter in use.
 */
export function recentTailSql(rr: string, key: string): string {
  return `EXISTS (SELECT 1 FROM content_ledger lt WHERE lt.resource_ref = ${rr} AND lt.status = 'published'
            AND lt.used_at > now() - interval '${RECENT_TAIL_DAYS} days'
            AND lt.source_ref IN ('data://' || ${key} || '/' || d.id::text, d.legacy_ref))`;
}

type Q = Pick<Pool, 'query'>;

/** Ask the database to start the next round when nothing is open on the resource. True when a round started. */
export async function rollIfDone(pool: Q, schemaId: string, resourceRef: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT data_round_roll($1::uuid, $2) AS rolled`, [schemaId, resourceKeys(resourceRef).resourceRef]);
  return rows[0]?.rolled === true;
}

export interface RoundNo { round: number; started_at: Date | null }

/** The current round of cycle datasets on a resource (no row = round 1 with no start). */
export async function roundsOf(pool: Q, schemaIds: string[], resourceRef: string): Promise<Map<string, RoundNo>> {
  const out = new Map<string, RoundNo>();
  if (!schemaIds.length) return out;
  const { rows } = await pool.query(
    `SELECT schema_id, round, started_at FROM data_reuse_rounds WHERE schema_id = ANY($1::uuid[]) AND resource_ref = $2`,
    [schemaIds, resourceKeys(resourceRef).resourceRef]);
  for (const r of rows) out.set(r.schema_id, { round: Number(r.round), started_at: r.started_at ? new Date(r.started_at) : null });
  for (const id of schemaIds) if (!out.has(id)) out.set(id, { round: 1, started_at: null });
  return out;
}

/**
 * Does a `data://` / `library://` ref name a row of a cycle dataset? A post that cites a source URL beside such a ref is
 * not refused for that URL being used in an earlier round: the library row is the material and the URL is a citation
 * (spec 071 A7). False for any other ref, a missing row and a database error.
 */
export async function isCycleRef(pool: Q, ref: string | null | undefined): Promise<boolean> {
  if (!ref) return false;
  try {
    const r = await resolveContentRef(pool, ref);
    if (!r) return false;
    const { rows } = await pool.query(`SELECT reuse_policy->>'kind' AS kind FROM data_schemas WHERE key = $1`, [r.schemaKey]);
    return rows[0]?.kind === 'cycle';
  } catch {
    return false;
  }
}

/** The `repeat` block an agent sees for a cycle dataset: the order, the order-by fields, and the round (only when the resource is known). */
export interface Repeat { order: 'sequential' | 'random'; order_by?: string[]; round?: number }

export function repeatOf(s: Pick<DataSchema, 'reuse_policy'>, round?: number): Repeat | undefined {
  const p = s.reuse_policy;
  if (!isCycle(p)) return undefined;
  return {
    order: cycleOrder(p),
    ...(isSequential(p) && p.order_by?.length ? { order_by: p.order_by } : {}),
    ...(round !== undefined ? { round } : {}),
  };
}

/** The same in words (agents' language), for the summary line and the query note: «по черзі» / «випадково». */
export const orderWord = (r: Pick<Repeat, 'order'>): string => (r.order === 'sequential' ? 'по черзі' : 'випадково');
