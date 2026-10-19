import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { setOwnerBotHandler } from '../../publishers/owner-bot-bus';
import { setInboxCardSink } from '../agents/owner-inbox';
import type { OwnerBotService } from './owner-bot.service';

export const OWNER_BOT = 'OWNER_BOT';

/** Spec 012: hands the admin bot's buttons and commands to the owner bot, takes the inbox notes, and sweeps every minute. */
@Injectable()
export class OwnerBotWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OwnerBot');

  constructor(@Inject(OWNER_BOT) private readonly bot: OwnerBotService) {}

  onModuleInit(): void {
    setOwnerBotHandler(this.bot);
    setInboxCardSink((id, note) => this.bot.inboxNote(id, note));
  }

  onModuleDestroy(): void {
    setOwnerBotHandler(null);
    setInboxCardSink(null);
  }

  @Cron('* * * * *', { name: 'owner-bot-sweep' })
  async tick(): Promise<void> {
    try {
      const r = await this.bot.sweep();
      if (r.created || r.closed || r.sent) this.logger.log(`cards: ${r.created} new, ${r.closed} closed, ${r.sent} sent`);
    } catch (err: any) {
      this.logger.warn(`sweep failed: ${err?.message ?? err}`);
    }
  }
}
