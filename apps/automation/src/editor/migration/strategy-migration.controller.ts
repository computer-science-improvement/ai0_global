import { BadRequestException, Body, Controller, Get, HttpException, Inject, Post, Query, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { PendingActionsService } from '../agents/pending-actions';
import { MIGRATION_ACTIONS, migrationCard, type MigrationOp } from './migration-actions';
import { isFail, type Fail, type StrategyMigrationService } from './strategy-migration.service';

export const STRATEGY_MIGRATION = 'STRATEGY_MIGRATION';

export interface StrategyMigrationInfra {
  svc:     StrategyMigrationService;
  actions: Pick<PendingActionsService, 'propose'>;
  pool:    Pick<Pool, 'query'>;
  inbox:   Pick<OwnerInbox, 'post'>;
}

function http<T>(r: T | Fail): T {
  if (isFail(r)) throw new HttpException({ error: r.error, ...(r.details !== undefined ? { details: r.details } : {}) }, r.status ?? 400);
  return r;
}

const channelOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 200) throw new BadRequestException({ error: 'invalid_channel', details: 'channel (the Telegram channel key) is required' });
  return s;
};

/**
 * `/app/strategies` in its legacy phase (spec 023 FR-011–FR-013): the per-channel migration state, the dry-run
 * proposal and the three cards (proposed chatless; Apply / Discard through /api/agents/actions/:id/…).
 */
@Controller('api/strategies/migration')
@UseGuards(TrackingAuthGuard)
export class StrategyMigrationController {
  constructor(@Inject(STRATEGY_MIGRATION) private readonly m: StrategyMigrationInfra) {}

  @Get()
  async status() {
    const [channels, cards] = await Promise.all([
      this.m.svc.status(),
      this.m.pool.query(
        `SELECT id, kind, summary, payload->>'channel_key' AS channel_key, created_at FROM pending_actions
          WHERE kind = ANY($1::text[]) AND status = 'pending' AND created_at > now() - interval '24 hours' ORDER BY created_at DESC`,
        [[...MIGRATION_ACTIONS]]),
    ]);
    return {
      channels: channels.map((c) => ({
        ...c,
        cards: cards.rows.filter((r) => r.channel_key === c.channel_key).map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, createdAt: r.created_at })),
      })),
    };
  }

  /** The dry run: what would map, how, and what not (writes nothing). */
  @Get('proposal')
  async proposal(@Query('channel') channel?: string) {
    return http(await this.m.svc.propose(channelOf(channel)));
  }

  @Post('migrate')
  migrate(@Body() body: { channel?: string }) { return this.card('migrate', body); }

  @Post('cutover')
  cutover(@Body() body: { channel?: string }) { return this.card('cutover', body); }

  @Post('rollback')
  rollback(@Body() body: { channel?: string }) { return this.card('rollback', body); }

  private async card(op: MigrationOp, body: { channel?: string } | undefined) {
    const c = http(await migrationCard(this.m.svc, op, channelOf(body?.channel)));
    const action = await this.m.actions.propose({ chatId: null, agentId: c.agentId, kind: c.kind, payload: c.payload, summary: c.summary });
    return { action, ...(c.proposal ? { proposal: c.proposal } : {}) };
  }
}
