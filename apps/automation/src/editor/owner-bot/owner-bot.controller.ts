import { BadRequestException, Controller, Get, Inject, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { OWNER_BOT, type OwnerBotInfra } from './owner-bot.worker';

/** Spec 012 FR-007: the Owner bot section of /app/health — its state, a test card, the reports sent now. */
@Controller('api/owner-bot')
@UseGuards(TrackingAuthGuard)
export class OwnerBotController {
  constructor(@Inject(OWNER_BOT) private readonly infra: OwnerBotInfra) {}

  @Get()
  async status() {
    const { from } = await this.infra.reports.dayBounds(new Date());
    return this.infra.bot.state(from);
  }

  @Post('test-card')
  async testCard() {
    const r = await this.infra.bot.testCard();
    if (!r.sent) throw new ServiceUnavailableException({ error: 'not_sent', details: r.error ?? 'the card was not sent' });
    return r;
  }

  /** Sends today's summary or the weekly report now (it does not count as the scheduled one). */
  @Post('reports/:kind')
  async report(@Param('kind') kind: string) {
    if (kind !== 'daily' && kind !== 'weekly') throw new BadRequestException({ error: 'unknown_report', details: 'daily or weekly' });
    const r = kind === 'daily' ? await this.infra.reports.daily() : await this.infra.reports.weekly();
    if (!(await this.infra.bot.sendToOwner(r.text, r.keyboard))) {
      throw new ServiceUnavailableException({ error: 'not_sent', details: 'TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID is not set, or Telegram refused the message' });
    }
    return { sent: true };
  }
}
