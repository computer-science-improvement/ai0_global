import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { setOwnerBotHandler } from '../../publishers/owner-bot-bus';
import { setInboxCardSink } from '../agents/owner-inbox';
import type { OwnerBotService } from './owner-bot.service';
import type { OwnerReports } from './owner-reports';
import { errText } from '../../common/err-text';

export const OWNER_BOT = 'OWNER_BOT';
export interface OwnerBotInfra { bot: OwnerBotService; reports: OwnerReports }

/**
 * Spec 012: hands the admin bot's buttons and commands to the owner bot, takes the inbox notes, and every minute sweeps
 * the cards and sends a report that is due.
 */
@Injectable()
export class OwnerBotWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OwnerBot');

  constructor(@Inject(OWNER_BOT) private readonly infra: OwnerBotInfra) {}

  onModuleInit(): void {
    setOwnerBotHandler(this.infra.bot);
    setInboxCardSink((id, note) => this.infra.bot.inboxNote(id, note));
  }

  onModuleDestroy(): void {
    setOwnerBotHandler(null);
    setInboxCardSink(null);
  }

  @Cron('* * * * *', { name: 'owner-bot-sweep' })
  async tick(): Promise<void> {
    try {
      const r = await this.infra.bot.sweep();
      if (r.created || r.closed || r.sent) this.logger.log(`cards: ${r.created} new, ${r.closed} closed, ${r.sent} sent`);
    } catch (err: any) {
      this.logger.warn(`sweep failed: ${errText(err)}`);
    }
    try {
      const sent = await this.infra.reports.tick((text, kb) => this.infra.bot.sendToOwner(text, kb));
      if (sent.length) this.logger.log(`reports sent: ${sent.join(', ')}`);
    } catch (err: any) {
      this.logger.warn(`reports failed: ${errText(err)}`);
    }
  }
}
