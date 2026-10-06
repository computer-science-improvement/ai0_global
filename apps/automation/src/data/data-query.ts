import type { Pool } from 'pg';
import { z } from 'zod';
import type { DataSchema, FieldDef, FieldType, RoleName } from './data.types';
import { FIELD_NAME_RE } from './data.types';
import { dataRef, resourceKeys, usedRefsCte } from './data-refs';

/**
 * Reading a dataset (spec 032 FR-007 items browser, FR-010 `query_data`). One query builder for the
 * agents and the dashboard, so both see the same filters:
 *
 *   • fields are validated against the schema (agents: only `agent_visible`, non-deprecated fields);
 *   • filters only on `filterable` fields, with an operator that fits the field type;
 *   • `unposted_on` drops rows already used on a resource (see `usedRefsCte` for what "used" means);
 *   • long text is cut to 2000 characters unless the caller asks for `full`.
 *
 * Field names never reach SQL unvalidated: they must exist in the schema and match the snake_case rule.
 */

export const FILTER_OPS = ['eq', 'in', 'ilike', 'gte', 'lte', 'between', 'is_null', 'today'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const filterSchema = z.object({
  field: z.string().min(1).max(63),
  op:    z.enum(FILTER_OPS),
  value: z.unknown().optional().describe('eq/ilike/gte/lte: one value; in: a list (≤ 50); between: [from, to]; is_null: true (default) or false; today: nothing'),
});
export type DataFilter = z.infer<typeof filterSchema>;

export const ORDERS = ['random', 'newest', 'oldest'] as const;
export type QueryOrder = (typeof ORDERS)[number];

export const MAX_TEXT = 2000;
export const MAX_AGENT_LIMIT = 20;

export class DataQueryError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface QueryOptions {
  audience:    'agent' | 'owner';
  /** Fields to return (agent); undefined = every visible field. */
  fields?:     string[];
  filters?:    DataFilter[];
  /** Full-text search over the title/body envelope and `searchable` fields. */
  search?:     string;
  /** Resource ref or Telegram channel key: drop rows already used there. */
  unpostedOn?: string | null;
  order?:      QueryOrder;
  limit:       number;
  offset?:     number;
  status?:     'active' | 'hidden' | 'all';
  /** Return long text uncut. */
  full?:       boolean;
  today:       { month: number; day: number };
  withTotal?:  boolean;
  /** Internal (search_library wrapper): envelope category ILIKE, envelope "today", owner body length. */
  categoryLike?: string;
  todayOnly?:    boolean;
  bodyChars?:    number;
}

export interface QueryResult {
  rows:   Array<Record<string, unknown>>;
  total?: number;
  /** Fields that were cut to MAX_TEXT characters in at least one row. */
  truncated: string[];
}

const TEXT_TYPES: ReadonlySet<FieldType> = new Set(['text', 'long_text', 'url', 'image_url', 'enum', 'text_list']);
const RANGE_TYPES: ReadonlySet<FieldType> = new Set(['int', 'number', 'date', 'datetime', 'month_day']);
const DATE_TYPES: ReadonlySet<FieldType> = new Set(['date', 'datetime', 'month_day']);
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;

const lit = (name: string) => {
  if (!FIELD_NAME_RE.test(name)) throw new DataQueryError('unknown_field', `unknown field "${name}"`);
  return `'${name}'`;
};

function roleFields(schema: Pick<DataSchema, 'roles'>, role: RoleName): string[] {
  const v = schema.roles?.[role];
  return Array.isArray(v) ? v : v ? [v] : [];
}

/** Fields an audience may read. */
export function readableFields(schema: Pick<DataSchema, 'fields'>, audience: 'agent' | 'owner'): FieldDef[] {
  return schema.fields.filter((f) => audience === 'owner' || (f.agent_visible !== false && !f.deprecated));
}

function coerce(f: FieldDef, v: unknown, op: FilterOp): unknown {
  const bad = (what: string): never => { throw new DataQueryError('invalid_value', `${op} on "${f.name}" (${f.type}) needs ${what}`); };
  if (v === undefined || v === null) bad('a value');
  switch (f.type) {
    case 'int': case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN;
      if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) bad(f.type === 'int' ? 'an integer' : 'a number');
      return n;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      return bad('true or false');
    case 'date':
      if (typeof v === 'string' && DATE_RE.test(v)) return v;
      return bad('a date YYYY-MM-DD');
    case 'datetime':
      if (typeof v === 'string' && DATETIME_RE.test(v)) return v;
      return bad('an ISO date or date-time');
    case 'month_day':
      if (typeof v === 'string' && MD_RE.test(v)) return v;
      return bad('MM-DD');
    case 'enum': {
      const s = String(v);
      if (f.enum && !f.enum.includes(s) && op !== 'ilike') {
        throw new DataQueryError('invalid_value', `"${s}" is not a value of "${f.name}"; allowed: ${f.enum.slice(0, 30).join(', ')}`);
      }
      return s;
    }
    case 'json':
      return bad('nothing: only is_null works on json fields');
    default:
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
      return bad('a text value');
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One filter → a SQL condition on `d` (data_items). `p` adds a parameter and returns its placeholder. */
function filterSql(schema: DataSchema, f: FieldDef, flt: DataFilter, p: (v: unknown) => string, today: { month: number; day: number }): string {
  const col = `d.data->${lit(f.name)}`;
  const txt = `d.data->>${lit(f.name)}`;
  const isList = f.type === 'text_list';
  const numeric = f.type === 'int' || f.type === 'number';
  const num = `(CASE WHEN jsonb_typeof(${col}) = 'number' THEN (${txt})::numeric END)`;
  const rangeCol = numeric ? num : txt;
  const rangeCast = numeric ? '::numeric' : '';
  switch (flt.op) {
    case 'eq': {
      const v = coerce(f, flt.value, 'eq');
      return `d.data @> ${p(JSON.stringify({ [f.name]: isList ? [v] : v }))}::jsonb`;
    }
    case 'in': {
      if (!Array.isArray(flt.value) || flt.value.length === 0 || flt.value.length > 50) {
        throw new DataQueryError('invalid_value', `in on "${f.name}" needs a list of 1–50 values`);
      }
      const vs = flt.value.map((v) => coerce(f, v, 'in'));
      if (isList) return `${col} ?| ${p(vs.map(String))}::text[]`;
      return `${col} = ANY(${p(vs.map((v) => JSON.stringify(v)))}::jsonb[])`;
    }
    case 'ilike': {
      if (!TEXT_TYPES.has(f.type)) throw new DataQueryError('invalid_op', `ilike works on text fields; "${f.name}" is ${f.type}`);
      const s = String(coerce(f, flt.value, 'ilike')).replace(/^%+|%+$/g, '');
      if (!s.trim()) throw new DataQueryError('invalid_value', `ilike on "${f.name}" needs some text`);
      return `${txt} ILIKE ${p(`%${escapeLike(s)}%`)}`;
    }
    case 'gte': case 'lte': {
      if (!RANGE_TYPES.has(f.type)) throw new DataQueryError('invalid_op', `${flt.op} works on number and date fields; "${f.name}" is ${f.type}`);
      return `${rangeCol} ${flt.op === 'gte' ? '>=' : '<='} ${p(coerce(f, flt.value, flt.op))}${rangeCast}`;
    }
    case 'between': {
      if (!RANGE_TYPES.has(f.type)) throw new DataQueryError('invalid_op', `between works on number and date fields; "${f.name}" is ${f.type}`);
      if (!Array.isArray(flt.value) || flt.value.length !== 2) throw new DataQueryError('invalid_value', `between on "${f.name}" needs [from, to]`);
      const [a, b] = flt.value.map((v) => coerce(f, v, 'between'));
      return `${rangeCol} BETWEEN ${p(a)}${rangeCast} AND ${p(b)}${rangeCast}`;
    }
    case 'is_null': {
      const want = flt.value === undefined || flt.value === null ? true : flt.value === true || flt.value === 'true';
      if (flt.value !== undefined && flt.value !== null && typeof flt.value !== 'boolean' && flt.value !== 'true' && flt.value !== 'false') {
        throw new DataQueryError('invalid_value', `is_null on "${f.name}" takes true or false`);
      }
      const empty = `(${col} IS NULL OR ${col} = 'null'::jsonb OR ${col} = '""'::jsonb OR ${col} = '[]'::jsonb)`;
      return want ? empty : `NOT ${empty}`;
    }
    case 'today': {
      const md = `${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
      const envelope = ['date', 'month_day', 'month', 'day'].some((r) => roleFields(schema, r as RoleName).includes(f.name));
      if (envelope) return `(d.event_month = ${p(today.month)} AND d.event_day = ${p(today.day)})`;
      if (f.type === 'month_day') return `${txt} = ${p(md)}`;
      if (f.type === 'date' || f.type === 'datetime') return `substr(${txt}, 6, 5) = ${p(md)}`;
      throw new DataQueryError('invalid_op', `today works on date or month/day fields; "${f.name}" is ${f.type}`);
    }
  }
}

function clip(v: unknown, full: boolean): { value: unknown; cut: boolean } {
  if (!full && typeof v === 'string' && v.length > MAX_TEXT) return { value: `${v.slice(0, MAX_TEXT)}…`, cut: true };
  return { value: v, cut: false };
}

/**
 * Validate and run a query against one dataset. Throws DataQueryError with an English message the
 * agent (or the owner) can act on.
 */
export async function queryDataset(pool: Pick<Pool, 'query'>, schema: DataSchema, o: QueryOptions): Promise<QueryResult> {
  const readable = readableFields(schema, o.audience);
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const readableNames = new Set(readable.map((f) => f.name));

  let fields: FieldDef[];
  if (o.fields?.length) {
    fields = [];
    for (const name of [...new Set(o.fields)]) {
      const f = byName.get(name);
      if (!f) throw new DataQueryError('unknown_field', `dataset "${schema.key}" has no field "${name}"; read library_catalog for its fields`);
      if (!readableNames.has(name)) {
        throw new DataQueryError('field_not_visible', `field "${name}" of "${schema.key}" is not visible to agents${f.deprecated ? ' (deprecated)' : ''}`);
      }
      fields.push(f);
    }
  } else {
    fields = readable;
  }

  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [`d.schema_id = ${p(schema.id)}`];
  const status = o.status ?? 'active';
  if (status !== 'all') where.push(`d.status = ${p(status)}`);

  for (const flt of o.filters ?? []) {
    const f = byName.get(flt.field);
    if (!f) throw new DataQueryError('unknown_field', `dataset "${schema.key}" has no field "${flt.field}"`);
    if (!f.filterable) {
      const allowed = schema.fields.filter((x) => x.filterable && !x.deprecated).map((x) => x.name);
      throw new DataQueryError('field_not_filterable', `field "${flt.field}" of "${schema.key}" is not filterable; filterable: ${allowed.join(', ') || 'none'}`);
    }
    where.push(filterSql(schema, f, flt, p, o.today));
  }

  if (o.categoryLike?.trim()) where.push(`d.category ILIKE ${p(o.categoryLike.trim())}`);
  if (o.todayOnly) where.push(`(d.event_month = ${p(o.today.month)} AND d.event_day = ${p(o.today.day)})`);

  if (o.search?.trim()) {
    const q = o.search.trim().slice(0, 200);
    const like = p(`%${escapeLike(q)}%`);
    const parts = [`d.search @@ plainto_tsquery('simple', ${p(q)})`, `d.title ILIKE ${like}`, `d.body ILIKE ${like}`];
    for (const f of schema.fields) if (f.searchable && !f.deprecated && TEXT_TYPES.has(f.type)) parts.push(`d.data->>${lit(f.name)} ILIKE ${like}`);
    where.push(`(${parts.join(' OR ')})`);
  }

  let cte = '';
  if (o.unpostedOn) {
    const { resourceRef } = resourceKeys(o.unpostedOn);
    cte = `WITH ${usedRefsCte(p(resourceRef))} `;
    const key = p(schema.key);
    where.push(`NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = 'data://' || ${key} || '/' || d.id::text)`);
    where.push(`(d.legacy_ref IS NULL OR NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = d.legacy_ref))`);
  }

  const order = o.order === 'newest' ? 'd.created_at DESC, d.id DESC' : o.order === 'oldest' ? 'd.created_at ASC, d.id ASC' : 'random()';
  const limit = Math.max(1, Math.min(o.limit, o.audience === 'agent' ? MAX_AGENT_LIMIT : 200));
  const whereSql = where.join(' AND ');
  const sql = `${cte}SELECT d.id::text AS id, d.legacy_ref, d.status, d.title, d.body, d.image_url, d.url, d.category,
                      d.event_date, d.event_month, d.event_day, d.created_at, d.updated_at, d.import_id, d.data,
                      (SELECT count(DISTINCT l.resource_ref) FROM content_ledger l
                        WHERE l.status = 'published'
                          AND (l.source_ref = (SELECT 'data://' || s.key || '/' || d.id FROM data_schemas s WHERE s.id = d.schema_id)
                               OR l.source_ref = d.legacy_ref))::int AS posted_count
                 FROM data_items d WHERE ${whereSql}
                ORDER BY ${order} LIMIT ${p(limit)} OFFSET ${p(Math.max(0, o.offset ?? 0))}`;
  const { rows } = await pool.query(sql, params);

  let total: number | undefined;
  if (o.withTotal) {
    const countParams = params.slice(0, params.length - 2);
    const { rows: c } = await pool.query(`${cte}SELECT count(*)::int AS n FROM data_items d WHERE ${whereSql}`, countParams);
    total = c[0]?.n ?? 0;
  }

  const truncated = new Set<string>();
  const out = rows.map((r: any) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (o.audience === 'agent') {
      const row: Record<string, unknown> = { ref: dataRef(schema.key, r.id) };
      for (const f of fields) {
        const c = clip(data[f.name] ?? null, !!o.full);
        if (c.cut) truncated.add(f.name);
        row[f.name] = c.value;
      }
      return row;
    }
    const max = o.bodyChars ?? 300;
    const body = typeof r.body === 'string' && r.body.length > max ? `${r.body.slice(0, max)}…` : r.body;
    const projected: Record<string, unknown> = {};
    for (const f of fields) {
      const c = clip(data[f.name], !!o.full);
      if (c.value !== undefined) projected[f.name] = c.value;
    }
    return {
      id: r.id, ref: dataRef(schema.key, r.id), legacy_ref: r.legacy_ref ?? null, status: r.status,
      title: r.title ?? null, body: body ?? null, image_url: r.image_url ?? null, url: r.url ?? null, category: r.category ?? null,
      event_date: r.event_date ?? null, event_month: r.event_month ?? null, event_day: r.event_day ?? null,
      created_at: r.created_at, updated_at: r.updated_at, import_id: r.import_id ?? null, posted_count: r.posted_count ?? 0,
      data: projected,
    };
  });
  return { rows: out, total, truncated: [...truncated] };
}

/** Kyiv-local month and day ("today" filters, catalog today-items). */
export function kyivMonthDay(now: Date = new Date()): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', month: 'numeric', day: 'numeric' }).formatToParts(now);
  return { month: Number(parts.find((x) => x.type === 'month')!.value), day: Number(parts.find((x) => x.type === 'day')!.value) };
}

/** Is the field the source of a date-like role, so `today` makes sense for it? */
export function supportsToday(schema: Pick<DataSchema, 'roles' | 'fields'>, f: FieldDef): boolean {
  return DATE_TYPES.has(f.type) || ['date', 'month_day', 'month', 'day'].some((r) => roleFields(schema, r as RoleName).includes(f.name));
}
