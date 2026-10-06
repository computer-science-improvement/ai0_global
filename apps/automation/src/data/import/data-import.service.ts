import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Pool } from 'pg';
import { DataStore, DataStoreError } from '../data-store';
import type { DataSchema, FieldDef, Roles } from '../data.types';
import { compileRowSchema, validateRow } from '../field-validation';
import { autoMapColumns, inferSchemaDraft, INFER_SAMPLE, type SchemaDraft } from './type-inference';
import { detectFormat, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, readSourceRows, type ImportFormat, type ReadResult } from './source-reader';

/**
 * CSV / JSON / JSONL imports into a dataset (spec 032 FR-006):
 *   infer   → a draft schema from a 500-row sample (new datasets);
 *   dryRun  → map columns to fields, validate every row against the schema version pinned now, count
 *             new / updated / invalid / duplicate rows, keep the first 100 errors and 10 preview rows
 *             rendered through the roles; the file is parked for the commit;
 *   commit  → the same rows, deduplicated (last row wins), through data_items_upsert() with the import id;
 *   undo    → deletes the rows the import inserted that were never used, hides the used ones, restores
 *             the rows it updated from their snapshots;
 *   rows    → the same pipeline for a JSON array posted by a script (≤ 5 000 rows).
 * Every import is audited in data_imports. All texts are English (owner decision 2026-10-06).
 */

export const MAX_API_ROWS = 5000;
const ERROR_LIMIT = 100;
const PREVIEW_LIMIT = 10;
const KEY_BATCH = 1000;
const PARK_TTL_MS = 24 * 3600_000;

export interface ImportIssue { row: number; line?: number; field: string | null; error: string }

export interface PreviewRow {
  row: number; title: string | null; body: string | null; image_url: string | null; url: string | null;
  category: string | null; date: string | null; data: Record<string, unknown>;
}

export interface ImportReport {
  import_id:      string;
  status:         string;
  schema:         string;
  schema_version: number;
  source:         string;
  filename:       string | null;
  delimiter?:     string;
  columns:        string[];
  mapping:        Record<string, string | null>;
  rows_total:     number;
  valid:          number;
  invalid:        number;
  new:            number;
  updated:        number;
  duplicates:     number;
  inserted?:      number;
  skipped?:       number;
  errors:         ImportIssue[];
  preview:        PreviewRow[];
}

export interface DryRunInput {
  schemaKey: string;
  file:      { buffer: Buffer; filename?: string };
  format?:   ImportFormat;
  /** Source column → field name (null = not imported). Columns not listed are matched by name. */
  mapping?:  Record<string, string | null>;
  /** Unmapped columns: dropped (default) or kept under data._extra. */
  extra?:    'ignore' | 'keep';
  createdBy: string;
}

interface Analysis {
  meta:       ReadResult;
  mapping:    Record<string, string | null>;
  rowsTotal:  number;
  errors:     ImportIssue[];
  invalidRows: Set<number>;
  /** Valid rows after in-file dedup (last wins), in file order. */
  rows:       Array<{ row: number; line?: number; data: Record<string, unknown>; exists: boolean }>;
  duplicates: number;
  filename:   string | null;
}

const str = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** One row rendered through the dataset roles (the same rule as the SQL envelope: first non-blank wins). */
export function renderThroughRoles(roles: Roles, data: Record<string, unknown>): Omit<PreviewRow, 'row' | 'data'> {
  const pick = (role: keyof Roles) => {
    const v = roles[role];
    for (const f of Array.isArray(v) ? v : v ? [v] : []) {
      const s = str(data[f]);
      if (s !== null && s.trim() !== '') return s;
    }
    return null;
  };
  const body = pick('body');
  return {
    title: pick('title'), body: body && body.length > 300 ? `${body.slice(0, 300)}…` : body,
    image_url: pick('image'), url: pick('url'), category: pick('category'), date: pick('date') ?? pick('month_day'),
  };
}

export class DataImportService {
  readonly store: DataStore;

  constructor(private readonly pool: Pool, private readonly parkDir = process.env.DATA_IMPORT_DIR || join(tmpdir(), 'ai0-data-imports')) {
    this.store = new DataStore(pool);
  }

