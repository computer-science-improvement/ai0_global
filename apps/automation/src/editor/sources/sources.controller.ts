import {
  BadRequestException, Body, ConflictException, Controller, HttpException, Inject, NotFoundException, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DB_POOL } from '../../database/database.module';
import { SettingsService } from '../../settings/settings.service';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { EDITOR_OPS } from '../api/editor.controller';
import type { EditorOpsService } from '../api/editor-ops.service';
import { sharedDocStore } from '../docs/doc-store';
import type { ImportDeps } from '../docs/import-list';
import { egressProxyConfigured } from '../net/safe-http';
import { PgHostFailures, isFetchFailure } from '../net/host-failures';
import { sourceProberOf, type SourceProber } from './probe';
import { applyHostProxyAdd, applySourceDrop, proxyHostList, type FixResult } from './source-fixes';
import { UploadPageBody, uploadPage } from './upload-page';

const ProbeBody = z.object({ url: z.string().min(1).max(2000), kind: z.enum(['rss', 'url']).optional() });
const DropBody = z.object({ channel: z.string().min(1).max(200), sourceId: z.string().min(1).max(100) });
const ProxyHostBody = z.object({ host: z.string().min(1).max(253), url: z.string().min(1).max(2000).optional(), kind: z.enum(['rss', 'url']).optional() });

const invalid = (error: z.ZodError) => new BadRequestException({ error: 'invalid_body', issues: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });

/** The HTTP answer of a refused upload: the code says what the owner did wrong, the status says who must change what. */
function uploadFailure(f: { error: string; details: string }): HttpException {
  const body = { error: f.error, details: f.details };
  if (f.error === 'url_mismatch') return new ConflictException(body);
  if (f.error === 'no_list_import') return new NotFoundException(body);
  if (f.error === 'not_available') return new ServiceUnavailableException(body);
  return new BadRequestException(body);
}

/** The HTTP answer of a fix that was not applied. */
function fixFailure(r: FixResult): HttpException {
  const body = { error: r.error ?? 'fix_failed' };
  if (r.error === 'source_not_found' || r.error === 'channel_not_found') return new NotFoundException(body);
  if (r.error === 'proxy_not_configured') return new ConflictException(body);
  return new BadRequestException(body);
}

/**
 * Spec 076 FR-004 / FR-005 / FR-008: the owner's source tools. `probe` is the "Test from server" button, `upload` is "Upload the
 * page", `drop` and `proxy-host` are the two fixes the Sources panel (and later the doctor) offers.
 */
@Controller('api/editor/sources')
@UseGuards(TrackingAuthGuard)
export class SourcesController {
  private readonly prober: SourceProber;
  private readonly importDeps: Omit<ImportDeps, 'docs'>;
  /** `SettingsService.setValue` writes `process.env` at once, so that is read first. */
  private readonly env: (k: string) => string | undefined;

  constructor(
    @Inject(DB_POOL) pool: Pool,
    @Inject(EDITOR_OPS) private readonly ops: EditorOpsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.env = (k) => process.env[k] ?? config.get<string>(k) ?? undefined;
    this.prober = sourceProberOf(pool, this.env);
    this.importDeps = { pool, hosts: new PgHostFailures(pool), env: this.env };
  }

  /** A forced read of the address, from the server: the button's answer is always a fresh `ProbeResult`. */
  @Post('probe')
  probe(@Body() body: unknown) {
    const p = ProbeBody.safeParse(body);
    if (!p.success) throw invalid(p.error);
    return this.prober(p.data.url, { force: true, ...(p.data.kind ? { kind: p.data.kind } : {}) });
  }

  /** A page saved in a browser: kept in memory for 7 days; with `dataset` it re-syncs that dataset from the page (A15). */
  @Post('upload')
  async upload(@Body() body: unknown) {
    const p = UploadPageBody.safeParse(body);
    if (!p.success) throw invalid(p.error);
    const r = await uploadPage({ docs: sharedDocStore(this.env), imports: this.importDeps }, p.data);
    if (isFetchFailure(r)) throw uploadFailure(r);
    return r;
  }

  /** Removes a source from a card (the doctor's `source_drop`). */
  @Post('drop')
  async drop(@Body() body: unknown): Promise<FixResult> {
    const p = DropBody.safeParse(body);
    if (!p.success) throw invalid(p.error);
    const r = await applySourceDrop({
      card: async (key) => { try { return await this.ops.getChannel(key); } catch (err) { if (err instanceof NotFoundException) return null; throw err; } },
      upsert: (key, card) => this.ops.upsertChannel(key, card),
    }, { kind: 'source_drop', channel: p.data.channel, sourceId: p.data.sourceId });
    if (!r.ok) throw fixFailure(r);
    return r;
  }

  /** Adds a host to the proxy list (the doctor's `host_proxy_add`) and reads `url` once, forced, to show whether it helped. */
  @Post('proxy-host')
  async proxyHost(@Body() body: unknown) {
    const p = ProxyHostBody.safeParse(body);
    if (!p.success) throw invalid(p.error);
    if (!egressProxyConfigured(this.env)) throw new ConflictException({ error: 'proxy_not_configured', details: 'set EGRESS_PROXY_URL (an http or https proxy) in Settings first' });
    const r = await applyHostProxyAdd({ env: this.env, setHosts: (v) => this.settings.setValue('EGRESS_PROXY_HOSTS', v) }, { kind: 'host_proxy_add', host: p.data.host });
    if (!r.ok) throw fixFailure(r);
    const probe = p.data.url ? await this.prober(p.data.url, { force: true, ...(p.data.kind ? { kind: p.data.kind } : {}) }) : null;
    return { hosts: proxyHostList(this.env), applied: r.applied, probe };
  }
}
