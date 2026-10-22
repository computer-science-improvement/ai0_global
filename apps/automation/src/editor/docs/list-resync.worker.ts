import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { PgHostFailures } from '../net/host-failures';
import { sharedDocStore } from './doc-store';
import { listImports, resyncDataset, type ImportDeps } from './import-list';
import { OWNER, resyncAuto } from './import-list-tools';

/**
 * Spec 065 FR-003: once a week every dataset made from a list page is read again and its new or changed entries are
 * added, silently (each sync is an import the owner can undo). Only lists whose first import the owner applied
 * (`auto_resync`), and only while IMPORT_RESYNC_AUTO is on. A failure of one list does not stop the others.
 */
export async function resyncAll(deps: ImportDeps, log: (m: string) => void): Promise<Array<{ dataset: string; inserted: number; updated: number; error?: string }>> {
  const out: Array<{ dataset: string; inserted: number; updated: number; error?: string }> = [];
  for (const li of await listImports(deps.pool)) {
    if (!li.options.auto_resync) continue;
    try {
      const r = await resyncDataset(deps, li, `${OWNER} weekly`);
      out.push({ dataset: li.dataset, inserted: r.inserted, updated: r.updated });
      if (r.inserted || r.updated) log(`list re-sync ${li.dataset}: ${r.inserted} new, ${r.updated} changed`);
    } catch (err: any) {
      const error = String(err?.message ?? err).slice(0, 300);
      out.push({ dataset: li.dataset, inserted: 0, updated: 0, error });
      log(`list re-sync ${li.dataset} failed: ${error}`);
    }
  }
  return out;
}

@Injectable()
export class ListResyncWorker {
  private readonly logger = new Logger('ListResync');
  private readonly deps: ImportDeps;

  constructor(@Inject(DB_POOL) pool: Pool, @Inject(ConfigService) private readonly config: ConfigService) {
    const env = (k: string) => config.get<string>(k) ?? undefined;
    this.deps = { pool, docs: sharedDocStore(env), hosts: new PgHostFailures(pool), env };
  }

  @Cron('20 4 * * 1', { name: 'list-resync', timeZone: 'Europe/Kyiv' })
  async weekly(): Promise<void> {
    if (!resyncAuto((k) => this.config.get<string>(k) ?? undefined)) return;
    try {
      await resyncAll(this.deps, (m) => this.logger.log(m));
    } catch (err: any) {
      this.logger.warn(`list re-sync failed: ${err?.message ?? err}`);
    }
  }
}
