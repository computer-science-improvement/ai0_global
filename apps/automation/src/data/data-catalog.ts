import type { Pool } from 'pg';
import type { DataSchema, FieldDef, RoleName } from './data.types';
import { readableFields } from './data-query';
import { resourceKeys, usedRefsCte } from './data-refs';

/**
 * The agents' library catalog (spec 032 FR-010, extends 023 FR-008). Agents read this first and decide
 * from the descriptions and the numbers whether a dataset fits, before fetching any row with `query_data`.
 *
 * Built from `data_schemas` (active datasets only) and `data_schema_stats` (refreshed after each import
 * and nightly): network-wide unposted rows, top categories and per-field fill rate. Two numbers are live
 * because they change during the day: rows unposted on the asking resource, and rows for today's date.
 */

export interface CatalogField {
  name:         string;
  type:         FieldDef['type'];
  description:  string;
  filterable?:  true;
  searchable?:  true;
  values?:      string[];
  example?:     unknown;
  /** Share of active rows with a value, 0–100. */
  fill_pct?:    number;
}

export interface CatalogEntry {
  dataset:                string;
  title:                  string;
  entity:                 string;
  description:            string;
  suitable_for:           string;
  language:               string | null;
  license:                string;
  reuse:                  string;
  contains_personal_data: boolean;
  roles:                  Partial<Record<RoleName, string | string[]>>;
  fields:                 CatalogField[];
  rows:                   number;
  unposted_network:       number | null;
  unposted_here?:         number;
  today_items?:           number;
  top_categories:         Array<{ category: string; rows: number }>;
  stats_at:               string | null;
}

export interface CatalogOptions {
  /** Only this dataset. */
  dataset?:    string;
  /** Resource ref or Telegram channel key: adds `unposted_here`. */
  resource?:   string | null;
  today:       { month: number; day: number };
}

const DATE_ROLES: RoleName[] = ['date', 'month_day', 'month', 'day'];
const clipExample = (v: unknown) => (typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v);

function reuseText(p: DataSchema['reuse_policy']): string {
  return p?.kind === 'after_days' && p.days ? `may be posted again on the same resource after ${p.days} days` : 'post each row once per resource';
}

/** One catalog entry from a schema row and its stats (pure; exported for tests). */
export function catalogEntry(s: DataSchema, st: {
  rows?: number; unposted_network?: number | null; top_categories?: Array<{ category: string; rows: number }>;
  fill_rate?: Record<string, number>; stats_at?: string | null; unposted_here?: number; today_items?: number;
}): CatalogEntry {
  const hasDate = DATE_ROLES.some((r) => s.roles?.[r]);
  const fields: CatalogField[] = readableFields(s, 'agent').map((f) => {
    const fill = st.fill_rate?.[f.name];
    return {
      name: f.name, type: f.type, description: f.description,
      ...(f.filterable ? { filterable: true as const } : {}),
      ...(f.searchable ? { searchable: true as const } : {}),
      ...(f.enum?.length ? { values: f.enum.slice(0, 20) } : {}),
      ...(f.example !== undefined && f.example !== null && f.example !== '' ? { example: clipExample(f.example) } : {}),
      ...(typeof fill === 'number' ? { fill_pct: Math.round(Number(fill) * 100) } : {}),
    };
  });
  const visible = new Set(fields.map((f) => f.name));
  const roles = Object.fromEntries(Object.entries(s.roles ?? {}).filter(([, v]) => (Array.isArray(v) ? v : [v]).some((n) => n && visible.has(n))));
  return {
    dataset: s.key, title: s.title, entity: s.entity, description: s.description, suitable_for: s.suitable_for,
    language: s.language, license: s.default_license, reuse: reuseText(s.reuse_policy), contains_personal_data: s.contains_personal_data,
    roles, fields, rows: st.rows ?? 0, unposted_network: st.unposted_network ?? null,
    ...(st.unposted_here !== undefined ? { unposted_here: st.unposted_here } : {}),
    ...(hasDate ? { today_items: st.today_items ?? 0 } : {}),
    top_categories: (st.top_categories ?? []).slice(0, 5), stats_at: st.stats_at ?? null,
  };
}

