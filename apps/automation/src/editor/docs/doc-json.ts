import type { JsonDocData, RawSection, StoredDoc } from './doc-types';
import { LARGE_DOC_CHARS, outlineOf } from './doc-view';

/**
 * Spec 066 FR-001 / FR-003: a JSON API answer read as a document. The records array is found in code, every record is
 * one section of pretty-printed text (so `read_doc`, `find_in_doc` and the outline work as they do for markdown), and
 * the shape of the records (paths, how often they are filled, a sample) is summarised for the model. Pagination is
 * detected from the root keys. Nothing here calls the network or a model.
 */
export const isJsonContentType = (contentType: string): boolean => /(?:^|[/+])json(?:$|[;\s])/i.test(contentType.trim());

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** An object or an array parsed from a body; null when the body is not JSON (or is a bare scalar). */
export function parseJsonBody(body: string): unknown | null {
  const t = body.replace(/^﻿/, '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const allObjects = (a: unknown[]): boolean => a.length > 0 && a.every(isObject);

/**
 * The records of an answer: the root when it is an array of objects, else the largest array of objects at a root key
 * or one level below it (`prompts`, `data.items`…). `path` is '' for the root itself.
 */
export function findRecords(value: unknown): { path: string; records: Record<string, unknown>[] } | null {
  if (Array.isArray(value)) return allObjects(value) ? { path: '', records: value as Record<string, unknown>[] } : null;
  if (!isObject(value)) return null;
  let best: { path: string; records: Record<string, unknown>[] } | null = null;
  const consider = (path: string, v: unknown) => {
    if (Array.isArray(v) && allObjects(v) && (!best || v.length > best.records.length)) best = { path, records: v as Record<string, unknown>[] };
  };
  for (const [k, v] of Object.entries(value)) {
    consider(k, v);
    if (isObject(v)) for (const [k2, v2] of Object.entries(v)) consider(`${k}.${k2}`, v2);
  }
  return best;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The label of a record: the first non-empty of title, name, slug, id; else its position. */
export function recordHeading(r: Record<string, unknown>, n: number): string {
  for (const k of ['title', 'name', 'slug', 'id']) {
    const v = r[k];
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim();
  }
  return `#${n}`;
}

export const prettyJson = (v: unknown): string => JSON.stringify(v, null, 2);

/** The root without the records array: copy only the objects along the path. */
function withoutPath(value: Record<string, unknown>, path: string): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  const out = { ...value };
  if (!rest.length) delete out[head];
  else if (isObject(out[head])) {
    const inner = withoutPath(out[head] as Record<string, unknown>, rest.join('.'));
    if (Object.keys(inner).length) out[head] = inner;
    else delete out[head];
  }
  return out;
}

/** The text, sections and stored data of a parsed JSON answer. Offsets index the text; the sections tile it. */
export function buildJsonDoc(value: unknown): { json: JsonDocData; text: string; sections: RawSection[] } {
  const found = findRecords(value);
  const parts: Array<{ heading: string; level: number; text: string }> = [];
  if (!found) {
    parts.push({ heading: '', level: 0, text: `${prettyJson(value)}\n` });
  } else {
    if (isObject(value)) {
      const rest = withoutPath(value, found.path);
      if (Object.keys(rest).length) parts.push({ heading: '', level: 0, text: `${prettyJson(rest)}\n` });
    }
    found.records.forEach((r, i) => parts.push({ heading: recordHeading(r, i + 1), level: 1, text: `${prettyJson(r)}\n` }));
  }
  let at = 0;
  const sections: RawSection[] = parts.map((p) => {
    const s: RawSection = { heading: p.heading, level: p.level, start: at, end: at + p.text.length, images: [], links: [], code_blocks: [] };
    at = s.end;
    return s;
  });
  return { json: { value, records_path: found ? found.path : null, records: found?.records ?? [] }, text: parts.map((p) => p.text).join(''), sections };
}

// ── The shape of the records ───────────────────────────────────────────────────────────────────────────────────────────

export const FIELDS_MAX = 40;
const SAMPLE_MAX = 80;

export interface FieldInfo { path: string; type: string; filled: number; sample: string | null }

const present = (v: unknown): boolean => v !== null && v !== undefined && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length)
  && !(isObject(v) && !Object.keys(v).length);

/**
 * Every path of a record that holds a value: top-level keys, the scalars of an object one level down (`author.name`),
 * and arrays of objects as `tags[].name` (the array does not count as a level). Deeper objects stop as `object`.
 */
function leaves(v: unknown, path: string, depth: number, out: Array<[string, unknown]>): void {
  if (isObject(v)) {
    for (const [k, c] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (isObject(c)) {
        if (depth >= 1) out.push([p, c]);
        else leaves(c, p, depth + 1, out);
      } else if (Array.isArray(c)) {
        if (c.some(isObject)) for (const e of c) leaves(e, `${p}[]`, depth, out);
        else out.push([p, c]);
      } else out.push([p, c]);
    }
  } else if (path) out.push([path, v]);
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const sampleOf = (v: unknown): string => clip((typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' '), SAMPLE_MAX);

export function fieldsOf(records: unknown[]): { fields: FieldInfo[]; more: number } {
  const stats = new Map<string, { types: Set<string>; filledIn: Set<number>; sample: string | null }>();
  records.forEach((r, i) => {
    const out: Array<[string, unknown]> = [];
    leaves(r, '', 0, out);
    for (const [p, v] of out) {
      let s = stats.get(p);
      if (!s) stats.set(p, (s = { types: new Set(), filledIn: new Set(), sample: null }));
      if (v !== null) s.types.add(typeOf(v));
      if (present(v)) {
        s.filledIn.add(i);
        s.sample ??= sampleOf(v);
      }
    }
  });
  const all: FieldInfo[] = [...stats.entries()].map(([path, s]) => ({
    path, type: s.types.size === 0 ? 'null' : s.types.size === 1 ? [...s.types][0] : 'mixed',
    filled: records.length ? Math.round((s.filledIn.size / records.length) * 100) / 100 : 0, sample: s.sample,
  }));
  // Fields that hold a value somewhere come first, in the order a record lists them; foreign keys and counters (nobody
  // maps `tags[].promptId`) after them, empty ones last, so the cap of 40 cuts what is least useful.
  const minor = (f: FieldInfo) => (f.path !== 'id' && /(?:^|[.\]])(?:\w*Id|\w*_id)$/.test(f.path)) || f.path.startsWith('_count.');
  const ranked = [...all.filter((f) => f.filled > 0 && !minor(f)), ...all.filter((f) => f.filled > 0 && minor(f)), ...all.filter((f) => f.filled === 0)];
  return { fields: ranked.slice(0, FIELDS_MAX), more: Math.max(0, ranked.length - FIELDS_MAX) };
}

/** The scalar values of the root (`total`, `page`…), long strings clipped. */
export function rootScalars(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (isObject(value)) for (const [k, v] of Object.entries(value)) if (isScalar(v)) out[k] = typeof v === 'string' ? clip(v, SAMPLE_MAX) : v;
  return out;
}

// ── Pagination ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Pagination {
  kind:          'page' | 'link' | 'cursor';
  /** The URL parameter that carries the page number or the cursor (not for a plain next link). */
  param?:        string;
  page?:         number;
  pages_total:   number | null;
  records_total: number | null;
  per_page:      number | null;
  /** The address of the following page; null on the last one. */
  next_url:      string | null;
}

