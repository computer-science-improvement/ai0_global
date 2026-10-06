import type { Pool } from 'pg';

/**
 * Content refs (spec 032 FR-011). The canonical ref of a data store row is `data://<schema_key>/<id>`
 * (the `data_items.id`). Rows moved from the 12 legacy content tables also keep their old
 * `library://<table>/<old id>` ref in `data_items.legacy_ref`; both refs name the same row, so dedup and
 * history must treat them as aliases.
 *
 * "Used on a resource" comes from the content ledger (spec 023 FR-010, migration 060, `content-ledger.ts`):
 * every publish path records into `content_ledger`, and `content_ledger_used()` applies its rules (error
 * everywhere, published per the dataset's reuse policy, shadowed for 7 days). Posts that wait for the owner
 * (spec 031) are not in the ledger yet, so `usedRefsCte()` adds them.
 */

export const DATA_REF_RE = /^data:\/\/([a-z][a-z0-9_]{1,62})\/(\d{1,18})$/;
export const LIBRARY_REF_RE = /^library:\/\/([a-z_]+)\/([A-Za-z0-9_.:-]{1,200})$/;
/** Either form, for PostSpec / platform spec validation. */
export const CONTENT_REF_RE = /^(library:\/\/[a-z_]+\/[A-Za-z0-9_.:-]{1,200}|data:\/\/[a-z][a-z0-9_]{1,62}\/\d{1,18})$/;

export function dataRef(schemaKey: string, id: string | number): string {
  return `data://${schemaKey}/${id}`;
}

export function parseDataRef(ref: string | null | undefined): { schemaKey: string; id: string } | null {
  const m = ref?.match(DATA_REF_RE);
  return m ? { schemaKey: m[1], id: m[2] } : null;
}

export function isContentRef(ref: string | null | undefined): boolean {
  return !!ref && (DATA_REF_RE.test(ref) || LIBRARY_REF_RE.test(ref));
}

export interface ResolvedRef {
  schemaKey: string;
  itemId:    string;
  dataRef:   string;
  legacyRef: string | null;
  /** The legacy table and old id, when the row was moved from a content table. */
  legacy:    { table: string; id: string } | null;
}

type Q = Pick<Pool, 'query'>;

/** The store row behind a `data://` or `library://` ref; null when the ref is not a content ref or the row is gone. */
export async function resolveContentRef(pool: Q, ref: string | null | undefined): Promise<ResolvedRef | null> {
  if (!ref) return null;
  const d = parseDataRef(ref);
  let rows: any[] = [];
  if (d) {
    ({ rows } = await pool.query(
      `SELECT s.key, d.id::text AS id, d.legacy_ref FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
        WHERE s.key = $1 AND d.id = $2::bigint`, [d.schemaKey, d.id]));
  } else if (LIBRARY_REF_RE.test(ref)) {
    ({ rows } = await pool.query(
      `SELECT s.key, d.id::text AS id, d.legacy_ref FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
        WHERE d.legacy_ref = $1`, [ref]));
  } else {
    return null;
  }
  const r = rows[0];
  if (!r) return null;
  const lm = typeof r.legacy_ref === 'string' ? r.legacy_ref.match(LIBRARY_REF_RE) : null;
  return {
    schemaKey: r.key, itemId: String(r.id), dataRef: dataRef(r.key, r.id), legacyRef: r.legacy_ref ?? null,
    legacy: lm ? { table: lm[1], id: lm[2] } : null,
  };
}

/**
 * Every ref that names the same content row: `[ref]` plus its alias (`data://` ⇄ `library://`). Non-content
 * refs (a source URL) come back as `[ref]` without a query.
 */
export async function refAliases(pool: Q, ref: string): Promise<string[]> {
  if (!isContentRef(ref)) return [ref];
  const r = await resolveContentRef(pool, ref);
  if (!r) return [ref];
  return [...new Set([ref, r.dataRef, ...(r.legacyRef ? [r.legacyRef] : [])])];
}

/** A resource ref (`telegram:@x`, `instagram:123`) or a bare Telegram channel key (`@x`) → both forms. */
export function resourceKeys(ref: string): { channelKey: string; resourceRef: string } {
  const t = ref.trim();
  if (t.startsWith('telegram:')) return { channelKey: t.slice('telegram:'.length), resourceRef: t };
  if (t.includes(':')) return { channelKey: t, resourceRef: t };
  return { channelKey: t, resourceRef: `telegram:${t}` };
}

/**
 * SQL for a CTE `used(ref)`: every content ref the ledger stops on one resource, plus the refs of posts
 * that wait for approval or are approved there. `rr` is the parameter placeholder of the resource ref.
 * Ledger refs are canonical (`data://`); waiting refs are as the agent wrote them, so callers match a row
 * by its `data://` ref and by its `legacy_ref`.
 */
export function usedRefsCte(rr: string): string {
  return `used AS (
    SELECT ref FROM content_ledger_used(${rr})
    UNION
    SELECT x.ref FROM editor_slots s
     CROSS JOIN LATERAL (VALUES (s.post_spec->>'library_ref'), (s.platform_spec->>'library_ref')) x(ref)
     WHERE COALESCE(s.resource_ref, 'telegram:' || s.channel_key) = ${rr}
       AND s.status IN ('awaiting_approval','approved') AND x.ref IS NOT NULL
    UNION
    SELECT source_ref FROM platform_posts
     WHERE resource_ref = ${rr} AND status = 'awaiting_approval' AND source_ref IS NOT NULL
  )`;
}
