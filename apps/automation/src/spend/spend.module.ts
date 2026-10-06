import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { PriceService } from '../common/ai/usage/price.service';
import { LlmUsageService } from '../common/ai/usage/llm-usage.service';
import { LlmBudgetService, envNum } from '../common/ai/usage/llm-budget.service';
import { LlmUsageRollup } from '../common/ai/usage/llm-usage-rollup';
import { SpendRepository } from './spend.repository';
import { SpendService } from './spend.service';
import { OverviewAgentsRepository } from './overview-agents';
import { OVERVIEW_AGENTS, OverviewController, SPEND_SERVICE, SpendController } from './spend.controller';

/**
 * Spend analytics API (spec 029 T5): /api/spend/* and /api/overview/agents.
 * The price cache, the blocking budget gate and the rollup come from the
 * global LlmUsageModule, so an edit here applies to the running gate at once.
 */
@Module({
  imports: [AuthModule],
  controllers: [SpendController, OverviewController],
  providers: [
    TrackingAuthGuard,
    {
      provide: SPEND_SERVICE,
      inject: [DB_POOL, ConfigService, PriceService, LlmBudgetService, LlmUsageRollup, LlmUsageService],
      useFactory: (pool: Pool, cfg: ConfigService, prices: PriceService, budgets: LlmBudgetService, rollup: LlmUsageRollup, usage: LlmUsageService) =>
        new SpendService({
          repo: new SpendRepository(pool), prices, budgets, rollup, flush: () => usage.flush(),
          retentionDays: envNum((k) => cfg.get<string>(k) ?? undefined, 'LLM_USAGE_RETENTION_DAYS', 90),
        }),
    },
    { provide: OVERVIEW_AGENTS, inject: [DB_POOL], useFactory: (pool: Pool) => new OverviewAgentsRepository(pool) },
  ],
})
export class SpendModule {}
