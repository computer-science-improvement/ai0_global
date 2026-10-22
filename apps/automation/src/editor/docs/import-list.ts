import { z } from 'zod';
import type { Pool } from 'pg';
import { DataStore } from '../../data/data-store';
import { DataImportService } from '../../data/import/data-import.service';
import { FIELD_NAME_RE, SCHEMA_KEY_RE, schemaInputSchema, type DataSchema, type FieldDef, type Roles, type SchemaInput } from '../../data/data.types';
import { describePostRequires, postMissing, type PostRequires } from '../../data/post-requires';
import type { CardSource } from '../card';
import type { RawGet } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import type { HostFailures } from '../net/host-failures';
import { isFetchFailure } from '../net/host-failures';
import { canonicalUrl, type DocStore } from './doc-store';
import type { StoredDoc } from './doc-types';
import { fetchDocument } from './doc-fetch';
import { detectPagination, listBaseUrl } from './doc-json';
import { entriesOf, entryLevel, ExtractError, extractRow, filterEntries, jsonEntries, stripNumbering, type FilterScalar, type ListEntry, type ListFilter } from './list-extract';
import { importCaps, PAGE_DELAY_MS, pagingNote, pagingPreview, readPages, type PagingInfo, type PagingPreview } from './json-pages';

/**
 * Spec 065 FR-003 / spec 066 FR-002: a list page, or the records of a JSON API, become dataset rows. `buildPlan` is the pure part — entries, mapped rows, what is
 * dropped and why, the dataset to create — shared by the preview, the Apply of the card and the re-sync. The writes go
 * through the data store's rows import, so every sync is a `data_imports` row the dashboard can undo.
 */
export const IMPORT_LIST_KIND = 'import_list';
export const RESYNC_IMPORT_KIND = 'resync_import';

const scalarSchema = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
const whereSchema = z.record(z.string().min(1).max(120), z.union([scalarSchema, z.array(scalarSchema).min(1).max(50)])).refine((w) => Object.keys(w).length <= 10, 'at most 10 paths');
const hasSchema = z.array(z.string().min(1).max(120)).min(1).max(10);

export const ImportListInput = z.object({
  doc_id:  z.string().min(3).max(40).describe('doc_id from web_fetch of the list page'),
  dataset: z.string().regex(SCHEMA_KEY_RE, 'snake_case: a-z, 0-9 and _, 2–63 characters').describe('dataset key; created at Apply when it does not exist'),
  mapping: z.record(z.string().regex(FIELD_NAME_RE), z.string().min(1).max(300)).refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 20, 'map 1–20 fields')
    .describe('field → extractor. Markdown list: heading, first_code_block, first_image, last_image, image:<n>, first_paragraph, link_after:<label>, link_text_after:<label>, last_link_after:<label>, line_after:<label>, regex:<pattern>, const:<value>. JSON records: field:<path> (a.b, [n] indexes, [] maps and joins with ", ", e.g. tags[].tag.name), first_of:<path>|<path>, const:<value>, regex:<pattern> (over the record\'s JSON text)'),
  level:   z.number().int().min(1).max(6).optional().describe('heading level of one entry; by default the level whose sections hold the code blocks (not for JSON)'),
  filter:  z.object({
    heading_matches:  z.string().max(200).optional(),
    heading_excludes: z.string().max(200).optional(),
    has_code_block:   z.boolean().optional(),
    has_image:        z.boolean().optional(),
    not_containing:   z.string().max(100).optional(),
    where:            whereSchema.optional(),
    has:              hasSchema.optional(),
  }).optional(),
  where:   whereSchema.optional().describe('JSON records: keep a record whose value at each path equals one of the values, e.g. { "type": ["TEXT", "IMAGE"] } (same as filter.where)'),
  has:     hasSchema.optional().describe('JSON records: keep a record whose paths all hold a value, e.g. ["mediaUrl"] (same as filter.has)'),
  pages:   z.number().int().min(1).max(500).optional().describe('JSON API: read at most this many pages (default: all, up to the IMPORT_MAX_PAGES cap)'),
  sample:  z.number().int().min(1).max(10).default(3),
  required: z.array(z.string().regex(FIELD_NAME_RE)).max(10).optional().describe('fields a row needs to be postable (a new dataset\'s post_requires, each one needed); default: the fields read by heading / first_code_block / images; for JSON: a row needs its text or its picture (the mapped long-text and image fields, any one)'),
  license: z.string().min(2).max(40).optional().describe('licence of the list, e.g. CC BY 4.0 (stored per row)'),
  title:   z.string().min(1).max(200).optional().describe('title of a new dataset'),
  description: z.string().max(1000).optional().describe('what a new dataset holds'),
  language: z.string().max(20).optional().describe('language of the rows of a new dataset'),
});
export type ImportListArgs = z.infer<typeof ImportListInput>;

