import type { Pool } from 'pg';
import { DataStoreError } from './data-store';
import type { DataSchema } from './data.types';
import { ledgerResource } from './content-ledger';
import { cycleOrder, isCycle, isSequential, roundOrderSql } from './data-rounds';

/**
 * Rounds of a repeating dataset for the owner (spec 071 FR-008): where each resource is in its round, and a way to start
 * the next round by hand. The agents never use this file — they read through `queryDataset` and the SQL roll; this is the
 * dashboard's view and the owner's one lever.
 *
 * "Done" and "open" follow `data_round_roll` (migration 096) exactly, so the panel and the roll never disagree:
 *   done    — an active, postable row with a published or passed ledger row on the resource after the round started;
 *   waiting — not done, but a post that waits for the owner on the resource holds it;
 *   open    — neither (and no error row); the round rolls when nothing is open and something was done.
 */

export interface RoundState {
  resource_ref: string;
  round:        number;
  /** null = round 1 that never rolled (it has no start). */
  started_at:   string | null;
  total:        number;
  done:         number;
  waiting:      number;
  open:         number;
  /** The row an in-order dataset takes next on this resource; null for a random dataset or when nothing is open. */
  next:         string | null;
}

export interface DatasetRounds {
  key:      string;
  order:    'sequential' | 'random';
  order_by: string[];
  resources: RoundState[];
}

type Q = Pick<Pool, 'query'>;

/** The ledger refs of a resource's waiting posts, in canonical form (as in `data_round_roll`). */
const HELD_SQL = `
  SELECT COALESCE(array_agg(DISTINCT content_ref_canonical(h.ref)), '{}') AS refs FROM (
    SELECT unnest(ARRAY[sl.post_spec->>'library_ref', sl.platform_spec->>'library_ref']) AS ref
      FROM editor_slots sl
     WHERE sl.status IN ('awaiting_approval', 'approved') AND COALESCE(sl.resource_ref, 'telegram:' || sl.channel_key) = $1
    UNION ALL
    SELECT pp.source_ref FROM platform_posts pp WHERE pp.resource_ref = $1 AND pp.status = 'awaiting_approval'
  ) h WHERE h.ref IS NOT NULL`;

/** Every resource that has a round row or a published / passed row of the dataset (the `:*` and `*` scopes are not resources). */
const RESOURCES_SQL = `
  SELECT resource_ref FROM data_reuse_rounds WHERE schema_id = $1
  UNION
  SELECT l.resource_ref FROM content_ledger l
   WHERE l.status IN ('published', 'passed') AND left(l.source_ref, 7) = 'data://'
     AND split_part(substr(l.source_ref, 8), '/', 1) = $2
  UNION
  SELECT l.resource_ref FROM content_ledger l JOIN data_items d ON d.legacy_ref = l.source_ref
   WHERE d.schema_id = $1 AND l.status IN ('published', 'passed')`;

const realResource = (r: unknown): r is string => typeof r === 'string' && r !== '' && r !== '*' && !r.endsWith(':*');

async function knownResources(pool: Q, schema: DataSchema): Promise<string[]> {
  const { rows } = await pool.query(RESOURCES_SQL, [schema.id, schema.key]);
  return rows.map((r) => r.resource_ref).filter(realResource).sort();
}

