// Pure helpers for the /app/data pages (spec 032): field and filter vocabulary, filter values typed from
// the form inputs, the edit preview summary and the import-mapping of a drafted dataset. Mirrors the rules
// in apps/automation/src/data (types, filter operators, versioning) so the UI explains them before saving.

export const FIELD_TYPES = [
  'text', 'long_text', 'int', 'number', 'bool', 'date', 'datetime', 'month_day',
  'url', 'image_url', 'enum', 'text_list', 'json',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const ROLE_NAMES = [
  'title', 'body', 'image', 'url', 'category', 'date', 'month_day', 'month', 'day', 'lang',
  'source_name', 'source_url', 'license',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface FieldDef {
  name:           string;
  type:           FieldType;
  description:    string;
  required?:      boolean;
  agent_visible?: boolean;
  searchable?:    boolean;
  filterable?:    boolean;
  example?:       unknown;
  enum?:          string[];
  deprecated?:    boolean;
  default?:       unknown;
  since_version?: number;
}

export const DATASET_STATUS: Record<'draft' | 'active' | 'archived', { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
  active:   { label: 'Active', tone: 'success' },
  draft:    { label: 'Draft', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const FILTER_OPS =['eq', 'in', 'ilike', 'gte', 'lte', 'between', 'is_null', 'today'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface DataFilter { field: string; op: FilterOp; value?: unknown }

export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const SCHEMA_KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;

export const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text', long_text: 'Long text', int: 'Integer', number: 'Number', bool: 'Yes / no', date: 'Date',
  datetime: 'Date and time', month_day: 'Month-day', url: 'URL', image_url: 'Image URL', enum: 'One of a list',
  text_list: 'List of texts', json: 'JSON',
};

export const ROLE_LABEL: Record<RoleName, string> = {
  title: 'Title', body: 'Body', image: 'Image', url: 'Link', category: 'Category', date: 'Date', month_day: 'Month-day',
  month: 'Month', day: 'Day', lang: 'Language', source_name: 'Source name', source_url: 'Source URL', license: 'License',
};

export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is', in: 'is one of', ilike: 'contains', gte: 'at least', lte: 'at most', between: 'between', is_null: 'is empty', today: 'is today',
};

const TEXTUAL: readonly FieldType[] = ['text', 'long_text', 'url', 'image_url', 'enum', 'text_list'];
const RANGE: readonly FieldType[] = ['int', 'number', 'date', 'datetime', 'month_day'];

/** Operators the backend accepts for a field (data-query.ts). `today` also needs a date-like role or type. */
export function opsForField(f: Pick<FieldDef, 'type' | 'name'>, roles: Partial<Record<RoleName, string | string[]>> = {}): FilterOp[] {
  if (f.type === 'json') return ['is_null'];
  const ops: FilterOp[] = ['eq', 'in'];
  if (TEXTUAL.includes(f.type)) ops.push('ilike');
  if (RANGE.includes(f.type)) ops.push('gte', 'lte', 'between');
  ops.push('is_null');
  const dateRole = (['date', 'month_day', 'month', 'day'] as const).some((r) => {
    const v = roles[r];
    return (Array.isArray(v) ? v : v ? [v] : []).includes(f.name);
  });
  if (dateRole || f.type === 'date' || f.type === 'datetime' || f.type === 'month_day') ops.push('today');
  return ops;
}

/** Ops that take no value input. */
export const VALUELESS: readonly FilterOp[] = ['is_null', 'today'];

/**
 * A filter from the form: `raw` is what the owner typed (`in` → comma separated, `between` → two inputs).
 * Returns an English error instead of a filter when the value does not fit the type.
 */
export function buildFilter(f: Pick<FieldDef, 'name' | 'type'>, op: FilterOp, raw: string, raw2 = ''): DataFilter | { error: string } {
  if (op === 'today') return { field: f.name, op };
  if (op === 'is_null') return { field: f.name, op, value: raw !== 'false' };
  const one = (s: string): unknown | { error: string } => {
    const t = s.trim();
    if (!t) return { error: 'Enter a value' };
    if (f.type === 'int' || f.type === 'number') {
      const n = Number(t.replace(',', '.'));
      if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) return { error: f.type === 'int' ? 'Enter a whole number' : 'Enter a number' };
      return n;
    }
    if (f.type === 'bool') {
      if (!/^(true|false|yes|no)$/i.test(t)) return { error: 'Enter yes or no' };
      return /^(true|yes)$/i.test(t);
    }
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: 'Use YYYY-MM-DD' };
    if (f.type === 'month_day' && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(t)) return { error: 'Use MM-DD' };
    return t;
  };
  const isErr = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in (v as object);
  if (op === 'in') {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return { error: 'Enter values separated by commas' };
    if (parts.length > 50) return { error: 'At most 50 values' };
    const vs = parts.map(one);
    const bad = vs.find(isErr);
    return bad ? bad : { field: f.name, op, value: vs };
  }
  if (op === 'between') {
    const a = one(raw);
    const b = one(raw2);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    return { field: f.name, op, value: [a, b] };
  }
  const v = one(raw);
  return isErr(v) ? v : { field: f.name, op, value: v };
}

export function filterLabel(flt: DataFilter): string {
  const v = flt.value;
  if (flt.op === 'today') return `${flt.field} is today`;
  if (flt.op === 'is_null') return `${flt.field} ${v === false ? 'is not empty' : 'is empty'}`;
  if (flt.op === 'between' && Array.isArray(v)) return `${flt.field} between ${String(v[0])} and ${String(v[1])}`;
  if (flt.op === 'in' && Array.isArray(v)) return `${flt.field} is one of ${v.map(String).join(', ')}`;
  return `${flt.field} ${OP_LABEL[flt.op]} ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}`;
}

export interface PreviewLike {
  structural: boolean; nextVersion: number; rows: number; rows_on_older_version: number;
  changes: Array<{ kind: string; field?: string; detail?: string }>; errors: string[];
}

const nf = new Intl.NumberFormat('en-GB');
export const fmtInt = (n: number | null | undefined) => (n == null ? '—' : nf.format(n));

/** The fields of a dataset row the key-numbers strip of /app/data adds up. */
export interface DatasetCounts {
  status: string; rows: number; rows_active: number; unposted_network: number | null; last_import_at: string | null;
}

/**
 * The numbers above the dataset list: how many datasets (and how many are live), rows (active, and the hidden rest),
 * rows nobody has posted yet (`null` when no dataset has stats), and the latest import.
 */
export function summarizeDatasets(rows: readonly DatasetCounts[]) {
  let unposted: number | null = null;
  let lastImportAt: string | null = null;
  for (const d of rows) {
    if (d.unposted_network != null) unposted = (unposted ?? 0) + d.unposted_network;
    if (d.last_import_at && (!lastImportAt || new Date(d.last_import_at) > new Date(lastImportAt))) lastImportAt = d.last_import_at;
  }
  return {
    count: rows.length,
    active: rows.filter((d) => d.status === 'active').length,
    drafts: rows.filter((d) => d.status === 'draft').length,
    rows: rows.reduce((a, d) => a + d.rows_active, 0),
    hidden: rows.reduce((a, d) => a + (d.rows - d.rows_active), 0),
    unposted,
    lastImportAt,
  };
}

/** "Version 3 → 4. 1,240 rows keep version 3." / "Description-only edit: stays version 3." */
export function previewSummary(p: PreviewLike, currentVersion: number): string {
  if (p.errors.length) return `This edit cannot be saved: ${p.errors[0]}`;
  if (!p.changes.length) return 'Nothing changed.';
  if (!p.structural) return `Description-only edit: the dataset stays on version ${currentVersion}.`;
  const rows = p.rows_on_older_version;
  const tail = rows > 0
    ? ` ${fmtInt(rows)} existing ${rows === 1 ? 'row keeps' : 'rows keep'} version ${currentVersion} and stay${rows === 1 ? 's' : ''} valid.`
    : ' The dataset has no rows yet.';
  return `Structural edit: version ${currentVersion} → ${p.nextVersion}.${tail}`;
}

export function changeLabel(c: { kind: string; field?: string; detail?: string }): string {
  const f = c.field ? `"${c.field}"` : '';
  switch (c.kind) {
    case 'field_added': return `New field ${f}${c.detail ? ` (${c.detail})` : ''}`;
    case 'field_deprecated': return `Field ${f} deprecated`;
    case 'field_restored': return `Field ${f} restored`;
    case 'field_changed': return `Field ${f} changed`;
    case 'field_described': return `Description or flags of ${f}`;
    case 'roles': return 'Roles mapping';
    case 'dedup_key': return 'Dedup key';
    case 'dataset_text': return `Dataset ${c.field?.replace(/_/g, ' ') ?? 'text'}`;
    default: return c.kind;
  }
}

/** A drafted field of a new dataset, still tied to the file column it comes from. */
export interface DraftField extends FieldDef { column: string; include: boolean }

/** Column → field mapping for the dry run of a drafted dataset (excluded columns map to null). */
export function draftMapping(fields: DraftField[]): Record<string, string | null> {
  return Object.fromEntries(fields.map((f) => [f.column, f.include ? f.name : null]));
}

/** Problems that stop a drafted dataset from being created (checked again by the server). */
export function draftProblems(d: { key: string; title: string; fields: DraftField[]; dedup_key: string[] }): string[] {
  const out: string[] = [];
  if (!SCHEMA_KEY_RE.test(d.key)) out.push('Key: 2–63 characters, a-z, 0-9 and _, starting with a letter');
  if (!d.title.trim()) out.push('Give the dataset a title');
  const inc = d.fields.filter((f) => f.include);
  if (!inc.length) out.push('Include at least one column');
  const seen = new Set<string>();
  for (const f of inc) {
    if (!FIELD_NAME_RE.test(f.name)) out.push(`Field name "${f.name}" must be snake_case (a-z, 0-9, _)`);
    if (seen.has(f.name)) out.push(`Two fields are called "${f.name}"`);
    seen.add(f.name);
    if (f.type === 'enum' && !(f.enum?.length)) out.push(`Field "${f.name}" is a list choice but has no values`);
  }
  for (const k of d.dedup_key) if (!inc.some((f) => f.name === k)) out.push(`Dedup key "${k}" is not an included field`);
  return [...new Set(out)];
}

/** A role value as shown in a select: a list of fields reads "a, then b". */
export function roleValueLabel(v: string | string[] | undefined): string {
  if (!v) return '';
  return Array.isArray(v) ? v.join(', then ') : v;
}

export const EDITABLE_KEYS = [
  'title', 'description', 'entity', 'fields', 'roles', 'language', 'default_license', 'reuse_policy', 'suitable_for',
  'contains_personal_data', 'status',
] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

/** JSON with sorted object keys: the server (jsonb) stores keys in its own order, an edited copy may build them in another. */
function stable(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x));
}