/** What a card carries: enough to run the same import again from the address. */
export interface ImportPayload {
  url:        string;
  dataset:    string;
  level:      number;
  mapping:    Record<string, string>;
  filter?:    ListFilter;
  required:   PostRequires;
  new_schema: SchemaInput | null;
  /** JSON API: the most pages Apply reads (the model's `pages`). */
  pages?:     number;
  /** How many rows the preview found importable (the card text; Apply counts again). */
  expected:   number;
}

export class PlanError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export interface ImportPlan {
  url:         string;
  fetched_url: string | null;
  level:       number;
  /** Entries of the level, before the filter. */
  entries:     number;
  filtered:    number;
  mapping:     Record<string, string>;
  filter?:     ListFilter;
  required:    PostRequires;
  requires:    PostRequires;
  rows:        Array<Record<string, unknown>>;
  /** Entries the dataset's `post_requires` refuse (not postable), with what each lacks. */
  incomplete:  Array<{ heading: string; missing: string[] }>;
  /** Share of the kept entries that have a value, per field. */
  fill:        Record<string, number>;
  newSchema:   SchemaInput | null;
  license_hint: string | null;
  notes:       string[];
  /** How a paged JSON source was read (Apply and re-sync only). */
  paging?:     PagingInfo;
}

/** Fields of a created dataset, by the names the model gave them. */
function fieldType(name: string): FieldDef['type'] {
  if (/^(?:media|image|photo|picture|thumb)\w*$/.test(name) || /_(?:image|img|photo)$/.test(name) || name === 'media_url') return 'image_url';
  if (/(?:^|_)url$/.test(name) || name === 'link') return 'url';
  if (/(?:^|_)(?:text|body|description|prompt|content|caption)$/.test(name) || name === 'prompt') return 'long_text';
  return 'text';
}

const DESCRIBE: Record<string, string> = {
  title: 'The entry\'s name', prompt_text: 'The full prompt, exactly as in the list, with its line breaks', media_url: 'The example image of the entry',
  author: 'Who made the entry', source_url: 'Where the entry was published', license: 'Licence of the entry', category: 'The list\'s section of the entry',
  description: 'What the entry is', list_ref: 'The list page and the entry\'s name: the key that keeps a re-sync from adding an entry twice',
  list_url: 'The list page the entry was imported from',
};

/** Roles by the usual field names, only for fields that exist. */
function rolesFor(names: Set<string>): Roles {
  const first = (...c: string[]) => c.find((n) => names.has(n));
  const roles: Roles = {};
  const set = (role: keyof Roles, name: string | undefined) => { if (name) roles[role] = name; };
  set('title', first('title', 'name'));
  set('body', first('prompt_text', 'body', 'text', 'description'));
  set('image', first('media_url', 'image_url', 'image'));
  set('url', first('source_url', 'url'));
  set('source_name', first('author', 'source_name'));
  set('license', first('license'));
  set('category', first('category'));
  return roles;
}

