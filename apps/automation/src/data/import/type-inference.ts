import type { FieldDef, FieldType, Roles } from '../data.types';
import { FIELD_NAME_RE } from '../data.types';
import { isHttpUrl, isValidDate } from '../field-validation';

/**
 * Deterministic type inference for a new dataset (spec 032 FR-006) from a sample of up to 500 rows.
 * The same sample always gives the same draft. Rules, first match wins, over the non-empty values:
 *   JSON arrays → text_list (scalars) or json; JSON objects → json; JSON booleans → bool; JSON numbers → int/number;
 *   strings: true/false/yes/no → bool; integers → int; decimals (dot or comma) → number;
 *   YYYY-MM-DD → date; ISO date-time → datetime; MM-DD → month_day;
 *   http(s) URLs → image_url when every path ends in an image extension, else url;
 *   ≤ 20 distinct short values (≤ 64 chars) that repeat (distinct ≤ half the values) → enum;
 *   any value over 300 characters → long_text; otherwise text.
 * The owner then sets names, roles, the dedup key and descriptions.
 */

export const INFER_SAMPLE = 500;

const INT_RE = /^[+-]?\d{1,15}$/;
const NUM_RE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const BOOL_RE = /^(true|false|yes|no)$/i;
const IMG_RE = /\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i;

const UK_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ъ: '', ы: 'y', э: 'e', ё: 'io',
};

/** A column header → a snake_case field name (Ukrainian transliterated). */
export function suggestFieldName(header: string, taken: Set<string> = new Set()): string {
  let s = header.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[а-яіїєґёъыэ]/g, (c) => UK_LATIN[c] ?? '');
  s = s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!s) s = 'field';
  if (!/^[a-z]/.test(s)) s = `f_${s}`;
  let name = s;
  for (let n = 2; taken.has(name); n++) name = `${s}_${n}`;
  return name;
}

/** Normalised form for matching a column to a field: lower-case, transliterated, separators dropped. */
export function normaliseName(s: string): string {
  return suggestFieldName(s).replace(/_/g, '');
}