/** Only what changed between the saved dataset and the edited copy (the server diffs it again for versioning). */
export function schemaPatch<T extends Partial<Record<EditableKey, unknown>>>(saved: T, edited: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of EDITABLE_KEYS) {
    if (stable(saved[k]) !== stable(edited[k])) (out as Record<string, unknown>)[k] = edited[k];
  }
  return out;
}

// ─── Reuse policy (spec 071: rounds) ────────────────────────────────────────

/** When a row may be posted again on the same channel. A `cycle` dataset posts every row once per round. */
export type ReusePolicy =
  | { kind: 'never' }
  | { kind: 'after_days'; days: number }
  | { kind: 'cycle'; order: 'sequential' | 'random'; order_by?: string[] };
export type CyclePolicy = Extract<ReusePolicy, { kind: 'cycle' }>;

/** Field types a round may be ordered by (the server checks again). */
export const ORDERABLE_TYPES: readonly FieldType[] = ['int', 'number', 'date', 'datetime', 'month_day', 'text', 'enum'];
export const MAX_ORDER_BY = 3;

/** The fields an in-order round can sort by: live, scalar. */
export const orderableFields = (fields: Pick<FieldDef, 'name' | 'type' | 'deprecated'>[]): string[] =>
  fields.filter((f) => !f.deprecated && ORDERABLE_TYPES.includes(f.type)).map((f) => f.name);