export function planSchema(args: Pick<ImportListArgs, 'dataset' | 'title' | 'description' | 'language' | 'license'>, mapping: Record<string, string>, required: PostRequires, listUrl: string): SchemaInput {
  const names = [...Object.keys(mapping), 'list_ref', 'list_url'];
  const fields: FieldDef[] = names.map((name) => ({
    name, type: name === 'list_ref' ? 'text' : name === 'list_url' ? 'url' : fieldType(name),
    description: DESCRIBE[name] ?? `${name.replace(/_/g, ' ')} of the entry`,
    ...(name === 'list_ref' ? { agent_visible: false } : {}),
    ...(['title', 'prompt_text', 'description', 'author', 'category'].includes(name) ? { searchable: true } : {}),
    ...(['type', 'kind', 'category'].includes(name) ? { filterable: true } : {}),
  }));
  const parsed = schemaInputSchema.safeParse({
    key: args.dataset,
    title: args.title ?? args.dataset.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    description: args.description ?? `Entries imported from the list ${listUrl}. Each row is one entry of that page: a title, the text, the picture and who it is by.`,
    entity: 'entry', fields, roles: rolesFor(new Set(names)), dedup_key: ['list_ref'],
    language: args.language ?? null, default_license: args.license ?? 'unknown', reuse_policy: { kind: 'never' },
    suitable_for: 'Posts built from one entry of the list; credit the author and the source.',
    post_requires: required.map((r) => (Array.isArray(r) ? r : [r])),
  });
  if (!parsed.success) throw new PlanError('invalid_dataset', `cannot create dataset "${args.dataset}" from this mapping`, parsed.error.issues.slice(0, 5));
  return parsed.data;
}

/** The fields whose value is the entry's content: without them there is nothing to post. */
const CONTENT = /^(?:heading|first_code_block|code_block|first_image|last_image|image)(?::|$)/;

/** «License-CC_BY_4.0» of a badge, or «License: MIT», in the top of a README → «CC BY 4.0». */
export function licenseHint(doc: StoredDoc): string | null {
  const m = /licen[sc]e[-_ :]+((?:CC[-_ ]BY(?:[-_ ](?:SA|NC|ND))*[-_ ]\d\.\d)|CC0[-_ ]1\.0|MIT|Apache[-_ ]2\.0|BSD[-_ ]\d-Clause|GPL[-_ ]?v?\d(?:\.\d)?)/i.exec(doc.text.slice(0, 8000));
  return m ? m[1].replace(/[-_]/g, ' ') : null;
}

const refOf = (url: string, heading: string, seen: Map<string, number>): string => {
  const key = stripNumbering(heading).toLowerCase().replace(/\s+/g, ' ');
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return `${canonicalUrl(url)}#${n > 1 ? `${key} (${n})` : key}`;
};

/** A record's ref (spec 066 FR-002): the list's address without its paging parameters, then `#` and the record's id (else its title, else its position). */
function jsonRefOf(base: string, record: unknown, index: number, seen: Map<string, number>, notes: Set<string>): string | null {
  const r = record && typeof record === 'object' && !Array.isArray(record) ? (record as Record<string, unknown>) : {};
  const pick = (keys: string[]) => keys.map((k) => r[k]).find((v) => (typeof v === 'string' && v.trim()) || typeof v === 'number');
  const id = pick(['id', 'uuid', 'slug']);
  if (id !== undefined) {
    const ref = `${base}#${String(id).trim()}`;
    // The same id twice (a page boundary moved while the pages were read) is the same record.
    if (seen.has(ref)) return null;
    seen.set(ref, 1);
    return ref;
  }
  const title = pick(['title']);
  if (title !== undefined) return uniqueRef(`${base}#${String(title).trim().toLowerCase().replace(/\s+/g, ' ')}`, seen);
  notes.add('some records have no id, uuid, slug or title: their ref is their position in the list, so a re-sync may add them again if the list shifts');
  return uniqueRef(`${base}#record ${index + 1}`, seen);
}

const uniqueRef = (key: string, seen: Map<string, number>): string => {
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return n > 1 ? `${key} (${n})` : key;
};

/** The default `required` of a JSON import: the row needs its text or its picture (the mapped long-text and image fields; any one). */
function jsonRequired(mapping: Record<string, string>): PostRequires {
  const names = Object.keys(mapping).filter((f) => ['long_text', 'image_url'].includes(fieldType(f)));
  return names.length > 1 ? [names] : names;
}

