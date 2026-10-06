import { z } from 'zod';
import type { FieldDef, FieldType } from './data.types';

/**
 * Compiles a dataset's field definitions into a strict zod schema (spec 032 FR-005). Imports and the rows
 * API validate with it BEFORE calling `data_items_upsert()`, which re-checks only basic types.
 *
 * Values are coerced from their text form first (CSV cells are strings), deterministically:
 *   int       "12", "+3", 12                       number   "1.5", "1,5", "2e3", 1.5
 *   bool      true/false, yes/no, 1/0, t/f          date     YYYY-MM-DD, DD.MM.YYYY → YYYY-MM-DD
 *   datetime  ISO 8601 with a date part             month_day MM-DD, M-D, DD.MM → MM-DD
 *   text_list JSON array, or a string split on | then ; then ,
 *   json      JSON text parsed when it looks like an object/array, else the value as is
 * An empty string is "no value" for every type except text/long_text, where `emptyAsNull` decides.
 */

export interface CompileOptions {
  /** insert: required fields must be present (defaults fill gaps); patch: only given fields are checked. */
  mode?:        'insert' | 'patch';
  /** Treat '' as missing for text fields too (CSV). Default true. */
  emptyAsNull?: boolean;
  /** Allow `_extra` (unmapped columns kept as JSON). Default true. */
  allowExtra?:  boolean;
}

const INT_RE = /^[+-]?\d{1,15}$/;
const NUM_RE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const BOOL_TRUE = new Set(['true', 't', '1', 'yes', 'y']);
const BOOL_FALSE = new Set(['false', 'f', '0', 'no', 'n']);
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad2 = (n: number) => String(n).padStart(2, '0');

export function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = m === 2 ? (leap ? 29 : 28) : DAYS_IN_MONTH[m - 1];
  return d <= max;
}

export function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s)) return false;
  try { return Boolean(new URL(s).hostname); } catch { return false; }
}

/** Text form → typed value. Returns `undefined` for "no value"; returns the input unchanged when it cannot coerce. */
export function coerceValue(type: FieldType, raw: unknown, emptyAsNull = true): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '' && (emptyAsNull || (type !== 'text' && type !== 'long_text'))) return undefined;
    switch (type) {
      case 'text': case 'long_text': return raw;
      case 'url': case 'image_url': case 'enum': return t;
      case 'int': return INT_RE.test(t) ? Number(t) : raw;
      case 'number': return NUM_RE.test(t) ? Number(t.replace(',', '.')) : raw;
      case 'bool': {
        const l = t.toLowerCase();
        return BOOL_TRUE.has(l) ? true : BOOL_FALSE.has(l) ? false : raw;
      }
      case 'date': {
        const dmy = DMY_RE.exec(t);
        return dmy ? `${dmy[3]}-${pad2(+dmy[2])}-${pad2(+dmy[1])}` : t;
      }
      case 'datetime': return t;
      case 'month_day': {
        const md = /^(\d{1,2})-(\d{1,2})$/.exec(t);
        if (md) return `${pad2(+md[1])}-${pad2(+md[2])}`;
        const dm = /^(\d{1,2})\.(\d{1,2})$/.exec(t);
        return dm ? `${pad2(+dm[2])}-${pad2(+dm[1])}` : t;
      }
      case 'text_list': {
        if (t.startsWith('[')) { try { return JSON.parse(t); } catch { return raw; } }
        const sep = t.includes('|') ? '|' : t.includes(';') ? ';' : ',';
        return t.split(sep).map((x) => x.trim()).filter(Boolean);
      }
      case 'json': {
        if (/^[[{]/.test(t)) { try { return JSON.parse(t); } catch { return raw; } }
        return raw;
      }
    }
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    if (type === 'text' || type === 'long_text' || type === 'enum') return String(raw);
    if (type === 'bool' && typeof raw === 'number' && (raw === 0 || raw === 1)) return raw === 1;
  }
  if (type === 'text_list' && Array.isArray(raw)) {
    return raw.every((x) => ['string', 'number', 'boolean'].includes(typeof x)) ? raw.map(String) : raw;
  }
  return raw;
}

