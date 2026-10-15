import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { StoryRegistry } from './story.repository';

/**
 * Spec 037 T2: at boot, fill the story registry from the last 30 days of published posts, in the background (the
 * boot never waits for it). Idempotent (registered slots are skipped) and off unless the editor is enabled;
 * `EDITOR_STORY_BACKFILL=off` turns it off. A missing table (migration 073 not applied) is logged, never thrown.
 */
@Injectable()
export class StoryBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger('Stories');

  constructor(@Inject(DB_POOL) private readonly pool: Pool, @Inject(ConfigService) private readonly cfg: ConfigService) {}

  onApplicationBootstrap(): void {
    if (this.cfg.get<string>('EDITOR_ENABLED') !== 'true' || this.cfg.get<string>('EDITOR_STORY_BACKFILL') === 'off') return;
    const reg = new StoryRegistry(this.pool, (m) => this.logger.warn(m));
    void reg.backfill(new Date())
      .then((n) => { if (n) this.logger.log(`story registry backfill: ${n} posts registered`); })
      .catch((e) => this.logger.warn(`story registry backfill failed: ${e?.message ?? e}`));
  }
}
