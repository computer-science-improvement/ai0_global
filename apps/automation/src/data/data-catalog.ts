import type { Pool } from 'pg';
import type { DataSchema, FieldDef, RoleName } from './data.types';
import { readableFields } from './data-query';
import { resourceKeys, usedRefsCte } from './data-refs';
import { cycleOrder, isCycle, repeatOf, rollIfDone, roundsOf, type Repeat } from './data-rounds';
import { describePostRequires } from './post-requires';

/**
 * The agents' library catalog (spec 032 FR-010, extends 023 FR-008). Agents read this first and decide
 * from the descriptions and the numbers whether a dataset fits, before fetching any row with `query_data`.
 *
 * Built from `data_schemas` (active datasets only) and `data_schema_stats` (refreshed after each import
 * and nightly): network-wide unposted rows, top categories and per-field fill rate. Two numbers are live
 * because they change during the day: rows unposted on the asking resource, and rows for today's date.
 *
 * Rows that miss what the dataset needs for posting (`post_requires`, migration 083) are never counted as
 * unposted: they are reported as `not_postable`, so an agent is not told there are thousands of usable
 * rows when only a few can be posted.
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
  /** What a row needs before it can be posted, one entry per group ("prompt_text or media_url"). */
  post_requires?:         string[];
  /** Active rows that miss `post_requires`: never offered by query_data, never counted as unposted. */
  not_postable?:          number;
  unposted_network:       number | null;
  unposted_here?:         number;
  /** Spec 071: the dataset repeats in rounds. `round` is the current round on the asking resource. */
  repeat?:                Repeat;
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

/**
 * The reuse rule in words. Also the text an `edit_data_schema` suggestion on the `reuse` target compares with and shows on
 * the dashboard card (old and new), so it is English like the two older branches.
 */
export function reuseText(p: DataSchema['reuse_policy']): string {
  if (isCycle(p)) {
    const by = cycleOrder(p) === 'sequential'
      ? `in order${p.order_by?.length ? ` (by ${p.order_by.join(', ')}, then import order)` : ' (import order)'}`
      : 'in random order';
    return `post each row once per resource in every round, ${by}; when every row has been posted there, a new round starts`;
  }
  return p?.kind === 'after_days' && p.days ? `may be posted again on the same resource after ${p.days} days` : 'post each row once per resource';
}

