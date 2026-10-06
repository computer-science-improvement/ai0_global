import type { Pool, PoolClient } from 'pg';
import type { DataSchema, SchemaInput, SchemaPatch, UpsertResult } from './data.types';
import { schemaInputSchema, schemaPatchSchema } from './data.types';
import { compileRowSchema, validateRow, type RowIssue } from './field-validation';
import { diffSchemas, type SchemaDiff } from './schema-versioning';

/**
 * The automation side of the unified data store (spec 032). A thin wrapper around the SQL write path
 * `data_items_upsert()`: it validates rows strictly with a zod schema compiled from the dataset's fields,
 * sends them in batches and sums the reports. Schema edits go through here so who/why reach
 * `data_schema_versions`.
 *
 * No content table is ever named here: everything is addressed by schema key.
 */

export const UPSERT_BATCH = 1000;

export class DataStoreError extends Error {
  constructor(readonly code: 'not_found' | 'invalid' | 'conflict', message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface UpsertOptions {
  importId?:     string | null;
  /** Merge only these fields into existing rows ([] = never touch existing rows; undefined = all given fields). */
  updateFields?: string[] | null;
  /** Validate with zod before calling SQL (default true). */
  validate?:     boolean;
  /** Rows are partial updates of existing rows (patch-mode validation). */
  partial?:      boolean;
}

export interface StoreUpsertResult extends UpsertResult {
  /** Rows rejected by the zod pre-check (they never reach SQL). */
  rejected: RowIssue[];
}

type Queryable = Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>;

export interface SchemaListStats {
  rows:             number;
  rows_active:      number;
  last_import_at:   string | null;
  unposted_network: number | null;
  today_items:      number | null;
  stats_at:         string | null;
}

const SCHEMA_COLUMNS = `id, key, title, description, entity, version, fields, roles, dedup_key, language, default_license,
  reuse_policy, suitable_for, contains_personal_data, legacy, status, created_by, created_at, updated_at`;

export class DataStore {
  constructor(private readonly pool: Queryable) {}

  /**
   * Every dataset with live row counts and the catalog stats (`data_schema_stats`, refreshed after each
   * import and nightly): unposted rows network-wide, today's rows, when the stats were computed.
   */
  async listSchemas(): Promise<Array<DataSchema & SchemaListStats>> {
    const { rows } = await this.pool.query(
      `SELECT ${SCHEMA_COLUMNS.split(',').map((c) => 's.' + c.trim()).join(', ')},
              COALESCE(c.rows, 0)::int AS rows, COALESCE(c.active, 0)::int AS rows_active,
              (SELECT max(created_at) FROM data_imports i WHERE i.schema_id = s.id AND i.status = 'committed') AS last_import_at,
              st.unposted_network::int AS unposted_network, st.today_items::int AS today_items, st.computed_at AS stats_at
         FROM data_schemas s
         LEFT JOIN (SELECT schema_id, count(*) AS rows, count(*) FILTER (WHERE status = 'active') AS active
                      FROM data_items GROUP BY schema_id) c ON c.schema_id = s.id
         LEFT JOIN data_schema_stats st ON st.schema_id = s.id
        ORDER BY s.key`);
    return rows;
  }

  /** Hide or unhide one row (hidden rows are never offered to agents). */
  async setItemStatus(key: string, id: string, status: 'active' | 'hidden'): Promise<{ id: string; status: string }> {
    const schema = await this.requireSchema(key);
    if (!/^\d{1,18}$/.test(id)) throw new DataStoreError('not_found', `row ${id} not found in "${key}"`);
    const { rows } = await this.pool.query(
      `UPDATE data_items SET status = $3, updated_at = now() WHERE schema_id = $1 AND id = $2::bigint RETURNING id::text AS id, status`,
      [schema.id, id, status]);
    if (!rows[0]) throw new DataStoreError('not_found', `row ${id} not found in "${key}"`);
    return rows[0];
  }

  /** Recompute `data_schema_stats` for one dataset or all of them; returns how many were refreshed. */
  async refreshStats(key?: string): Promise<number> {
    const id = key ? (await this.requireSchema(key)).id : null;
    const { rows } = await this.pool.query(`SELECT data_schema_stats_refresh($1::uuid) AS n`, [id]);
    return Number(rows[0]?.n ?? 0);
  }

  async getSchema(key: string): Promise<DataSchema | null> {
    const { rows } = await this.pool.query(`SELECT ${SCHEMA_COLUMNS} FROM data_schemas WHERE key = $1`, [key]);
    return rows[0] ?? null;
  }

  async requireSchema(key: string): Promise<DataSchema> {
    const s = await this.getSchema(key);
    if (!s) throw new DataStoreError('not_found', `unknown dataset "${key}"`);
    return s;
  }

  /** Fields of a schema as they were at `version` (imports pin the version they started with). */
  async fieldsAtVersion(schema: DataSchema, version: number): Promise<DataSchema['fields']> {
    if (version === schema.version) return schema.fields;
    const { rows } = await this.pool.query(
      `SELECT fields FROM data_schema_versions WHERE schema_id = $1 AND version = $2`, [schema.id, version]);
    return rows[0]?.fields ?? schema.fields;
  }

  async createSchema(input: SchemaInput, createdBy: string): Promise<DataSchema> {
    const parsed = schemaInputSchema.safeParse(input);
    if (!parsed.success) throw new DataStoreError('invalid', 'invalid dataset definition', parsed.error.issues);
    const s = parsed.data;
    if (await this.getSchema(s.key)) throw new DataStoreError('conflict', `dataset "${s.key}" already exists`);
    return this.withSession(createdBy, 'created', async (c) => {
      const { rows } = await c.query(
        `INSERT INTO data_schemas (key, title, description, entity, fields, roles, dedup_key, language, default_license,
                                   reuse_policy, suitable_for, contains_personal_data, status, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8, $9, $10::jsonb, $11, $12, $13, $14)
         RETURNING ${SCHEMA_COLUMNS}`,
        [s.key, s.title, s.description, s.entity, JSON.stringify(s.fields), JSON.stringify(s.roles), s.dedup_key,
         s.language ?? null, s.default_license, JSON.stringify(s.reuse_policy), s.suitable_for,
         s.contains_personal_data, s.status, createdBy]);
      return rows[0];
    });
  }

  /** What saving `patch` would do: the version bump and how many rows keep an older version. */
  async previewSchemaEdit(key: string, patch: SchemaPatch): Promise<SchemaDiff & { rows: number; rows_on_older_version: number }> {
    const prev = await this.requireSchema(key);
    const next = { ...prev, ...patch } as DataSchema;
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS rows FROM data_items WHERE schema_id = $1`, [prev.id]);
    const total = rows[0]?.rows ?? 0;
    const diff = diffSchemas(prev, next, { hasRows: total > 0 });
    return { ...diff, rows: total, rows_on_older_version: diff.structural ? total : 0 };
  }

  async updateSchema(key: string, patch: SchemaPatch, meta: { changedBy: string; reason?: string }): Promise<{ schema: DataSchema; diff: SchemaDiff }> {
    const parsed = schemaPatchSchema.safeParse(patch);
    if (!parsed.success) throw new DataStoreError('invalid', 'invalid dataset edit', parsed.error.issues);
    const preview = await this.previewSchemaEdit(key, parsed.data);
    if (preview.errors.length) throw new DataStoreError('invalid', preview.errors[0], preview.errors);
    const p = parsed.data;
    const sets: string[] = [];
    const params: unknown[] = [key];
    const add = (col: string, v: unknown, cast = '') => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
    if (p.title !== undefined) add('title', p.title);
    if (p.description !== undefined) add('description', p.description);
    if (p.entity !== undefined) add('entity', p.entity);
    if (p.fields !== undefined) add('fields', JSON.stringify(p.fields), '::jsonb');
    if (p.roles !== undefined) add('roles', JSON.stringify(p.roles), '::jsonb');
    if (p.dedup_key !== undefined) add('dedup_key', p.dedup_key, '::text[]');
    if (p.language !== undefined) add('language', p.language);
    if (p.default_license !== undefined) add('default_license', p.default_license);
    if (p.reuse_policy !== undefined) add('reuse_policy', JSON.stringify(p.reuse_policy), '::jsonb');
    if (p.suitable_for !== undefined) add('suitable_for', p.suitable_for);
    if (p.contains_personal_data !== undefined) add('contains_personal_data', p.contains_personal_data);
    if (p.status !== undefined) add('status', p.status);
    if (!sets.length) return { schema: await this.requireSchema(key), diff: preview };
    const schema = await this.withSession(meta.changedBy, meta.reason ?? null, async (c) => {
      const { rows } = await c.query(`UPDATE data_schemas SET ${sets.join(', ')} WHERE key = $1 RETURNING ${SCHEMA_COLUMNS}`, params);
      return rows[0];
    });
    return { schema, diff: preview };
  }

  /**
   * Insert or merge rows (see `data_items_upsert()`): validated with zod first, then sent in batches.
   * Rows the zod check rejects are reported in `rejected` (row numbers index the input array).
   */
  async upsert(key: string, rows: Record<string, unknown>[], opts: UpsertOptions = {}): Promise<StoreUpsertResult> {
    const schema = await this.requireSchema(key);
    const rejected: RowIssue[] = [];
    let good: Array<{ row: Record<string, unknown>; n: number }> = rows.map((row, n) => ({ row, n }));
    if (opts.validate !== false) {
      const z = compileRowSchema(schema.fields, { mode: opts.partial ? 'patch' : 'insert', emptyAsNull: false });
      good = [];
      rows.forEach((row, n) => {
        const { _legacy_ref, _posted, ...rest } = row as Record<string, unknown>;
        const r = validateRow(z, rest, n);
        if (r.ok) good.push({ row: { ...r.value, ...(_legacy_ref ? { _legacy_ref } : {}), ...(_posted ? { _posted } : {}) }, n });
        else rejected.push(...r.issues);
      });
    }
    const total: StoreUpsertResult = { inserted: 0, updated: 0, skipped: 0, invalid: [], invalid_rows: 0, rejected };
    for (let i = 0; i < good.length; i += UPSERT_BATCH) {
      const batch = good.slice(i, i + UPSERT_BATCH);
      const res = await this.callUpsert(key, batch.map((b) => b.row), opts);
      total.inserted += res.inserted;
      total.updated += res.updated;
      total.skipped += res.skipped;
      total.invalid_rows += res.invalid_rows;
      for (const e of res.invalid) total.invalid.push({ ...e, row: batch[e.row]?.n ?? e.row });
    }
    total.invalid_rows += new Set(rejected.map((r) => r.row)).size;
    return total;
  }

  /** Raw call of the SQL write path (no zod); rows are already normalised. */
  async callUpsert(key: string, rows: Record<string, unknown>[], opts: Pick<UpsertOptions, 'importId' | 'updateFields'> = {}): Promise<UpsertResult> {
    const { rows: out } = await this.pool.query(
      `SELECT data_items_upsert($1, $2::jsonb, $3::uuid, $4::text[]) AS r`,
      [key, JSON.stringify(rows), opts.importId ?? null, opts.updateFields ?? null]);
    return out[0].r as UpsertResult;
  }

  /**
   * Update some fields of one existing row addressed by its legacy ref (`library://<table>/<id>`), e.g.
   * a recipe's translation or Telegraph page. Returns false when the row does not exist.
   */
  async patchByLegacyRef(key: string, legacyRef: string, fields: Record<string, unknown>): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM data_items WHERE legacy_ref = $1`, [legacyRef]);
    if (!rows.length) return false;
    const res = await this.upsert(key, [{ ...fields, _legacy_ref: legacyRef }], { partial: true, updateFields: Object.keys(fields) });
    const issues = [...res.rejected, ...res.invalid];
    if (issues.length) throw new DataStoreError('invalid', `${key}: ${issues.map((i) => `${i.field ?? 'row'} ${i.error}`).join('; ')}`, issues);
    return true;
  }

  private async withSession<T>(changedBy: string, reason: string | null, fn: (c: Pick<PoolClient, 'query'>) => Promise<T>): Promise<T> {
    if (!this.pool.connect) return fn(this.pool as Pick<PoolClient, 'query'>);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('data_store.changed_by', $1, true), set_config('data_store.reason', $2, true)`, [changedBy, reason ?? '']);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