/** Column → field by normalised name; unmatched columns map to null. */
export function autoMapColumns(columns: string[], fields: Pick<FieldDef, 'name' | 'deprecated'>[]): Record<string, string | null> {
  const byNorm = new Map<string, string>();
  for (const f of fields) if (!f.deprecated) byNorm.set(normaliseName(f.name), f.name);
  for (const f of fields) if (f.deprecated && !byNorm.has(normaliseName(f.name))) byNorm.set(normaliseName(f.name), f.name);
  const used = new Set<string>();
  const out: Record<string, string | null> = {};
  for (const c of columns) {
    const f = byNorm.get(normaliseName(c));
    out[c] = f && !used.has(f) ? f : null;
    if (f) used.add(f);
  }
  return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function inferType(values: unknown[]): { type: FieldType; enum?: string[] } {
  const vals = values.filter((v) => !isEmpty(v));
  if (!vals.length) return { type: 'text' };
  if (vals.every((v) => Array.isArray(v))) {
    return (vals as unknown[][]).every((a) => a.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) ? { type: 'text_list' } : { type: 'json' };
  }
  if (vals.some((v) => typeof v === 'object')) return { type: 'json' };
  if (vals.every((v) => typeof v === 'boolean')) return { type: 'bool' };
  if (vals.every((v) => typeof v === 'number')) return { type: (vals as number[]).every(Number.isInteger) ? 'int' : 'number' };
  const s = vals.map((v) => String(v).trim());
  if (s.every((x) => BOOL_RE.test(x))) return { type: 'bool' };
  if (s.every((x) => INT_RE.test(x))) return { type: 'int' };
  if (s.every((x) => NUM_RE.test(x))) return { type: 'number' };
  if (s.every((x) => { const m = DATE_RE.exec(x); return Boolean(m && isValidDate(+m[1], +m[2], +m[3])); })) return { type: 'date' };
  if (s.every((x) => DATETIME_RE.test(x) && !Number.isNaN(Date.parse(x)))) return { type: 'datetime' };
  if (s.every((x) => MD_RE.test(x))) return { type: 'month_day' };
  if (s.every(isHttpUrl)) {
    return s.every((x) => { try { return IMG_RE.test(new URL(x).pathname); } catch { return false; } }) ? { type: 'image_url' } : { type: 'url' };
  }
  const distinct = [...new Set(s)];
  if (distinct.length <= 20 && distinct.length * 2 <= s.length && distinct.every((x) => x.length <= 64)) {
    return { type: 'enum', enum: distinct.sort() };
  }
  return { type: s.some((x) => x.length > 300) ? 'long_text' : 'text' };
}

export interface SchemaDraft {
  fields:    FieldDef[];
  roles:     Roles;
  dedup_key: string[];
  /** Source column → suggested field name. */
  mapping:   Record<string, string>;
}

const TITLE_NAMES = ['title', 'name', 'nazva', 'headline', 'subject', 'imia', 'zaholovok'];
const CATEGORY_NAMES = ['category', 'kategoriia', 'type', 'kind', 'genre', 'topic', 'tema'];
const KEY_NAMES = ['id', 'slug', 'code', 'key', 'sku', 'isbn', 'url', 'uuid'];

export function inferSchemaDraft(columns: string[], sample: Record<string, unknown>[]): SchemaDraft {
  const rows = sample.slice(0, INFER_SAMPLE);
  const taken = new Set<string>();
  const mapping: Record<string, string> = {};
  const fields: FieldDef[] = columns.map((col) => {
    const name = suggestFieldName(col, taken);
    taken.add(name);
    mapping[col] = name;
    const values = rows.map((r) => r[col]);
    const t = inferType(values);
    const example = values.find((v) => !isEmpty(v));
    return {
      name, type: t.type, description: '', required: false,
      agent_visible: true, searchable: t.type === 'text' || t.type === 'long_text', filterable: t.type === 'enum' || t.type === 'bool' || t.type === 'int',
      ...(t.enum ? { enum: t.enum } : {}),
      ...(example !== undefined ? { example: typeof example === 'string' ? example.slice(0, 200) : example } : {}),
    };
  });
  const pick = (pred: (f: FieldDef) => boolean, prefer: string[] = []) =>
    fields.find((f) => pred(f) && prefer.includes(f.name)) ?? fields.find(pred);
  const roles: Roles = {};
  const title = pick((f) => f.type === 'text', TITLE_NAMES);
  if (title) roles.title = title.name;
  const body = pick((f) => f.type === 'long_text') ?? pick((f) => f.type === 'text' && f.name !== title?.name);
  if (body) roles.body = body.name;
  const image = pick((f) => f.type === 'image_url');
  if (image) roles.image = image.name;
  const url = pick((f) => f.type === 'url');
  if (url) roles.url = url.name;
  const category = pick((f) => f.type === 'enum' || (f.type === 'text' && CATEGORY_NAMES.includes(f.name)), CATEGORY_NAMES);
  if (category && category.name !== title?.name) roles.category = category.name;
  const md = pick((f) => f.type === 'month_day');
  if (md) roles.month_day = md.name;
  const date = pick((f) => f.type === 'date' || f.type === 'datetime');
  if (date) roles.date = date.name;

  // Dedup key: a key-like column whose sample values are all present and unique.
  const unique = (f: FieldDef) => {
    const col = columns[fields.indexOf(f)];
    const vals = rows.map((r) => r[col]);
    return vals.length > 0 && vals.every((v) => !isEmpty(v)) && new Set(vals.map((v) => String(v).trim().toLowerCase())).size === vals.length;
  };
  const keyField = fields.find((f) => KEY_NAMES.includes(f.name) && unique(f)) ?? (title && unique(title) ? title : undefined);
  for (const f of fields) if (!FIELD_NAME_RE.test(f.name)) f.name = suggestFieldName(f.name, taken);
  return { fields, roles, dedup_key: keyField ? [keyField.name] : [], mapping };
}
