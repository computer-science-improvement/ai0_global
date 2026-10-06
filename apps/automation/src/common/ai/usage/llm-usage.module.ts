import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB_POOL } from '../../../database/database.tokens';
import { TelegramNotifier } from '../../../publishers/telegram-notifier.service';
import { OwnerInbox } from '../../../editor/agents/owner-inbox';
import { LlmPricesRepository } from './llm-prices.repository';
import { BudgetAlertKeys, LlmBudgetsRepository } from './llm-budgets.repository';
import { PriceService } from './price.service';
import { LlmUsageService, setLlmUsage } from './llm-usage.service';
import { LlmBudgetService, capDefaults, capSeeds, envNum, type BlockInfo } from './llm-budget.service';
import { LlmUsageRollup } from './llm-usage-rollup';

/** The Inbox entry (English) + Telegram alert (unchanged wording) of a blocking cap (spec 029 FR-008). */
export function blockedNotifier(inbox: Pick<OwnerInbox, 'post'>) {
  return async (b: BlockInfo): Promise<void> => {
    await inbox.post({
      kind: 'budget_blocked', severity: 'critical', refType: 'llm_budget', refId: `${b.scope}:${b.key}`,
      title: `💸 LLM budget exhausted: ${b.labelEn ?? b.label}`,
      body: [
        `Spent $${b.spentUsd.toFixed(3)} of $${b.capUsd} today (Europe/Kyiv).`,
        'Calls covered by this cap are blocked until midnight Kyiv time or until the cap is raised.',
        'Raise the cap: Spend → Budgets (/app/spend?tab=budgets).',
      ].join('\n'),
      alert: {
        title: `💸 Бюджет LLM вичерпано: ${b.label}`,
        body: [
          `Витрачено $${b.spentUsd.toFixed(3)} із $${b.capUsd} за сьогодні (Europe/Kyiv).`,
          'Виклики, які покриває цей ліміт, заблоковано до опівночі за Києвом або доки ліміт не піднято.',
          'Підняти ліміт: Spend → Budgets (/app/spend?tab=budgets).',
        ].join('\n'),
      },
    });
  };
}

@Injectable()
export class LlmUsageRollupJob {
  private readonly logger = new Logger('LlmUsageRollup');

  constructor(@Inject(LlmUsageRollup) private readonly rollup: LlmUsageRollup, @Inject(LlmUsageService) private readonly usage: LlmUsageService) {}

  @Cron('*/5 * * * *', { name: 'llm-usage-rollup' })
  async every5min(): Promise<void> {
    try {
      await this.usage.flush();
      await this.rollup.rollup();
    } catch (err: any) {
      this.logger.warn(`rollup failed: ${err?.message ?? err}`);
    }
  }

  /** Just after Kyiv midnight: closes yesterday with its late rows. */
  @Cron('10 0 * * *', { name: 'llm-usage-rollup-midnight', timeZone: 'Europe/Kyiv' })
  async afterMidnight(): Promise<void> {
    await this.every5min();
  }

  @Cron('40 3 * * *', { name: 'llm-usage-prune', timeZone: 'Europe/Kyiv' })
  async prune(): Promise<void> {
    try {
      const n = await this.rollup.prune();
      if (n) this.logger.log(`pruned ${n} raw llm_usage rows`);
    } catch (err: any) {
      this.logger.warn(`prune failed: ${err?.message ?? err}`);
    }
  }
}

/**
 * The LLM usage ledger (spec 029): price table, the batched writer of
 * llm_usage, the blocking budgets and the rollup/retention jobs. The writer is
 * also registered process-wide (setLlmUsage) so provider clients built with
 * `new` (OpenRouterClient, …) report to it.
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
    {
      provide: LlmBudgetService,
      inject: [DB_POOL, ConfigService, TelegramNotifier, LlmUsageService],
      useFactory: (pool: Pool, cfg: ConfigService, notifier: TelegramNotifier, usage: LlmUsageService) => {
        const logger = new Logger('LlmBudget');
        const alert = (t: string) => notifier.notifyAlert(t);
        const budget = new LlmBudgetService({
          pool, caps: new LlmBudgetsRepository(pool), alertKeys: new BudgetAlertKeys(pool), alert,
          blocked: blockedNotifier(new OwnerInbox(pool, alert, cfg.get<string>('DASHBOARD_URL') ?? null)),
          flush: () => usage.flush(),
          log: (m) => logger.warn(m),
        });
        usage.attachBudget(budget);
        return budget;
      },
    },
    {
      provide: LlmUsageRollup,
      inject: [DB_POOL, ConfigService],
      useFactory: (pool: Pool, cfg: ConfigService) =>
        new LlmUsageRollup(pool, { retentionDays: envNum((k) => cfg.get<string>(k) ?? undefined, 'LLM_USAGE_RETENTION_DAYS', 90) }),
    },
    LlmUsageRollupJob,
  ],
  exports: [PriceService, LlmUsageService, LlmBudgetService, LlmUsageRollup],
})
export class LlmUsageModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('LlmUsage');

  constructor(
    @Inject(LlmUsageService) private readonly usage: LlmUsageService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(ConfigService) private readonly cfg: ConfigService,
  ) {}

  /** Env caps seed llm_budgets once; afterwards the rows (owner-edited) are the source of truth. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await new LlmBudgetsRepository(this.pool).seed(capSeeds(capDefaults((k) => this.cfg.get<string>(k) ?? undefined)));
      if (n) this.logger.log(`seeded ${n} llm_budgets rows from env`);
    } catch (err: any) {
      this.logger.warn(`llm_budgets seed failed: ${err?.message ?? err}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.usage.flush().catch(() => {});
    setLlmUsage(null);
  }
}