  // ─── infer ────────────────────────────────────────────────────────────────

  async infer(file: { buffer: Buffer; filename?: string }, format?: ImportFormat): Promise<SchemaDraft & { format: ImportFormat; columns: string[]; rows_sampled: number; delimiter?: string; errors: ImportIssue[] }> {
    this.checkSize(file.buffer);
    const fmt = format ?? detectFormat(file.filename, file.buffer);
    const meta: ReadResult = { columns: [] };
    const sample: Record<string, unknown>[] = [];
    const errors: ImportIssue[] = [];
    for await (const r of readSourceRows(file.buffer, fmt, meta)) {
      if (r.error) { if (errors.length < 20) errors.push({ row: r.row, line: r.line, field: null, error: r.error }); continue; }
      sample.push(r.value!);
      if (sample.length >= INFER_SAMPLE) break;
    }
    if (meta.fatal) throw new DataStoreError('invalid', meta.fatal);
    const draft = inferSchemaDraft(meta.columns, sample);
    return { ...draft, format: fmt, columns: meta.columns, rows_sampled: sample.length, delimiter: meta.delimiter, errors };
  }

  // ─── dry run / commit ─────────────────────────────────────────────────────

  async dryRun(input: DryRunInput): Promise<ImportReport> {
    this.checkSize(input.file.buffer);
    const schema = await this.store.requireSchema(input.schemaKey);
    if (schema.status === 'archived') throw new DataStoreError('invalid', `dataset "${schema.key}" is archived`);
    const format = input.format ?? detectFormat(input.file.filename, input.file.buffer);
    this.checkMapping(schema.fields, input.mapping);
    const a = await this.analyse(schema, schema.fields, input.file.buffer, format, input.mapping, input.extra ?? 'ignore');
    a.filename = input.file.filename ?? null;
    const { rows } = await this.pool.query(
      `INSERT INTO data_imports (schema_id, schema_version, source, filename, mapping, options, rows_total, invalid, duplicates,
                                 errors, preview, status, created_by, finished_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb, 'dry_run', $12, now())
       RETURNING id`,
      [schema.id, schema.version, format, input.file.filename ?? null, JSON.stringify(a.mapping),
       JSON.stringify({ format, extra: input.extra ?? 'ignore', delimiter: a.meta.delimiter ?? null,
                        valid: a.rows.length, new: a.rows.filter((r) => !r.exists).length, updated: a.rows.filter((r) => r.exists).length }),
       a.rowsTotal, a.invalidRows.size, a.duplicates, JSON.stringify(a.errors), JSON.stringify(this.preview(schema, a)),
       input.createdBy]);
    const id = rows[0].id as string;
    await this.park(id, input.file.buffer);
    return this.report(id, schema, a, 'dry_run', format);
  }

