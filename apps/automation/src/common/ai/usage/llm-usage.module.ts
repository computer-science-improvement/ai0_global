import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../../../database/database.tokens';
import { TelegramNotifier } from '../../../publishers/telegram-notifier.service';
import { LlmPricesRepository } from './llm-prices.repository';
import { BudgetAlertKeys } from './llm-budgets.repository';
import { PriceService } from './price.service';
import { LlmUsageService, setLlmUsage } from './llm-usage.service';

/**
 * The LLM usage ledger (spec 029): price table and the batched writer of
 * llm_usage. The writer is also registered process-wide (setLlmUsage) so
 * provider clients built with `new` (OpenRouterClient, …) report to it.
 */
@Global()
@Module({
  providers: [
    {
      provide: PriceService,
      inject: [DB_POOL],
      useFactory: (pool: Pool) => {
        const logger = new Logger('LlmUsage');
        return new PriceService(new LlmPricesRepository(pool), { onError: (m) => logger.warn(m) });
      },
    },
    {
      provide: LlmUsageService,
      inject: [DB_POOL, PriceService, TelegramNotifier],
      useFactory: (pool: Pool, prices: PriceService, notifier: TelegramNotifier) => {
        const logger = new Logger('LlmUsage');
        const svc = new LlmUsageService({
          pool, prices, alertKeys: new BudgetAlertKeys(pool),
          notify: (t) => notifier.notifyAlert(t),
          log: (m) => logger.warn(m),
        });
        setLlmUsage(svc);
        return svc;
      },
    },
  ],
  exports: [PriceService, LlmUsageService],
})
export class LlmUsageModule implements OnApplicationShutdown {
  constructor(@Inject(LlmUsageService) private readonly usage: LlmUsageService) {}

  async onApplicationShutdown(): Promise<void> {
    await this.usage.flush().catch(() => {});
    setLlmUsage(null);
  }
}