const PAGE_KEYS = ['page', 'currentPage', 'page_number'];
const TOTAL_PAGES_KEYS = ['totalPages', 'total_pages', 'pages', 'last_page'];
const PER_PAGE_KEYS = ['perPage', 'per_page', 'limit'];
const LINK_KEYS = ['next', 'next_url', 'nextPage'];
const CURSOR_KEYS = ['next_cursor', 'cursor', 'nextCursor'];

/** Parameters that only say which slice of the list a request asks for: they are not part of what list it is. */
export const PAGING_PARAMS = new Set([...PAGE_KEYS, ...PER_PAGE_KEYS, ...CURSOR_KEYS, 'pagenumber'].map((k) => k.toLowerCase()));

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const firstKey = (o: Record<string, unknown>, keys: string[]): string | undefined => keys.find((k) => k in o);

function withParam(url: string, param: string, value: string | number): string {
  const u = new URL(url);
  u.searchParams.set(param, String(value));
  return u.toString();
}

function linkOf(v: unknown, base: string): string | null {
  const s = typeof v === 'string' ? v : isObject(v) && typeof v.href === 'string' ? v.href : '';
  if (!s.trim()) return null;
  try { return new URL(s.trim(), base).toString(); } catch { return null; }
}

/** How a JSON answer says there are more pages, from its root keys (the page parameter is named by the URL when it has one). */
export function detectPagination(root: unknown, url: string): Pagination | null {
  if (!isObject(root)) return null;
  const pageKey = firstKey(root, PAGE_KEYS);
  const page = pageKey ? num(root[pageKey]) : null;
  if (pageKey && page !== null) {
    const perKey = firstKey(root, PER_PAGE_KEYS);
    const per = perKey ? num(root[perKey]) : null;
    const total = num(root.total);
    const pagesKey = firstKey(root, TOTAL_PAGES_KEYS);
    const pages = (pagesKey ? num(root[pagesKey]) : null) ?? (total !== null && per ? Math.ceil(total / per) : null);
    if (pages !== null) {
      let has: string | null = null;
      try {
        const q = new URL(url).searchParams;
        has = [pageKey, ...PAGE_KEYS].find((k) => q.has(k)) ?? null;
      } catch { /* an address that does not parse has no page parameter */ }
      const param = has ?? 'page';
      return { kind: 'page', param, page, pages_total: pages, records_total: total, per_page: per, next_url: page < pages ? withParam(url, param, page + 1) : null };
    }
  }
  const links = isObject(root.links) ? root.links : null;
  const linkKey = firstKey(root, LINK_KEYS);
  if (linkKey || (links && 'next' in links)) {
    return { kind: 'link', pages_total: null, records_total: num(root.total), per_page: null, next_url: linkOf(linkKey ? root[linkKey] : links!.next, url) };
  }
  const cursorKey = firstKey(root, CURSOR_KEYS);
  if (cursorKey) {
    const v = root[cursorKey];
    const cursor = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    return { kind: 'cursor', param: cursorKey, pages_total: null, records_total: num(root.total), per_page: null, next_url: cursor ? withParam(url, cursorKey, cursor) : null };
  }
  return null;
}