/** One catalog entry from a schema row and its stats (pure; exported for tests). */
export function catalogEntry(s: DataSchema, st: {
  rows?: number; unposted_network?: number | null; top_categories?: Array<{ category: string; rows: number }>;
  fill_rate?: Record<string, number>; stats_at?: string | null; unposted_here?: number; today_items?: number;
  not_postable?: number; round?: number;
}): CatalogEntry {
  const hasDate = DATE_ROLES.some((r) => s.roles?.[r]);
  // Spec 062 FR-005: once the stats were computed, a field no row carries is 0 % filled — not «unknown» (that left media_url,
  // prompt_text and title without a number, and the model answered a question about the data from the metadata).
  const measured = !!st.stats_at;
  const fields: CatalogField[] = readableFields(s, 'agent').map((f) => {
    const fill = st.fill_rate?.[f.name] ?? (measured ? 0 : undefined);
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
    roles, fields, rows: st.rows ?? 0,
    ...(s.post_requires?.length ? { post_requires: describePostRequires(s.post_requires) } : {}),
    ...(st.not_postable ? { not_postable: st.not_postable } : {}),
    unposted_network: st.unposted_network ?? null,
    ...(st.unposted_here !== undefined ? { unposted_here: st.unposted_here } : {}),
    ...(isCycle(s.reuse_policy) ? { repeat: repeatOf(s, st.round)! } : {}),
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
  not_postable?:  number;
  unposted_here?: number;
  repeat?:        Repeat;
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
    ...(e.not_postable ? { not_postable: e.not_postable } : {}),
    ...(e.unposted_here !== undefined ? { unposted_here: e.unposted_here } : {}),
    ...(e.repeat ? { repeat: e.repeat } : {}),
    unposted_network: e.unposted_network,
    ...(e.today_items !== undefined ? { today_items: e.today_items } : {}),
    top_categories: e.top_categories.slice(0, 3).map((c) => c.category),
  };
}

export async function buildCatalog(pool: Pick<Pool, 'query'>, o: CatalogOptions): Promise<CatalogEntry[]> {
  const { rows: schemas } = await pool.query(
    `SELECT s.id, s.key, s.title, s.description, s.entity, s.version, s.fields, s.roles, s.dedup_key, s.language, s.default_license,
            s.reuse_policy, s.suitable_for, s.contains_personal_data, s.legacy, s.post_requires, s.status,
            st.unposted_network::int AS unposted_network, st.top_categories, st.fill_rate, st.computed_at AS stats_at
       FROM data_schemas s LEFT JOIN data_schema_stats st ON st.schema_id = s.id
      WHERE s.status = 'active' AND ($1::text IS NULL OR s.key = $1)
      ORDER BY s.key`, [o.dataset ?? null]);
  if (!schemas.length) return [];
  const ids = schemas.map((s: any) => s.id);

  // Live counts: active rows, today's rows, rows that cannot be posted and (with a resource) postable rows
  // not yet used there.
  const params: unknown[] = [ids, o.today.month, o.today.day];
  let cte = '';
  let here = 'NULL::int';
  if (o.resource) {
    const { resourceRef } = resourceKeys(o.resource);
    params.push(resourceRef);
    cte = `WITH ${usedRefsCte('$4')} `;
    here = `count(*) FILTER (WHERE data_postable(s.post_requires, d.data)
              AND NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = 'data://' || s.key || '/' || d.id::text)
              AND (d.legacy_ref IS NULL OR NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = d.legacy_ref)))::int`;
  }
  const countRows = async () => {
    const { rows: counts } = await pool.query(
      `${cte}SELECT d.schema_id, count(*)::int AS rows,
              count(*) FILTER (WHERE d.event_month = $2 AND d.event_day = $3)::int AS today_items,
              count(*) FILTER (WHERE NOT data_postable(s.post_requires, d.data))::int AS not_postable,
              ${here} AS unposted_here
         FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
        WHERE d.schema_id = ANY($1::uuid[]) AND d.status = 'active'
        GROUP BY d.schema_id`, params);
    return new Map<string, any>(counts.map((c: any) => [c.schema_id, c]));
  };
  let bySchema = await countRows();

  // Spec 071: rounds. A cycle dataset with postable rows and none left here has finished its round: ask the database to
  // start the next one (it checks the rule itself, under a lock) and count again. Runs only on zero, so it is cheap.
  const resource = o.resource ?? null;
  const cycleIds = schemas.filter((s: any) => isCycle(s.reuse_policy)).map((s: any) => s.id as string);
  let rounds: Awaited<ReturnType<typeof roundsOf>> | null = null;
  if (resource && cycleIds.length) {
    let rolled = false;
    for (const id of cycleIds) {
      const c = bySchema.get(id);
      if (c && (c.unposted_here ?? 0) === 0 && c.rows - (c.not_postable ?? 0) > 0) rolled = (await rollIfDone(pool, id, resource)) || rolled;
    }
    if (rolled) bySchema = await countRows();
    rounds = await roundsOf(pool, cycleIds, resource);
  }

  return schemas.map((s: any) => {
    const c: any = bySchema.get(s.id) ?? { rows: 0, today_items: 0, unposted_here: o.resource ? 0 : null };
    return catalogEntry(s as DataSchema, {
      rows: c.rows, today_items: c.today_items, unposted_here: o.resource ? (c.unposted_here ?? 0) : undefined,
      not_postable: c.not_postable ?? 0, round: rounds?.get(s.id)?.round,
      unposted_network: s.unposted_network, top_categories: s.top_categories ?? [], fill_rate: s.fill_rate ?? {},
      stats_at: s.stats_at ? new Date(s.stats_at).toISOString() : null,
    });
  });
}