export type ReuseChoice = 'never' | 'after_days' | 'cycle_sequential' | 'cycle_random';

export const REUSE_CHOICES: ReadonlyArray<{ value: ReuseChoice; label: string }> = [
  { value: 'never',            label: 'Never again' },
  { value: 'after_days',       label: 'After N days' },
  { value: 'cycle_sequential', label: 'Repeat in rounds — in order' },
  { value: 'cycle_random',     label: 'Repeat in rounds — random' },
];

export const ROUNDS_HINT = 'Every row is posted once on each channel; when all are posted, a new round starts.';

export function reuseChoice(p: ReusePolicy): ReuseChoice {
  if (p.kind === 'cycle') return p.order === 'sequential' ? 'cycle_sequential' : 'cycle_random';
  return p.kind;
}

/** The policy after the owner picks an option: what still fits is kept (days, a chosen order), the rest starts fresh. */
export function reuseFromChoice(choice: ReuseChoice, prev: ReusePolicy): ReusePolicy {
  switch (choice) {
    case 'never': return { kind: 'never' };
    case 'after_days': return { kind: 'after_days', days: prev.kind === 'after_days' ? prev.days : 365 };
    case 'cycle_random': return { kind: 'cycle', order: 'random' };
    case 'cycle_sequential': {
      const by = prev.kind === 'cycle' && prev.order === 'sequential' ? prev.order_by : undefined;
      return by?.length ? { kind: 'cycle', order: 'sequential', order_by: by } : { kind: 'cycle', order: 'sequential' };
    }
  }
}

