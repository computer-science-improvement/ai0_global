import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { once } from 'node:events';
import type { Response } from 'express';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import type { SpendService } from './spend.service';
import type { OverviewAgentsRepository } from './overview-agents';

export const SPEND_SERVICE = 'SPEND_SERVICE';
export const OVERVIEW_AGENTS = 'OVERVIEW_AGENTS';

/**
 * AI spend reports and the owner's price and budget edits (spec 029 FR-011).
 * Query strings and bodies are passed raw and validated with zod inside
 * SpendService (400 `invalid_request` / `invalid_range` with issues).
 */
@Controller('api/spend')
@UseGuards(TrackingAuthGuard)
export class SpendController {
  constructor(@Inject(SPEND_SERVICE) private readonly svc: SpendService) {}

  @Get('summary')
  summary(@Query() q: Record<string, unknown>) {
    return this.svc.summary(q);
  }

  @Get('breakdown')
  breakdown(@Query() q: Record<string, unknown>) {
    return this.svc.breakdown(q);
  }

  @Get('ledger')
  ledger() {
    return this.svc.ledgerInfo();
  }

  /** Streams the CSV: grouped rows, or raw ledger rows (groupBy=raw) page by page. */
  @Get('export.csv')
  async exportCsv(@Query() q: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const plan = this.svc.exportPlan(q);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    // BOM: spreadsheet apps then read the file as UTF-8.
    res.write('﻿');
    try {
      for await (const chunk of this.svc.exportCsv(plan)) {
        if (res.destroyed) return;
        if (!res.write(chunk)) await once(res, 'drain');
      }
    } catch (err: any) {
      // Headers are gone already: end the body with a marker line instead of a JSON error.
      res.write(`\r\n# export failed: ${String(err?.message ?? err).replace(/[\r\n]/g, ' ').slice(0, 200)}\r\n`);
    }
    res.end();
  }

  @Get('prices')
  prices() {
    return this.svc.listPrices();
  }

  @Put('prices')
  putPrice(@Body() body: unknown) {
    return this.svc.putPrice(body);
  }

  @Delete('prices')
  deletePrice(@Query() q: Record<string, unknown>) {
    return this.svc.deletePrice(q);
  }

  /** Owner action: re-cost `estimate`/`unpriced` rows of the last N days with the current prices. */
  @Post('reprice')
  reprice(@Body() body: unknown) {
    return this.svc.reprice(body);
  }

  @Get('budgets')
  budgets() {
    return this.svc.budgetsView();
  }

  @Put('budgets')
  putBudget(@Body() body: unknown) {
    return this.svc.putBudget(body);
  }

  @Delete('budgets/:id')
  deleteBudget(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deleteBudget(id);
  }
}

/** Agent activity for the Overview card (spec 029 FR-009). */
@Controller('api/overview')
@UseGuards(TrackingAuthGuard)
export class OverviewController {
  constructor(@Inject(OVERVIEW_AGENTS) private readonly agents: Pick<OverviewAgentsRepository, 'load'>) {}

  @Get('agents')
  agentsOverview() {
    return this.agents.load();
  }
}
