import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post,
  Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DB_POOL } from '../database/database.tokens';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { DataStore, DataStoreError } from './data-store';
import { DataQueryError, filterSchema, kyivMonthDay, ORDERS, queryDataset } from './data-query';
import { schemaInputSchema, schemaPatchSchema } from './data.types';
import { DataImportService, MAX_API_ROWS } from './import/data-import.service';
import { MAX_IMPORT_BYTES } from './import/source-reader';

/**
 * Data store API (spec 032 FR-006): datasets (schemas), CSV/JSON/JSONL imports with dry run, commit and
 * undo, and a rows endpoint for scripts. Owner-only, behind the same login as the dashboard.
 */

interface UploadedFileLike { buffer: Buffer; originalname?: string; size: number }

const formatSchema = z.enum(['csv', 'json', 'jsonl']);

function parseFormat(raw: unknown): 'csv' | 'json' | 'jsonl' | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const r = formatSchema.safeParse(raw);
  if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'format must be csv, json or jsonl' });
  return r.data;
}
const mappingSchema = z.record(z.string(), z.string().nullable());

const itemsQuerySchema = z.object({
  q:         z.string().max(200).optional(),
  filters:   z.string().max(8000).optional(),
  status:    z.enum(['active', 'hidden', 'all']).default('active'),
  order:     z.enum(ORDERS).default('newest'),
  page:      z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

function who(req: any): string {
  const u = req?.user;
  return u ? `owner:${u.username ?? u.sub ?? 'unknown'}` : 'owner';
}

function parseJsonField<T>(raw: unknown, schema: z.ZodType<T>, name: string): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { throw new BadRequestException({ code: 'invalid', message: `${name} must be JSON` }); }
  }
  const r = schema.safeParse(v);
  if (!r.success) throw new BadRequestException({ code: 'invalid', message: `invalid ${name}`, details: r.error.issues });
  return r.data;
}