async function stateOf(pool: Q, schema: DataSchema, resource: string, order: string, sequential: boolean): Promise<RoundState> {
  const round = (await pool.query(`SELECT round, started_at FROM data_reuse_rounds WHERE schema_id = $1 AND resource_ref = $2`, [schema.id, resource])).rows[0];
  const held = (await pool.query(HELD_SQL, [resource])).rows[0]?.refs ?? [];
  const since: Date | null = round?.started_at ? new Date(round.started_at) : null;
  const requires = JSON.stringify(schema.post_requires ?? []);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE f.done)::int AS done,
            count(*) FILTER (WHERE NOT f.done AND NOT f.failed AND f.waiting)::int AS waiting,
            count(*) FILTER (WHERE NOT f.done AND NOT f.failed AND NOT f.waiting)::int AS open,
            ${sequential
              ? `(array_agg('data://' || $2::text || '/' || d.id ORDER BY ${order}) FILTER (WHERE NOT f.done AND NOT f.failed AND NOT f.waiting))[1]`
              : `NULL::text`} AS next
       FROM data_items d
      CROSS JOIN LATERAL (SELECT
          EXISTS (SELECT 1 FROM content_ledger l
                   WHERE l.source_ref IN ('data://' || $2::text || '/' || d.id, d.legacy_ref) AND l.resource_ref = $3
                     AND l.status IN ('published', 'passed')
                     AND COALESCE(l.used_at > (SELECT r.started_at FROM data_reuse_rounds r WHERE r.schema_id = $1 AND r.resource_ref = $3), true)) AS done,
          EXISTS (SELECT 1 FROM content_ledger l
                   WHERE l.source_ref IN ('data://' || $2::text || '/' || d.id, d.legacy_ref) AND l.status = 'error') AS failed,
          ('data://' || $2::text || '/' || d.id) = ANY ($4::text[]) AS waiting) f
      WHERE d.schema_id = $1 AND d.status = 'active' AND data_postable($5::jsonb, d.data)`,
    [schema.id, schema.key, resource, held, requires]);
  const r = rows[0];
  return {
    resource_ref: resource,
    round:        round ? Number(round.round) : 1,
    started_at:   since ? since.toISOString() : null,
    total:        r.total, done: r.done, waiting: r.waiting, open: r.open,
    next:         r.next ?? null,
  };
}

/** The rounds of a cycle dataset, one entry per resource that posted from it. */
export async function roundStates(pool: Q, schema: DataSchema): Promise<DatasetRounds> {
  const p = schema.reuse_policy;
  if (!isCycle(p)) throw new DataStoreError('invalid', `dataset "${schema.key}" does not repeat in rounds`);
  const order = roundOrderSql(p, schema.fields);
  const resources: RoundState[] = [];
  for (const res of await knownResources(pool, schema)) resources.push(await stateOf(pool, schema, res, order, isSequential(p)));
  return { key: schema.key, order: cycleOrder(p), order_by: isSequential(p) ? (p.order_by ?? []) : [], resources };
}

/**
 * Start the next round on one resource now, whatever is left in the current one. The same advisory lock as
 * `data_round_roll` serialises it with a roll that a post triggers; the new round starts at clock_timestamp() so a row
 * posted in the same transaction clock tick is not counted as done in it. Only a resource that has posted from the dataset
 * (or has a round row) can be restarted — a typo must not leave a junk round row behind.
 */
export async function restartRound(pool: Pool, schema: DataSchema, resourceRef: string): Promise<RoundState> {
  const p = schema.reuse_policy;
  if (!isCycle(p)) throw new DataStoreError('invalid', `dataset "${schema.key}" does not repeat in rounds`);
  const resource = ledgerResource(String(resourceRef ?? '').trim());
  if (!realResource(resource)) throw new DataStoreError('invalid', 'resource_ref must name one channel or page');
  if (!(await knownResources(pool, schema)).includes(resource)) {
    throw new DataStoreError('not_found', `"${resource}" has not posted from dataset "${schema.key}"`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('data_round:' || $1::text || ':' || $2::text, 0))`, [schema.id, resource]);
    await client.query(
      `INSERT INTO data_reuse_rounds AS r (schema_id, resource_ref, round, started_at)
       VALUES ($1, $2, 2, clock_timestamp())
       ON CONFLICT (schema_id, resource_ref) DO UPDATE SET round = r.round + 1, started_at = EXCLUDED.started_at, updated_at = now()`,
      [schema.id, resource]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return stateOf(pool, schema, resource, roundOrderSql(p, schema.fields), isSequential(p));
}