/** `where` and `has` may be given beside `filter`; they are part of it. */
function filterOf(args: { filter?: ListFilter; where?: ListFilter['where']; has?: string[] }): ListFilter | undefined {
  if (!args.where && !args.has) return args.filter;
  return { ...args.filter, ...(args.where ? { where: args.where } : {}), ...(args.has ? { has: args.has } : {}) };
}

export type PlanArgs = Omit<ImportListArgs, 'sample' | 'doc_id' | 'required'> & { sample?: number; required?: PostRequires };

export function buildPlan(doc: StoredDoc, args: PlanArgs, existing: DataSchema | null, src: { records?: unknown[]; paging?: PagingInfo } = {}): ImportPlan {
  const mapping: Record<string, string> = { ...args.mapping };
  if (args.license && !mapping.license && (!existing || existing.fields.some((f) => f.name === 'license'))) mapping.license = `const:${args.license}`;

  const isJson = doc.kind === 'json';
  const filter = filterOf(args);
  let level: number | null;
  let all: ListEntry[];
  if (isJson) {
    const records = src.records ?? doc.json?.records ?? [];
    if (!records.length) throw new PlanError('no_entries', 'the JSON has no array of records (objects) to import; read the document with read_doc to see its shape');
    level = 1;
    all = jsonEntries(records);
  } else {
    level = args.level ?? entryLevel(doc);
    if (!level) throw new PlanError('no_entries', 'cannot tell which headings are the entries: no heading level holds code blocks or pictures; pass level');
    all = entriesOf(doc, level);
    if (!all.length) throw new PlanError('no_entries', `the document has no sections of heading level ${level}`);
  }
  let kept: ListEntry[];
  let filtered: number;
  try {
    ({ kept, dropped: filtered } = filterEntries(all, filter));
  } catch (err) {
    if (err instanceof ExtractError) throw new PlanError(err.code, err.message);
    throw err;
  }

  if (existing) {
    if (existing.status === 'archived') throw new PlanError('dataset_archived', `dataset "${existing.key}" is archived`);
    const have = new Set(existing.fields.map((f) => f.name));
    const unknown = Object.keys(mapping).filter((n) => !have.has(n));
    if (unknown.length) throw new PlanError('unknown_field', `dataset "${existing.key}" has no field ${unknown.join(', ')}; its fields: ${[...have].join(', ')}`);
    const key = existing.dedup_key;
    if (!have.has('list_ref') && (!key.length || key.some((k) => !(k in mapping)))) {
      throw new PlanError('no_dedup', `dataset "${existing.key}" has no list_ref field and its dedup key (${key.join(', ') || 'none'}) is not mapped: a re-sync would add entries twice; use a new dataset key`);
    }
  }

  const required: PostRequires = args.required ?? (isJson ? jsonRequired(mapping) : Object.entries(mapping).filter(([, spec]) => CONTENT.test(spec)).map(([f]) => f));
  const bad = required.flat().filter((r) => !(r in mapping));
  if (!existing && bad.length) throw new PlanError('unknown_field', `required lists ${bad.join(', ')}, which the mapping does not fill`);
  const requires: PostRequires = existing ? existing.post_requires ?? [] : required.map((r) => (Array.isArray(r) ? r : [r]));

  const seen = new Map<string, number>();
  const base = isJson ? listBaseUrl(doc.url, detectPagination(doc.json?.value, doc.url)?.param) : canonicalUrl(doc.url);
  const refNotes = new Set<string>();
  let duplicates = 0;
  const rows: Array<Record<string, unknown>> = [];
  const incomplete: ImportPlan['incomplete'] = [];
  const filledCount: Record<string, number> = Object.fromEntries(Object.keys(mapping).map((f) => [f, 0]));
  const hasField = (n: string) => !existing || existing.fields.some((f) => f.name === n);
  for (const [i, e] of kept.entries()) {
    let row: Record<string, unknown>;
    try {
      row = extractRow(mapping, e);
    } catch (err) {
      if (err instanceof ExtractError) throw new PlanError(err.code, err.message);
      throw err;
    }
    for (const f of Object.keys(row)) filledCount[f]++;
    if (hasField('list_ref')) {
      const ref = isJson ? jsonRefOf(base, e.record, i, seen, refNotes) : refOf(doc.url, e.heading, seen);
      if (ref === null) { duplicates++; continue; }
      row.list_ref = ref;
    }
    if (hasField('list_url')) row.list_url = doc.url;
    const missing = postMissing(requires, row);
    if (missing.length) incomplete.push({ heading: e.heading, missing });
    else rows.push(row);
  }
  const fill = Object.fromEntries(Object.entries(filledCount).map(([f, n]) => [f, kept.length ? Math.round((n / kept.length) * 100) : 0]));

  const hint = isJson ? null : licenseHint(doc);
  const notes: string[] = [...refNotes];
  if (duplicates) notes.push(`${duplicates} records repeat an id already read (the pages overlap) and are counted once`);
  const several = kept.filter((e) => e.images.length > 1).length;
  if (several && Object.values(mapping).some((s) => s === 'first_image')) notes.push(`${several} entries have several pictures: first_image takes the first (often the input of an edit), last_image the last (the result); image:<n> a given one`);
  if (!mapping.license && !args.license) notes.push(hint ? `the list says it is licensed ${hint}: pass license: "${hint}" to store it per row` : 'no licence given: rows get the dataset default (unknown)');
  if (incomplete.length) notes.push(`${incomplete.length} entries lack ${describePostRequires(requires).join(', ')} and are not imported (they could not be posted)`);

  const newSchema = existing ? null : planSchema(args, mapping, required, doc.url);
  return {
    url: doc.url, fetched_url: doc.fetched_url, level, entries: all.length, filtered, mapping, ...(filter ? { filter } : {}),
    required, requires, rows, incomplete, fill, newSchema, license_hint: hint, notes, ...(src.paging ? { paging: src.paging } : {}),
  };
}