function baseType(f: FieldDef): z.ZodType {
  switch (f.type) {
    case 'text':      return z.string().max(10_000, 'text longer than 10 000 characters; use long_text');
    case 'long_text': return z.string().max(1_000_000);
    case 'int':       return z.number({ message: 'expected an integer' }).int('expected an integer').refine(Number.isSafeInteger, 'integer out of range');
    case 'number':    return z.number({ message: 'expected a number' }).refine(Number.isFinite, 'expected a number');
    case 'bool':      return z.boolean({ message: 'expected true or false' });
    case 'date':      return z.string().refine((s) => {
      const m = DATE_RE.exec(s);
      return Boolean(m && isValidDate(+m[1], +m[2], +m[3]));
    }, 'expected a date YYYY-MM-DD');
    case 'datetime':  return z.string().refine((s) => /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)), 'expected an ISO date-time');
    case 'month_day': return z.string().regex(MD_RE, 'expected MM-DD').refine((s) => isValidDate(2000, +s.slice(0, 2), +s.slice(3)), 'expected MM-DD');
    case 'url':
    case 'image_url': return z.string().max(4000).refine(isHttpUrl, 'expected an http(s) URL');
    case 'enum':      return z.string().refine((s) => (f.enum ?? []).includes(s), `not one of: ${(f.enum ?? []).slice(0, 20).join(', ')}`);
    case 'text_list': return z.array(z.string({ message: 'expected a list of strings' }), { message: 'expected a list of strings' }).max(1000);
    case 'json':      return z.unknown();
  }
}

/**
 * zod schema for one row. Output: the normalised row, ready for `data_items_upsert()`; in patch mode an
 * explicit null clears a field (allowed only on non-required fields).
 */
export function compileRowSchema(fields: FieldDef[], opts: CompileOptions = {}): z.ZodType<Record<string, unknown>> {
  const mode = opts.mode ?? 'insert';
  const emptyAsNull = opts.emptyAsNull ?? true;
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    const required = f.required === true && f.deprecated !== true;
    const base = baseType(f);
    shape[f.name] = z.preprocess((v) => {
      if (mode === 'patch' && v === null) return null;
      const c = coerceValue(f.type, v, emptyAsNull);
      if (c === undefined && mode === 'insert' && f.default !== undefined) return f.default;
      return c;
    }, mode === 'patch' && !required ? base.nullable().optional() : required && mode === 'insert' ? base : base.optional());
  }
  if (opts.allowExtra ?? true) shape._extra = z.record(z.string(), z.unknown()).optional();
  shape._external_key = z.string().min(1).max(500).optional();
  return z.object(shape).strict().transform((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
    return out;
  }) as unknown as z.ZodType<Record<string, unknown>>;
}

export interface RowIssue { row: number; field: string | null; error: string }

/** Validate one row; issues carry the row number the caller passes (0-based in reports). */
export function validateRow(schema: z.ZodType<Record<string, unknown>>, row: unknown, rowNo: number):
  { ok: true; value: Record<string, unknown> } | { ok: false; issues: RowIssue[] } {
  const r = schema.safeParse(row);
  if (r.success) return { ok: true, value: r.data };
  const src = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  const missing = (k: string) => src[k] === undefined || src[k] === null || (typeof src[k] === 'string' && (src[k] as string).trim() === '');
  return {
    ok: false,
    issues: r.error.issues.map((i) => {
      const field = i.path.length ? String(i.path[0]) : null;
      return {
        row: rowNo,
        field,
        error: i.code === 'unrecognized_keys' ? `unknown field: ${((i as any).keys ?? []).join(', ')}`
          : i.code === 'invalid_type' && field && missing(field) ? 'required'
          : i.message,
      };
    }),
  };
}