/** The overview line of a dataset (no args): enough to choose; field details come with `dataset`. */
export interface CatalogSummary {
  dataset:        string;
  title:          string;
  entity:         string;
  description:    string;
  suitable_for:   string;
  language:       string | null;
  personal_data?: true;
  fields:         string[];
  rows:           number;
  unposted_here?: number;
  unposted_network: number | null;
  today_items?:   number;
  top_categories: string[];
}

const cut = (s: string, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

export function summarize(e: CatalogEntry): CatalogSummary {
  return {
    dataset: e.dataset, title: e.title, entity: e.entity, description: cut(e.description, 240), suitable_for: cut(e.suitable_for, 160),
    language: e.language, ...(e.contains_personal_data ? { personal_data: true as const } : {}),
    fields: e.fields.map((f) => f.name), rows: e.rows,
    ...(e.unposted_here !== undefined ? { unposted_here: e.unposted_here } : {}),
    unposted_network: e.unposted_network,
    ...(e.today_items !== undefined ? { today_items: e.today_items } : {}),
    top_categories: e.top_categories.slice(0, 3).map((c) => c.category),
  };
}

export async function buildCatalog(pool: Pick<Pool, 'query'>, o: CatalogOptions): Promise<CatalogEntry[]> {
  const { rows: schemas } = await pool.query(
    `SELECT s.id, s.key, s.title, s.description, s.entity, s.version, s.fields, s.roles, s.dedup_key, s.language, s.default_license,
            s.reuse_policy, s.suitable_for, s.contains_personal_data, s.legacy, s.status,
            st.unposted_network::int AS unposted_network, st.top_categories, st.fill_rate, st.computed_at AS stats_at
       FROM data_schemas s LEFT JOIN data_schema_stats st ON st.schema_id = s.id
      WHERE s.status = 'active' AND ($1::text IS NULL OR s.key = $1)
      ORDER BY s.key`, [o.dataset ?? null]);
  if (!schemas.length) return [];
  const ids = schemas.map((s: any) => s.id);

  // Live counts: active rows, today's rows and (with a resource) rows not yet used there.
  const params: unknown[] = [ids, o.today.month, o.today.day];
  let cte = '';
  let here = 'NULL::int';
  if (o.resource) {
    const { resourceRef } = resourceKeys(o.resource);
    params.push(resourceRef);
    cte = `WITH ${usedRefsCte('$4')} `;
    here = `count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = 'data://' || s.key || '/' || d.id::text)
              AND (d.legacy_ref IS NULL OR NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = d.legacy_ref)))::int`;
  }
  const { rows: counts } = await pool.query(
    `${cte}SELECT d.schema_id, count(*)::int AS rows,
            count(*) FILTER (WHERE d.event_month = $2 AND d.event_day = $3)::int AS today_items,
            ${here} AS unposted_here
       FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE d.schema_id = ANY($1::uuid[]) AND d.status = 'active'
      GROUP BY d.schema_id`, params);
  const bySchema = new Map(counts.map((c: any) => [c.schema_id, c]));

  return schemas.map((s: any) => {
    const c: any = bySchema.get(s.id) ?? { rows: 0, today_items: 0, unposted_here: o.resource ? 0 : null };
    return catalogEntry(s as DataSchema, {
      rows: c.rows, today_items: c.today_items, unposted_here: o.resource ? (c.unposted_here ?? 0) : undefined,
      unposted_network: s.unposted_network, top_categories: s.top_categories ?? [], fill_rate: s.fill_rate ?? {},
      stats_at: s.stats_at ? new Date(s.stats_at).toISOString() : null,
    });
  });
}
