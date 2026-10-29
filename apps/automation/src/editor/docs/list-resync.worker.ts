import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { hostOf, PgHostFailures } from '../net/host-failures';
import type { InboxItemInput, OwnerInbox } from '../agents/owner-inbox';
import { sharedDocStore } from './doc-store';
import { listImports, resyncDataset, type ImportDeps } from './import-list';
import { OWNER, resyncAuto } from './import-list-tools';

/** The text before the first colon when it is snake_case (`host_unreachable`, `http_error`, `upload_expired`), else `error`. */
export function errorClassOf(error: string): string {
  const m = /^([a-z][a-z0-9_]*):/.exec(error.trim());
  return m ? m[1] : 'error';
}

/**
 * Spec 076 A31: the note for a dataset whose weekly re-sync failed. English for the dashboard Inbox, Ukrainian for the Telegram
 * alert; gate subject `resync:<dataset>`, parts `[<error class>]`, so a new kind of failure is news and the same one is not repeated daily.
 */
export function resyncFailedNote(dataset: string, error: string, url: string | undefined): InboxItemInput & { refType: string; refId: string } {
  const host = (url && hostOf(url)) || 'the site';
  const hostUk = (url && hostOf(url)) || 'сайту';
  const text = error.slice(0, 200);
  return {
    kind: 'resync_failed', refType: 'dataset', refId: dataset, severity: 'action',
    title: `Re-sync of ${dataset} failed`,
    body: `${text}. If the server cannot reach ${host}, upload the page (Data → Upload page).`,
    alert: { title: `Не вдалося оновити датасет ${dataset}`, body: `${text}. Якщо сервер не бачить ${hostUk}, завантаж сторінку вручну.` },
    gate: { subject: `resync:${dataset}`, parts: [errorClassOf(error)] },
  };
}

/**
 * Spec 065 FR-003: once a week every dataset made from a list page is read again and its new or changed entries are
 * added, silently (each sync is an import the owner can undo). Only lists whose first import the owner applied
 * (`auto_resync`), and only while IMPORT_RESYNC_AUTO is on. A failure of one list does not stop the others.
 */
export async function resyncAll(
  deps: ImportDeps, log: (m: string) => void, inbox?: Pick<OwnerInbox, 'postOnce'> | null,
): Promise<Array<{ dataset: string; inserted: number; updated: number; error?: string }>> {
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
      // Spec 076 A31: the owner is told once per cause (the note gate), not once a week.
      await inbox?.postOnce(resyncFailedNote(li.dataset, error, li.options.url)).catch(() => null);
    }
  }
  return out;
}

@Injectable()
export class ListResyncWorker {
  private readonly logger = new Logger('ListResync');
  private readonly deps: ImportDeps;

  /** `AGENT_INFRA` by its string token: importing the constant from `editor.module.ts` would be an import cycle. Optional, so a test module without it still builds. */
  private readonly inbox: Pick<OwnerInbox, 'postOnce'> | null;

  constructor(
    @Inject(DB_POOL) pool: Pool,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject('AGENT_INFRA') infra?: { inbox?: Pick<OwnerInbox, 'postOnce'> } | null,
  ) {
    this.inbox = infra?.inbox ?? null;
    const env = (k: string) => config.get<string>(k) ?? undefined;
    this.deps = { pool, docs: sharedDocStore(env), hosts: new PgHostFailures(pool), env };
  }

  @Cron('20 4 * * 1', { name: 'list-resync', timeZone: 'Europe/Kyiv' })
  async weekly(): Promise<void> {
    if (!resyncAuto((k) => this.config.get<string>(k) ?? undefined)) return;
    try {
      await resyncAll(this.deps, (m) => this.logger.log(m), this.inbox);
    } catch (err: any) {
      this.logger.warn(`list re-sync failed: ${err?.message ?? err}`);
    }
  }
}
