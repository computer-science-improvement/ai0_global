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

  constructor(@Inject(DB_POOL) pool: Pool) {
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
