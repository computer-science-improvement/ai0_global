import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DB_POOL } from '../../../database/database.tokens';
import { TelegramNotifier } from '../../../publishers/telegram-notifier.service';
import { LlmUsageModule } from './llm-usage.module';
import { LlmUsageService, llmUsage } from './llm-usage.service';
import { LlmBudgetService } from './llm-budget.service';
import { LlmUsageRollup } from './llm-usage-rollup';

test('LlmUsageModule resolves, registers the process-wide recorder and seeds the env caps once at bootstrap', async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  @Global()
  @Module({
    providers: [
      { provide: DB_POOL, useValue: { query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } } },
      { provide: ConfigService, useValue: { get: (k: string) => ({ AI_DAILY_BUDGET_USD: '4', EDITOR_DAILY_BUDGET_USD: '' } as any)[k] } },
      { provide: TelegramNotifier, useValue: { notifyAlert: async () => {} } },
    ],
    exports: [DB_POOL, ConfigService, TelegramNotifier],
  })
  class Stubs {}
  @Module({ imports: [Stubs, LlmUsageModule] })
  class Root {}

  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  try {
    await app.init();
    const usage = app.get(LlmUsageService);
    assert.equal(llmUsage(), usage);
    assert.ok(app.get(LlmBudgetService));
    assert.ok(app.get(LlmUsageRollup));
    const seeds = queries.filter((q) => /INSERT INTO llm_budgets/.test(q.sql)).map((q) => q.params);
    assert.deepEqual(seeds, [
      ['global', '', 4, 'AI_DAILY_BUDGET_USD'],
      ['feature_prefix', 'editor.', 2, 'EDITOR_DAILY_BUDGET_USD'],
      ['resource', '*', 0.3, 'EDITOR_CHANNEL_DAILY_BUDGET_USD'],
    ]);
  } finally {
    await app.close();
  }
});