/** The address of a list without its paging parameters: what keeps a record's ref the same on every page. */
export function listBaseUrl(url: string, extra?: string | null): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (PAGING_PARAMS.has(k.toLowerCase()) || k === extra) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

// ── What web_fetch answers ─────────────────────────────────────────────────────────────────────────────────────────────

const FIRST_RECORD_CHARS = 3_000;
const OUTLINE_IN_ANSWER = 20;
const JSON_HINT = 'Це JSON: записи — read_doc(doc_id, section) / find_in_doc; імпорт — import_list(doc_id, …) з field:<шлях>. Інші сторінки API читай окремим web_fetch (json.pagination.next_url).';

/** The `json` block: where the records are, the root scalars, the fields of a record and the pagination. */
export function jsonShape(doc: StoredDoc): Record<string, unknown> {
  const j = doc.json!;
  const { fields, more } = fieldsOf(j.records);
  const pg = detectPagination(j.value, doc.url);
  return {
    records_path: j.records_path === '' ? '(root)' : j.records_path, records: j.records.length,
    root: rootScalars(j.value), fields, ...(more ? { fields_more: more } : {}),
    ...(pg ? { pagination: pg } : {}),
  };
}

/** web_fetch's answer for a JSON document: the shape of its records, the first record, a doc_id. Null when it is read as plain text. */
export function jsonAnswer(doc: StoredDoc, cachedFlag: Record<string, unknown>): Record<string, unknown> | null {
  const j = doc.json;
  if (!j) return null;
  if (!j.records.length) {
    // A small object with no records array is answered whole; a big one goes through the outline like any large document.
    return doc.text.length <= LARGE_DOC_CHARS ? { url: doc.url, doc_id: doc.id, json: j.value, ...cachedFlag } : null;
  }
  const first = doc.sections.find((s) => s.level === 1)!;
  const text = doc.text.slice(first.start, Math.min(first.end, first.start + FIRST_RECORD_CHARS));
  const shown = outlineOf(doc).outline.filter((o) => o.level === 1).slice(0, OUTLINE_IN_ANSWER);
  return {
    url: doc.url, doc_id: doc.id, size_chars: doc.text.length, sections: doc.sections.length,
    json: jsonShape(doc), first_record: first.end - first.start > FIRST_RECORD_CHARS ? `${text}…` : text.replace(/\n$/, ''),
    outline: shown, ...(j.records.length > shown.length ? { outline_more: j.records.length - shown.length } : {}),
    hint: JSON_HINT, ...cachedFlag,
  };
}