const clip = (v: unknown, n = 300) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);

/** What the model (and the card) shows of a plan: counts, per-field fill and a few rows with long texts clipped. */
export function previewOf(plan: ImportPlan, sample: number, datasetExists: boolean, dataset: string, paging?: PagingPreview | null) {
  return {
    url: plan.url, ...(plan.fetched_url ? { fetched_url: plan.fetched_url } : {}),
    dataset, dataset_exists: datasetExists, level: plan.level,
    entries_in_list: plan.entries, dropped_by_filter: plan.filtered, importable: plan.rows.length,
    not_postable: plan.incomplete.length, ...(plan.incomplete.length ? { not_postable_sample: plan.incomplete.slice(0, 5) } : {}),
    fill_pct: plan.fill, post_requires: describePostRequires(plan.requires),
    samples: plan.rows.slice(0, sample).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)]))),
    ...(plan.license_hint ? { license_hint: plan.license_hint } : {}),
    // A paged API: the counts above are of the page that was read; Apply reads `pages_to_read` pages.
    ...(paging ? { pages: { counts_are_of: 'the first page', kind: paging.kind, pages_total: paging.pages_total, records_total: paging.records_total, pages_to_read: paging.pages_to_read } } : {}),
    ...(plan.notes.length || paging?.notes.length ? { notes: [...plan.notes, ...(paging?.notes ?? [])] } : {}),
  };
}

export function payloadOf(plan: ImportPlan, dataset: string, pages?: number): ImportPayload {
  return {
    url: plan.url, dataset, level: plan.level, mapping: plan.mapping, ...(plan.filter ? { filter: plan.filter } : {}),
    required: plan.required, new_schema: plan.newSchema, ...(pages !== undefined ? { pages } : {}), expected: plan.rows.length,
  };
}

/** The owner-facing line of the card. */
export function summaryOf(plan: ImportPlan, dataset: string, exists: boolean, paging?: PagingPreview | null): string {
  const many = paging && paging.pages_to_read > 1;
  const head = many
    ? `Import about ${plan.rows.length * paging.pages_to_read} entries (${plan.rows.length} on the first page, up to ${paging.pages_to_read} pages) from ${plan.url} into ${exists ? 'dataset' : 'a new dataset'} “${dataset}”`
    : `Import ${plan.rows.length} entries from ${plan.url} into ${exists ? 'dataset' : 'a new dataset'} “${dataset}”`;
  const parts = [
    plan.incomplete.length ? `${plan.incomplete.length} not postable and skipped (${describePostRequires(plan.requires).join(', ')} missing)` : '',
    plan.filtered ? `${plan.filtered} dropped by the filter` : '',
    'Undo is on the dataset page.',
  ].filter(Boolean);
  return `${head}. ${parts.join('. ')}`.slice(0, 1900);
}