  async commit(importId: string, by: string): Promise<ImportReport> {
    const imp = await this.getImportRow(importId);
    if (imp.status !== 'dry_run') throw new DataStoreError('conflict', `import ${importId} is ${imp.status}; only a dry run can be committed`);
    const buffer = await this.unpark(importId);
    if (!buffer) {
      await this.pool.query(`UPDATE data_imports SET status = 'expired' WHERE id = $1`, [importId]);
      throw new DataStoreError('conflict', 'the uploaded file has expired; run the dry run again');
    }
    const claimed = await this.pool.query(`UPDATE data_imports SET status = 'running' WHERE id = $1 AND status = 'dry_run'`, [importId]);
    if (!claimed.rowCount) throw new DataStoreError('conflict', `import ${importId} is already being committed`);
    const schema = await this.store.requireSchema(imp.schema_key);
    const fields = await this.store.fieldsAtVersion(schema, imp.schema_version);   // pinned at the dry run
    try {
      const a = await this.analyse({ ...schema, fields }, fields, buffer, imp.options.format, imp.mapping, imp.options.extra);
      a.filename = imp.filename;
      const res = { inserted: 0, updated: 0, skipped: 0 };
      const sqlErrors: ImportIssue[] = [];
      let sqlInvalid = 0;
      for (let i = 0; i < a.rows.length; i += KEY_BATCH) {
        const batch = a.rows.slice(i, i + KEY_BATCH);
        const r = await this.store.callUpsert(schema.key, batch.map((b) => b.data), { importId, updateFields: null });
        res.inserted += r.inserted; res.updated += r.updated; res.skipped += r.skipped;
        sqlInvalid += r.invalid_rows;
        for (const e of r.invalid) sqlErrors.push({ ...e, row: batch[e.row]?.row ?? e.row, line: batch[e.row]?.line });
      }
      const errors = [...a.errors, ...sqlErrors].slice(0, ERROR_LIMIT);
      await this.pool.query(
        `UPDATE data_imports SET status = 'committed', finished_at = now(), rows_total = $2, inserted = $3, updated = $4,
                skipped = $5, invalid = $6, duplicates = $7, errors = $8::jsonb,
                created_by = COALESCE(created_by, $9)
          WHERE id = $1`,
        [importId, a.rowsTotal, res.inserted, res.updated, res.skipped, a.invalidRows.size + sqlInvalid, a.duplicates, JSON.stringify(errors), by]);
      await this.pool.query(`SELECT data_schema_stats_refresh($1)`, [schema.id]);
      await this.discard(importId);
      const report = this.report(importId, schema, a, 'committed', imp.source);
      return { ...report, inserted: res.inserted, updated: res.updated, skipped: res.skipped, invalid: a.invalidRows.size + sqlInvalid, errors };
    } catch (err: any) {
      await this.pool.query(`UPDATE data_imports SET status = 'failed', finished_at = now(), errors = $2::jsonb WHERE id = $1`,
        [importId, JSON.stringify([{ row: 0, field: null, error: String(err?.message ?? err).slice(0, 500) }])]);
      throw err;
    }
  }

  // ─── rows API ─────────────────────────────────────────────────────────────

