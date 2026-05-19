// apps/automation/src/discovery/teleads/teleads-ingestion.worker.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TeleAdsClient, TeleAdsPage } from './teleads.client';
import { mapTeleAdsProduct } from './teleads-mapper';
import { CandidateChannelsRepository } from '../repositories/candidate-channels.repository';

const PAGE_DELAY_MS = 200;
const PER_PAGE = 100;

@Injectable()
export class TeleAdsIngestionWorker {
  private readonly logger = new Logger(TeleAdsIngestionWorker.name);

  constructor(
    private readonly client: TeleAdsClient,
    private readonly repo: CandidateChannelsRepository,
  ) {}

  /** Daily at 04:00 UTC — quiet hour, no overlap with motivation/AI Tech slots. */
  @Cron('0 4 * * *')
  async run(): Promise<void> {
    const stats = await this.ingest();
    this.logger.log(
      `TeleAds ingestion done: ${stats.inserted} new, ${stats.updated} updated, ${stats.total} total in ${stats.durationMs}ms`,
    );
  }

  async ingest(): Promise<{ inserted: number; updated: number; total: number; durationMs: number }> {
    const start = Date.now();
    let inserted = 0;
    let updated = 0;
    let total = 0;

    let firstPage: TeleAdsPage;
    try {
      firstPage = await this.client.listProducts({ page: 1, perPage: PER_PAGE });
    } catch (err: any) {
      this.logger.error(`TeleAds page 1 failed: ${err.message}`);
      return { inserted, updated, total, durationMs: Date.now() - start };
    }

    const lastPage = firstPage.meta.last_page ?? 1;

    const handlePage = async (page: TeleAdsPage) => {
      for (const product of page.data) {
        try {
          const row = mapTeleAdsProduct(product);
          const res = await this.repo.upsert(row);
          if (res.inserted) inserted++; else updated++;
          total++;
        } catch (err: any) {
          this.logger.warn(`Skip product ${product.id}: ${err.message}`);
        }
      }
    };

    await handlePage(firstPage);

    for (let page = 2; page <= lastPage; page++) {
      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
      try {
        const p = await this.client.listProducts({ page, perPage: PER_PAGE });
        await handlePage(p);
      } catch (err: any) {
        this.logger.warn(`TeleAds page ${page} failed (skipped): ${err.message}`);
      }
    }

    return { inserted, updated, total, durationMs: Date.now() - start };
  }
}