// ── Apply and re-sync ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportDeps {
  pool:     Pool;
  docs:     DocStore;
  http?:    { lookup?: Lookup; get?: RawGet };
  hosts?:   HostFailures;
  sources?: CardSource[];
  /** Settings (IMPORT_MAX_PAGES, IMPORT_MAX_ROWS); `process.env` when not given. */
  env?:     (key: string) => string | undefined;
  /** Pause between the pages of a paged JSON API (default 500 ms; tests pass 0). */
  pageDelayMs?: number;
}

export interface ImportResult {
  dataset:           string;
  import_id:         string | null;
  created_dataset:   boolean;
  inserted:          number;
  updated:           number;
  skipped:           number;
  invalid:           number;
  not_postable:      number;
  errors?:           unknown[];
  /** A paged JSON API: how many pages were read, and why reading stopped when it was not the last page. */
  pages_read?:       number;
  pages_total?:      number | null;
  stopped?:          string;
  /** Why the page that stopped the run failed (`status 429`). */
  failure?:          string;
  /** Owner-facing line when the run did not reach the end of the list («прочитано 12 з 30 сторінок: status 429»). */
  note?:             string;
}

/** Stored on the import row so a re-sync can run the same extraction again. */
interface ListImportOptions { url: string; level: number; mapping: Record<string, string>; filter?: ListFilter; required: PostRequires; pages?: number; auto_resync: boolean }

const argsOf = (p: ImportPayload): PlanArgs => ({ dataset: p.dataset, mapping: p.mapping, level: p.level, filter: p.filter, required: p.required });

