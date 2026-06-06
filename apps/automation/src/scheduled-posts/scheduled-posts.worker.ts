import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledPostsService } from './scheduled-posts.service';

@Injectable()
export class ScheduledPostsWorker {
  private readonly logger = new Logger(ScheduledPostsWorker.name);
  private running = false;
  constructor(private readonly service: ScheduledPostsService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    if (this.running) return;           // never overlap ticks
    this.running = true;
    try { await this.service.publishDue(); }
    catch (e: any) { this.logger.warn(`publishDue tick error: ${e?.message ?? e}`); }
    finally { this.running = false; }
  }
}