/** DataStoreError and database guard errors → HTTP errors with English messages. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err instanceof DataQueryError) throw new BadRequestException({ code: err.code, message: err.message });
    if (err instanceof DataStoreError) {
      const body = { code: err.code, message: err.message, details: err.details };
      if (err.code === 'not_found') throw new NotFoundException(body);
      if (err.code === 'conflict') throw new ConflictException(body);
      throw new BadRequestException(body);
    }
    // RAISE EXCEPTION in the schema guard / write path (plpgsql) → a readable 400.
    if (err?.code === 'P0001' || err?.code === '23514' || err?.code === 'P0002') {
      throw new BadRequestException({ code: 'invalid', message: String(err.message) });
    }
    throw err;
  }
}

@Controller('api/data')
@UseGuards(TrackingAuthGuard)
export class DataController {
  private readonly store: DataStore;
  private readonly imports: DataImportService;

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {
    this.store = new DataStore(pool);
    this.imports = new DataImportService(pool);
  }

  // ─── datasets ──────────────────────────────────────────────────────────────

  @Get('schemas')
  listSchemas() {
    return run(() => this.store.listSchemas());
  }

  @Get('schemas/:key')
  async getSchema(@Param('key') key: string) {
    return run(() => this.store.requireSchema(key));
  }

  @Post('schemas')
  createSchema(@Body() body: unknown, @Req() req: any) {
    const r = schemaInputSchema.safeParse(body);
    if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'invalid dataset definition', details: r.error.issues });
    return run(() => this.store.createSchema(r.data, who(req)));
  }

  /** What an edit would do (version bump, rows on an older version) without saving it. */
  @Post('schemas/:key/preview')
  @HttpCode(200)
  previewSchema(@Param('key') key: string, @Body() body: unknown) {
    const r = schemaPatchSchema.safeParse(body);
    if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'invalid dataset edit', details: r.error.issues });
    return run(() => this.store.previewSchemaEdit(key, r.data));
  }

  @Patch('schemas/:key')
  updateSchema(@Param('key') key: string, @Body() body: any, @Req() req: any) {
    const { reason, ...patch } = (body ?? {}) as Record<string, unknown>;
    const r = schemaPatchSchema.safeParse(patch);
    if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'invalid dataset edit', details: r.error.issues });
    return run(() => this.store.updateSchema(key, r.data, { changedBy: who(req), reason: typeof reason === 'string' ? reason.slice(0, 500) : undefined }));
  }

  // ─── imports ───────────────────────────────────────────────────────────────

  /** Draft a new dataset from a file: inferred types, roles, dedup key and column mapping. */
  @Post('imports/infer')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  infer(@UploadedFile() file: UploadedFileLike, @Body() body: Record<string, unknown>) {
    if (!file) throw new BadRequestException({ code: 'invalid', message: 'attach the file as "file"' });
    const format = parseFormat(body?.format);
    return run(() => this.imports.infer({ buffer: file.buffer, filename: file.originalname }, format));
  }

  /** Upload + dry run. Fields: file, schema, mapping (JSON {column: field|null}), extra ('ignore'|'keep'), format. */
  @Post('imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  dryRun(@UploadedFile() file: UploadedFileLike, @Body() body: Record<string, unknown>, @Req() req: any) {
    if (!file) throw new BadRequestException({ code: 'invalid', message: 'attach the file as "file"' });
    const schemaKey = typeof body?.schema === 'string' ? body.schema : '';
    if (!schemaKey) throw new BadRequestException({ code: 'invalid', message: 'choose the dataset ("schema")' });
    const extra = body?.extra === 'keep' ? 'keep' : 'ignore';
    const format = parseFormat(body?.format);
    const mapping = parseJsonField(body?.mapping, mappingSchema, 'mapping');
    return run(() => this.imports.dryRun({
      schemaKey, file: { buffer: file.buffer, filename: file.originalname }, format, mapping, extra, createdBy: who(req),
    }));
  }

  @Post('imports/:id/commit')
  @HttpCode(200)
  commit(@Param('id') id: string, @Req() req: any) {
    return run(() => this.imports.commit(id, who(req)));
  }

  @Post('imports/:id/undo')
  @HttpCode(200)
  undo(@Param('id') id: string, @Req() req: any) {
    return run(() => this.imports.undo(id, who(req)));
  }

  @Get('imports')
  listImports(@Query('schema') schema?: string, @Query('limit') limit?: string) {
    return run(() => this.imports.listImports(schema || undefined, limit ? Number(limit) || 50 : 50));
  }

  @Get('imports/:id')
  getImport(@Param('id') id: string) {
    return run(() => this.imports.getImport(id));
  }

  // ─── items browser ─────────────────────────────────────────────────────────

  /**
   * Rows of a dataset for the dashboard: `q` full-text search, `filters` (JSON list of
   * {field, op, value} on filterable fields), `status` active | hidden | all, `order`, `page`, `page_size`.
   */
  @Get(':schema/items')
  listItems(@Param('schema') key: string, @Query() q: Record<string, unknown>) {
    const r = itemsQuerySchema.safeParse(q ?? {});
    if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'invalid items query', details: r.error.issues });
    const filters = parseJsonField(r.data.filters, z.array(filterSchema).max(20), 'filters') ?? [];
    const { page, page_size } = r.data;
    return run(async () => {
      const schema = await this.store.requireSchema(key);
      const res = await queryDataset(this.pool, schema, {
        audience: 'owner', filters, search: r.data.q, status: r.data.status, order: r.data.order,
        limit: page_size, offset: (page - 1) * page_size, today: kyivMonthDay(), withTotal: true,
      });
      return { items: res.rows, total: res.total ?? 0, page, page_size };
    });
  }

  /** Hide a row from agents and strategies, or bring it back. */
  @Patch(':schema/items/:id')
  setItemStatus(@Param('schema') key: string, @Param('id') id: string, @Body() body: unknown) {
    const r = z.object({ status: z.enum(['active', 'hidden']) }).strict().safeParse(body);
    if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'status must be active or hidden' });
    return run(() => this.store.setItemStatus(key, id, r.data.status));
  }

  /** Recompute the catalog stats now (they also refresh after each import and nightly). */
  @Post('stats/refresh')
  @HttpCode(200)
  refreshStats(@Body() body: unknown) {
    const r = z.object({ schema: z.string().max(63).optional() }).safeParse(body ?? {});
    if (!r.success) throw new BadRequestException({ code: 'invalid', message: 'schema must be a dataset key' });
    return run(async () => ({ refreshed: await this.store.refreshStats(r.data.schema) }));
  }

  // ─── agent suggestions ─────────────────────────────────────────────────────

  /**
   * Description edits agents proposed (pending action `edit_data_schema`), newest first. The owner applies
   * or discards them through the pending-actions API (/api/agents/actions/:id/apply | discard).
   */
  @Get('suggestions')
  listSuggestions(@Query('schema') schema?: string) {
    return run(async () => {
      const { rows } = await this.pool.query(
        `SELECT pa.id, pa.payload, pa.summary, pa.created_at, a.handle AS agent_handle
           FROM pending_actions pa LEFT JOIN agents a ON a.id = pa.agent_id
          WHERE pa.kind = 'edit_data_schema' AND pa.status = 'pending'
            AND ($1::text IS NULL OR pa.payload->>'dataset' = $1)
          ORDER BY pa.created_at DESC LIMIT 50`, [schema || null]);
      return rows.map((r: any) => ({
        id: r.id, dataset: r.payload?.dataset ?? null, target: r.payload?.target ?? null, field: r.payload?.field ?? null,
        old_text: r.payload?.old_text ?? '', new_text: r.payload?.new_text ?? '', evidence: r.payload?.evidence ?? '',
        summary: r.summary, agent: r.agent_handle ?? null, created_at: r.created_at,
      }));
    });
  }

  // ─── rows (scripts) ────────────────────────────────────────────────────────

  /** JSON array of rows keyed by field names (≤ 5 000). `?dry_run=1` validates and counts only. */
  @Post(':schema/rows')
  @HttpCode(200)
  rows(@Param('schema') schema: string, @Body() body: unknown, @Query('dry_run') dryRun: string | undefined, @Req() req: any) {
    if (!Array.isArray(body)) throw new BadRequestException({ code: 'invalid', message: 'the body must be a JSON array of objects' });
    if (body.length > MAX_API_ROWS) throw new BadRequestException({ code: 'invalid', message: `at most ${MAX_API_ROWS} rows per request` });
    return run(() => this.imports.importRows(schema, body, { dryRun: dryRun === '1' || dryRun === 'true', createdBy: who(req) }));
  }
}