  async importRows(schemaKey: string, rows: unknown[], opts: { dryRun?: boolean; createdBy: string }): Promise<ImportReport> {
    if (!Array.isArray(rows)) throw new DataStoreError('invalid', 'the body must be a JSON array of objects');
    if (rows.length > MAX_API_ROWS) throw new DataStoreError('invalid', `at most ${MAX_API_ROWS} rows per request`);
    const schema = await this.store.requireSchema(schemaKey);
    if (schema.status === 'archived') throw new DataStoreError('invalid', `dataset "${schema.key}" is archived`);
    const z = compileRowSchema(schema.fields, { emptyAsNull: false });
    const errors: ImportIssue[] = [];
    const invalidRows = new Set<number>();
    const valid: Array<{ row: number; data: Record<string, unknown> }> = [];
    rows.forEach((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) { invalidRows.add(i + 1); this.pushError(errors, { row: i + 1, field: null, error: 'row is not a JSON object' }); return; }
      const v = validateRow(z, r, i + 1);
      if (v.ok) valid.push({ row: i + 1, data: v.value });
      else { invalidRows.add(i + 1); for (const e of v.issues) this.pushError(errors, e); }
    });
    const a: Analysis = { meta: { columns: [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))] },
      mapping: {}, rowsTotal: rows.length, errors, invalidRows, rows: [], duplicates: 0, filename: null };
    a.mapping = Object.fromEntries(a.meta.columns.map((c) => [c, schema.fields.some((f) => f.name === c) ? c : null]));
    await this.resolveKeys(schema, valid, a);
    if (opts.dryRun) return this.report('', schema, a, 'dry_run', 'api');

    const { rows: imp } = await this.pool.query(
      `INSERT INTO data_imports (schema_id, schema_version, source, mapping, rows_total, duplicates, status, created_by)
       VALUES ($1, $2, 'api', $3::jsonb, $4, $5, 'running', $6) RETURNING id`,
      [schema.id, schema.version, JSON.stringify(a.mapping), rows.length, a.duplicates, opts.createdBy]);
    const importId = imp[0].id as string;
    const res = { inserted: 0, updated: 0, skipped: 0 };
    let sqlInvalid = 0;
    for (let i = 0; i < a.rows.length; i += KEY_BATCH) {
      const batch = a.rows.slice(i, i + KEY_BATCH);
      const r = await this.store.callUpsert(schema.key, batch.map((b) => b.data), { importId, updateFields: null });
      res.inserted += r.inserted; res.updated += r.updated; res.skipped += r.skipped; sqlInvalid += r.invalid_rows;
      for (const e of r.invalid) this.pushError(errors, { ...e, row: batch[e.row]?.row ?? e.row });
    }
    await this.pool.query(
      `UPDATE data_imports SET status = 'committed', finished_at = now(), inserted = $2, updated = $3, skipped = $4,
              invalid = $5, errors = $6::jsonb WHERE id = $1`,
      [importId, res.inserted, res.updated, res.skipped, invalidRows.size + sqlInvalid, JSON.stringify(errors)]);
    await this.pool.query(`SELECT data_schema_stats_refresh($1)`, [schema.id]);
    return { ...this.report(importId, schema, a, 'committed', 'api'), ...res, invalid: invalidRows.size + sqlInvalid, errors };
  }

  // ─── undo ─────────────────────────────────────────────────────────────────

  async undo(importId: string, by: string): Promise<{ import_id: string; deleted: number; hidden: number; restored: number }> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(
        `SELECT i.*, s.key AS schema_key FROM data_imports i JOIN data_schemas s ON s.id = i.schema_id WHERE i.id = $1 FOR UPDATE OF i`, [importId]);
      const imp = rows[0];
      if (!imp) throw new DataStoreError('not_found', `import ${importId} not found`);
      if (imp.status !== 'committed') throw new DataStoreError('conflict', `import ${importId} is ${imp.status}; only a committed import can be undone`);
      const later = await c.query(
        `SELECT l.id FROM data_imports l
          WHERE l.schema_id = $2 AND l.created_at > $3 AND l.status = 'committed' AND l.id <> $1
            AND EXISTS (SELECT 1 FROM data_import_snapshots s
                         WHERE s.import_id = l.id
                           AND (s.item_id IN (SELECT id FROM data_items WHERE import_id = $1)
                                OR s.item_id IN (SELECT item_id FROM data_import_snapshots WHERE import_id = $1)))
          LIMIT 1`, [importId, imp.schema_id, imp.created_at]);
      if (later.rows.length) throw new DataStoreError('conflict', `a later import (${later.rows[0].id}) changed the same rows; undo it first`);

      const hidden = await c.query(
        `UPDATE data_items d SET status = 'hidden'
          WHERE d.import_id = $1 AND d.status = 'active'
            AND (EXISTS (SELECT 1 FROM jsonb_object_keys(d.posted) k WHERE k NOT LIKE 'error:%')
                 OR EXISTS (SELECT 1 FROM published_posts pp
                             WHERE pp.source_url = 'data://' || $2::text || '/' || d.id OR pp.source_url = d.legacy_ref))`,
        [importId, imp.schema_key]);
      const deleted = await c.query(`DELETE FROM data_items WHERE import_id = $1 AND status = 'active'`, [importId]);
      const restored = await c.query(
        `UPDATE data_items d SET data = s.data, schema_version = s.schema_version
           FROM data_import_snapshots s
          WHERE s.import_id = $1 AND s.item_id = d.id AND d.import_id IS DISTINCT FROM $1`, [importId]);
      const report = { deleted: deleted.rowCount ?? 0, hidden: hidden.rowCount ?? 0, restored: restored.rowCount ?? 0, by };
      await c.query(`UPDATE data_imports SET status = 'undone', undone_at = now(), undo_report = $2::jsonb WHERE id = $1`,
        [importId, JSON.stringify(report)]);
      await c.query(`SELECT data_schema_stats_refresh($1)`, [imp.schema_id]);
      await c.query('COMMIT');
      return { import_id: importId, deleted: report.deleted, hidden: report.hidden, restored: report.restored };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  // ─── history ──────────────────────────────────────────────────────────────

  async listImports(schemaKey?: string, limit = 50): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT i.id, s.key AS schema, i.schema_version, i.source, i.filename, i.rows_total, i.inserted, i.updated, i.skipped,
              i.invalid, i.duplicates, i.status, i.created_by, i.created_at, i.finished_at, i.undone_at, i.undo_report
         FROM data_imports i JOIN data_schemas s ON s.id = i.schema_id
        WHERE ($1::text IS NULL OR s.key = $1)
        ORDER BY i.created_at DESC LIMIT $2`, [schemaKey ?? null, Math.min(Math.max(limit, 1), 200)]);
    return rows;
  }

  async getImport(id: string): Promise<any> {
    const { schema_key, ...rest } = await this.getImportRow(id);
    return { ...rest, schema: schema_key };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async getImportRow(id: string): Promise<any> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DataStoreError('not_found', `import ${id} not found`);
    const { rows } = await this.pool.query(
      `SELECT i.*, s.key AS schema_key FROM data_imports i JOIN data_schemas s ON s.id = i.schema_id WHERE i.id = $1`, [id]);
    if (!rows[0]) throw new DataStoreError('not_found', `import ${id} not found`);
    return rows[0];
  }

  private checkSize(buf: Buffer) {
    if (!buf?.length) throw new DataStoreError('invalid', 'the file is empty');
    if (buf.length > MAX_IMPORT_BYTES) throw new DataStoreError('invalid', `the file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  }

  private checkMapping(fields: FieldDef[], mapping?: Record<string, string | null>) {
    if (!mapping) return;
    const names = new Set(fields.map((f) => f.name));
    const targets = new Set<string>();
    for (const [col, f] of Object.entries(mapping)) {
      if (f === null || f === '') continue;
      if (!names.has(f)) throw new DataStoreError('invalid', `mapping: column "${col}" points to unknown field "${f}"`);
      if (targets.has(f)) throw new DataStoreError('invalid', `mapping: two columns point to field "${f}"`);
      targets.add(f);
    }
  }

  private pushError(errors: ImportIssue[], e: ImportIssue) {
    if (errors.length < ERROR_LIMIT) errors.push(e);
  }

  private async analyse(schema: DataSchema, fields: FieldDef[], buf: Buffer, format: ImportFormat,
    mappingIn: Record<string, string | null> | undefined, extra: 'ignore' | 'keep'): Promise<Analysis> {
    const meta: ReadResult = { columns: [] };
    const z = compileRowSchema(fields, { emptyAsNull: format === 'csv' });
    const errors: ImportIssue[] = [];
    const invalidRows = new Set<number>();
    const valid: Array<{ row: number; line?: number; data: Record<string, unknown> }> = [];
    const mapping: Record<string, string | null> = {};
    const explicitTargets = new Set(Object.values(mappingIn ?? {}).filter((f): f is string => Boolean(f)));
    let rowsTotal = 0;
    // A column maps to what the owner chose, else to the field with the same normalised name (once).
    const mapFor = (col: string): string | null => {
      if (!(col in mapping)) {
        if (mappingIn && col in mappingIn) mapping[col] = mappingIn[col] || null;
        else {
          const taken = new Set([...explicitTargets, ...Object.values(mapping).filter(Boolean)]);
          const auto = autoMapColumns([col], fields.filter((f) => !taken.has(f.name)))[col];
          mapping[col] = auto ?? null;
        }
      }
      return mapping[col];
    };
    for await (const r of readSourceRows(buf, format, meta)) {
      if (rowsTotal === 0) for (const c of meta.columns) mapFor(c);
      rowsTotal++;
      if (rowsTotal > MAX_IMPORT_ROWS) {
        this.pushError(errors, { row: r.row, line: r.line, field: null, error: `more than ${MAX_IMPORT_ROWS} rows; the rest of the file is ignored` });
        rowsTotal--;
        break;
      }
      if (r.error) { invalidRows.add(r.row); this.pushError(errors, { row: r.row, line: r.line, field: null, error: r.error }); continue; }
      const out: Record<string, unknown> = {};
      const extraCols: Record<string, unknown> = {};
      for (const [col, v] of Object.entries(r.value!)) {
        const f = mapFor(col);
        if (f) out[f] = v;
        else if (extra === 'keep' && v !== '' && v !== null && v !== undefined) extraCols[col] = v;
      }
      if (Object.keys(extraCols).length) out._extra = extraCols;
      const v = validateRow(z, out, r.row);
      if (v.ok) valid.push({ row: r.row, line: r.line, data: v.value });
      else { invalidRows.add(r.row); for (const e of v.issues) this.pushError(errors, { ...e, line: r.line }); }
    }
    if (meta.fatal) throw new DataStoreError('invalid', meta.fatal);
    for (const c of meta.columns) mapFor(c);
    const a: Analysis = { meta, mapping, rowsTotal, errors, invalidRows, rows: [], duplicates: 0, filename: null };
    await this.resolveKeys(schema, valid, a);
    return a;
  }

  /** External keys (computed by the database, the same way the write path does), dedup (last wins), existence. */
  private async resolveKeys(schema: DataSchema, valid: Array<{ row: number; line?: number; data: Record<string, unknown> }>, a: Analysis) {
    const byKey = new Map<string, number>();
    const keyed: Array<{ row: number; line?: number; data: Record<string, unknown>; exists: boolean; key: string | null }> = [];
    for (let i = 0; i < valid.length; i += KEY_BATCH) {
      const batch = valid.slice(i, i + KEY_BATCH);
      const { rows } = await this.pool.query(
        `SELECT row_no, external_key, item_exists FROM data_items_preview_keys($1, $2::jsonb)`, [schema.key, JSON.stringify(batch.map((b) => b.data))]);
      for (const k of rows) {
        const b = batch[k.row_no];
        if (k.external_key === null && schema.dedup_key.length) {
          a.invalidRows.add(b.row);
          this.pushError(a.errors, { row: b.row, line: b.line, field: schema.dedup_key[0], error: 'dedup key fields are empty' });
          continue;
        }
        keyed.push({ ...b, exists: Boolean(k.item_exists), key: k.external_key });
      }
    }
    const keep: boolean[] = keyed.map(() => true);
    keyed.forEach((r, i) => {
      if (r.key === null) return;
      const prev = byKey.get(r.key);
      if (prev !== undefined) { keep[prev] = false; a.duplicates++; }
      byKey.set(r.key, i);
    });
    a.rows = keyed.filter((_, i) => keep[i]).map(({ key: _k, ...r }) => r);
  }

  private preview(schema: DataSchema, a: Analysis): PreviewRow[] {
    return a.rows.slice(0, PREVIEW_LIMIT).map((r) => ({ row: r.row, ...renderThroughRoles(schema.roles, r.data), data: r.data }));
  }

  private report(id: string, schema: DataSchema, a: Analysis, status: string, source?: string): ImportReport {
    return {
      import_id: id, status, schema: schema.key, schema_version: schema.version, source: source ?? 'file',
      filename: a.filename, delimiter: a.meta.delimiter, columns: a.meta.columns, mapping: a.mapping,
      rows_total: a.rowsTotal, valid: a.rows.length + a.duplicates, invalid: a.invalidRows.size,
      new: a.rows.filter((r) => !r.exists).length, updated: a.rows.filter((r) => r.exists).length,
      duplicates: a.duplicates, errors: a.errors, preview: this.preview(schema, a),
    };
  }

  private async park(id: string, buf: Buffer) {
    await mkdir(this.parkDir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.parkDir, id), buf, { mode: 0o600 });
    // Sweep files older than a day.
    for (const f of await readdir(this.parkDir).catch(() => [] as string[])) {
      const p = join(this.parkDir, f);
      const s = await stat(p).catch(() => null);
      if (s && Date.now() - s.mtimeMs > PARK_TTL_MS) await rm(p, { force: true }).catch(() => undefined);
    }
  }

  private async unpark(id: string): Promise<Buffer | null> {
    const p = join(this.parkDir, id);
    const s = await stat(p).catch(() => null);
    if (!s || Date.now() - s.mtimeMs > PARK_TTL_MS) return null;
    return readFile(p);
  }

  private async discard(id: string) {
    await rm(join(this.parkDir, id), { force: true }).catch(() => undefined);
  }
}
