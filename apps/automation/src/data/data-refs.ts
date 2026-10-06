import type { Pool } from 'pg';

/**
 * Content refs (spec 032 FR-011). The canonical ref of a data store row is `data://<schema_key>/<id>`
 * (the `data_items.id`). Rows moved from the 12 legacy content tables also keep their old
 * `library://<table>/<old id>` ref in `data_items.legacy_ref`; both refs name the same row, so dedup and
 * history must treat them as aliases.
 *
 * Extension point (spec 023 FR-010): until the content ledger exists, "posted" means one of
 *   • a `data_items.posted` marker keyed by the channel (legacy strategies), or
 *   • a `published_posts.source_url` / waiting `editor_slots.post_spec.library_ref` (Telegram agents), or
 *   • a `platform_posts.source_ref` (other platforms).
 * `usedRefsCte()` is the single place that lists those sources; the ledger replaces it.
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
 * SQL for a CTE `used(ref)`: every content ref already published (or waiting / approved / shadowed) on one
 * resource. `$ck` and `$rr` are the parameter placeholders of the channel key and the resource ref.
 * The `data_items.posted` markers are checked per row by the caller (`NOT (d.posted ? $ck)`).
 */
export function usedRefsCte(ck: string, rr: string): string {
  return `used AS (
    SELECT source_url AS ref FROM published_posts WHERE channel_id = ${ck} AND source_url IS NOT NULL
    UNION
    SELECT post_spec->>'library_ref' FROM editor_slots
     WHERE channel_key = ${ck} AND status IN ('shadowed','awaiting_approval','approved') AND post_spec->>'library_ref' IS NOT NULL
    UNION
    SELECT source_ref FROM platform_posts
     WHERE resource_ref = ${rr} AND status IN ('published','awaiting_approval') AND source_ref IS NOT NULL
  )`;
}