/** Which of these list refs the dataset already holds. */
async function knownRefs(pool: Pick<Pool, 'query'>, dataset: string, refs: string[]): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT d.data->>'list_ref' AS ref FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE s.key = $1 AND d.data->>'list_ref' = ANY($2::text[])`, [dataset, refs]);
  return new Set(rows.map((r: { ref: string }) => r.ref));
}

/**
 * The Apply of an import card, and the body of a re-sync: fetch the page (again, for a re-sync), extract with the stored
 * mapping, create the dataset when it is missing, write the rows as one undoable import. A paged JSON API is read page
 * by page (see `readPages`); an `incremental` run (the re-sync) stops after the first page that adds nothing new.
 */
export async function runImport(d: ImportDeps, p: ImportPayload, by: string, o: { fresh?: boolean; autoResync?: boolean; incremental?: boolean } = {}): Promise<ImportResult> {
  const fetched = await fetchDocument(p.url, { docs: d.docs, http: d.http, hosts: d.hosts, sources: d.sources, fresh: o.fresh });
  if (isFetchFailure(fetched)) throw new Error(`${fetched.error}: ${fetched.details}`);
  const store = new DataStore(d.pool);
  let schema = await store.getSchema(p.dataset);
  let created = false;
  if (!schema) {
    if (!p.new_schema) throw new Error(`dataset "${p.dataset}" no longer exists`);
    schema = await store.createSchema(p.new_schema, by);
    created = true;
  }
  const doc = fetched.doc;
  const caps = importCaps(d.env);
  let plan: ImportPlan;
  try {
    let src: Parameters<typeof buildPlan>[3] = {};
    if (doc.kind === 'json' && doc.json?.records.length) {
      const dataset = schema;
      const { records, paging } = await readPages(doc, { http: d.http, hosts: d.hosts, sources: d.sources }, {
        pages: p.pages, caps, delayMs: d.pageDelayMs ?? PAGE_DELAY_MS,
        measure: (recs) => {
          const page = buildPlan(doc, argsOf(p), dataset, { records: recs });
          return { kept: page.entries - page.filtered, refs: page.rows.map((r) => r.list_ref).filter((r): r is string => typeof r === 'string') };
        },
        ...(o.incremental ? { known: (refs: string[]) => knownRefs(d.pool, p.dataset, refs) } : {}),
      });
      src = { records, paging };
    }
    plan = buildPlan(doc, argsOf(p), schema, src);
    // The cap is on kept entries: a page that crossed it is cut back to exactly that many.
    if (plan.paging?.stopped === 'max_rows' && plan.rows.length > caps.maxRows) plan.rows = plan.rows.slice(0, caps.maxRows);
  } catch (err) {
    if (err instanceof PlanError) throw new Error(`${err.code}: ${err.message}`);
    throw err;
  }
  const paging = plan.paging;
  const pagingOut = paging ? { pages_read: paging.pages_read, pages_total: paging.pages_total, stopped: paging.stopped, ...(paging.failure ? { failure: paging.failure } : {}), ...(pagingNote(paging, { pages: p.pages, caps }) ? { note: pagingNote(paging, { pages: p.pages, caps })! } : {}) } : {};
  if (!plan.rows.length) return { dataset: p.dataset, import_id: null, created_dataset: created, inserted: 0, updated: 0, skipped: 0, invalid: 0, not_postable: plan.incomplete.length, ...pagingOut };

  const report = await new DataImportService(d.pool).importRows(p.dataset, plan.rows, { createdBy: by });
  const options: ListImportOptions = {
    url: p.url, level: plan.level, mapping: plan.mapping, ...(plan.filter ? { filter: plan.filter } : {}), required: p.required,
    ...(p.pages !== undefined ? { pages: p.pages } : {}), auto_resync: o.autoResync ?? true,
  };
  const changed = (report.inserted ?? 0) + (report.updated ?? 0);
  if (!changed && report.import_id && !created) {
    // A re-sync that found nothing new leaves no import row behind.
    await d.pool.query(`DELETE FROM data_imports WHERE id = $1 AND inserted = 0 AND updated = 0`, [report.import_id]);
  } else if (report.import_id) {
    await d.pool.query(`UPDATE data_imports SET options = options || $2::jsonb WHERE id = $1`, [report.import_id, JSON.stringify({ list_import: options })]);
  }
  return {
    dataset: p.dataset, import_id: changed || created ? report.import_id : null, created_dataset: created,
    inserted: report.inserted ?? 0, updated: report.updated ?? 0, skipped: report.skipped ?? 0, invalid: report.invalid,
    not_postable: plan.incomplete.length, ...(report.errors.length ? { errors: report.errors.slice(0, 5) } : {}), ...pagingOut,
  };
}

export interface StoredListImport { import_id: string; dataset: string; options: ListImportOptions }

/** The latest committed list import of a dataset, or of every dataset that has one (the weekly job). */
export async function listImports(pool: Pick<Pool, 'query'>, dataset?: string): Promise<StoredListImport[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (s.key) i.id AS import_id, s.key AS dataset, i.options -> 'list_import' AS options
       FROM data_imports i JOIN data_schemas s ON s.id = i.schema_id
      WHERE i.status = 'committed' AND i.options ? 'list_import' AND ($1::text IS NULL OR s.key = $1) AND s.status <> 'archived'
      ORDER BY s.key, i.created_at DESC`, [dataset ?? null]);
  return rows.map((r: any) => ({ import_id: r.import_id, dataset: r.dataset, options: r.options }));
}

/** Re-read the list of a dataset and add its new or changed entries (a new undoable import; none when nothing changed). A paged source is read from page 1 until a page adds nothing new. */
export async function resyncDataset(d: ImportDeps, li: StoredListImport, by: string): Promise<ImportResult> {
  const o = li.options;
  return runImport(d, {
    url: o.url, dataset: li.dataset, level: o.level, mapping: o.mapping, filter: o.filter, required: o.required, ...(o.pages !== undefined ? { pages: o.pages } : {}),
    new_schema: null, expected: 0,
  }, by, { fresh: true, autoResync: o.auto_resync, incremental: true });
}