/**
 * One of the "Order by" selects changed. `name` '' is "Import order" / "no further field": it ends the list there.
 * A field already used by another select is ignored (the same field twice orders nothing). At most MAX_ORDER_BY.
 */
export function setOrderBy(p: CyclePolicy, index: number, name: string): CyclePolicy {
  const cur = p.order_by ?? [];
  if (index < 0 || index >= MAX_ORDER_BY || index > cur.length) return p;
  let next: string[];
  if (!name) next = cur.slice(0, index);
  else if (cur.some((n, i) => n === name && i !== index)) return p;
  else next = [...cur.slice(0, index), name, ...cur.slice(index + 1)];
  return next.length ? { kind: 'cycle', order: p.order, order_by: next } : { kind: 'cycle', order: p.order };
}

/** The setting in one line: "Never again", "After 30 days", "In rounds, in order (by ticket_number, then question_num)". */
export function reuseLabel(p: ReusePolicy): string {
  if (p.kind === 'never') return 'Never again';
  if (p.kind === 'after_days') return `After ${fmtInt(p.days)} ${p.days === 1 ? 'day' : 'days'}`;
  // The server reads a cycle with no order (or an unknown one) as random (cycleOrder).
  if (p.order !== 'sequential') return 'In rounds, random';
  return p.order_by?.length ? `In rounds, in order (by ${p.order_by.join(', then ')})` : 'In rounds, in order (import order)';
}

/** One channel's place in a round (GET /api/data/schemas/:key/rounds). */
export interface RoundLike { round: number; done: number; total: number; waiting: number; open: number }

/** "Round 2 · 14 of 30 posted" — the card line. */
export function roundLine(r: RoundLike): string {
  return `Round ${r.round} · ${fmtInt(r.done)} of ${fmtInt(r.total)} posted`;
}

/** What is left, and why the round has not rolled yet when nothing is open. */
export function roundLeft(r: RoundLike): string {
  if (r.total === 0) return 'No postable rows';
  if (r.open > 0) return `${fmtInt(r.open)} left${r.waiting > 0 ? `, ${fmtInt(r.waiting)} waiting for approval` : ''}`;
  if (r.waiting > 0) return `${fmtInt(r.waiting)} waiting for approval — the round rolls when they are decided`;
  return r.done > 0 ? 'Everything is posted — a new round starts when the next post is planned' : 'Nothing posted in this round yet';
}

/** Share of the round that is posted, 0–100. */
export const roundPercent = (r: Pick<RoundLike, 'done' | 'total'>): number => (r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0);

/** A new field as the owner typed it, or an English problem. New fields are optional (FR-002). */
export function newField(existing: Pick<FieldDef, 'name'>[], v: { name: string; type: FieldType; description: string; enumText?: string }): FieldDef | { error: string } {
  const name = v.name.trim();
  if (!FIELD_NAME_RE.test(name)) return { error: 'Field names are snake_case: a-z, 0-9 and _, starting with a letter' };
  if (existing.some((f) => f.name === name)) return { error: `A field "${name}" already exists (deprecated fields keep their names)` };
  const values = (v.enumText ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (v.type === 'enum' && !values.length) return { error: 'List the allowed values, comma separated' };
  return {
    name, type: v.type, description: v.description.trim(), required: false, agent_visible: true,
    searchable: v.type === 'text' || v.type === 'long_text', filterable: false,
    ...(v.type === 'enum' ? { enum: [...new Set(values)] } : {}),
  };
}

/** Short text for a cell value of any type. */
export function cellText(v: unknown, max = 120): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
