import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AdOrdersRepository } from './ad-orders.repository';
import { AgentActionsRepository } from '../agent/agent-actions.repository';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { buildAdReport, reportMessage, reportStage, shortCampaign, withUtm } from './ad-report';
import type { AdOrderRow } from './ad-orders.types';

function creativeLink(creative: unknown): string | null {
  const c = creative as { cta?: { url?: string }; buttons?: Array<Array<{ url?: string }>> } | null;
  return c?.cta?.url ?? c?.buttons?.[0]?.[0]?.url ?? null;
}

/**
 * Advertiser reports (spec 008 T005). Hourly: every published ad order whose
 * post is ≥ 24 h old gets a report built from post_stats_snapshots; at ≥ 72 h
 * the final report moves the order to `reported`. The first report drafts a
 * pending `reply` action with the public link for the advertiser's DM thread —
 * the owner approves the send (never automatic). Without a thread the owner
 * gets the link through the admin bot.
 */
@Injectable()
export class AdReportsService {
  private readonly logger = new Logger(AdReportsService.name);
  private running = false;

  constructor(
    private readonly repo:     AdOrdersRepository,
    private readonly actions:  AgentActionsRepository,
    private readonly notifier: TelegramNotifier,
    private readonly config:   ConfigService,
  ) {}

  @Cron('17 * * * *', { name: 'ad-reports' })
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.runOnce(new Date()); }
    catch (err: any) { this.logger.warn(`ad reports failed: ${err?.message ?? err}`); }
    finally { this.running = false; }
  }

  async runOnce(now: Date): Promise<number> {
    const due = await this.repo.dueForReport(now);
    let built = 0;
    for (const o of due) {
      try {
        if (await this.reportOne(o, now)) built++;
      } catch (err: any) {
        this.logger.warn(`report for order ${o.id} failed: ${err?.message ?? err}`);
      }
    }
    return built;
  }

  private async reportOne(o: AdOrderRow & { posted_at: Date; ad_format: string | null }, now: Date): Promise<boolean> {
    const stage = reportStage(new Date(o.posted_at), now);
    if (!stage || !o.published_post_id) return false;
    const inputs = await this.repo.reportInputs(o.published_post_id);
    if (!inputs) return false;

    const raw = creativeLink(o.creative);
    const linkUrl = raw && o.ad_format === 'digest_sponsor' ? withUtm(raw, shortCampaign(o.id)) : raw;
    const report = buildAdReport({ stage, now, advertiser: o.advertiser, ...inputs, linkUrl });
    const token = await this.repo.saveReport(o.id, report);
    if (!token) return false;

    if (o.report == null) {
      const base = (this.config.get<string>('DASHBOARD_URL') ?? '').replace(/\/+$/, '');
      const url = `${base}/report/${token}`;
      const text = reportMessage(o.advertiser, url, stage);
      if (o.thread_id) {
        await this.actions.create({ type: 'reply', threadId: o.thread_id, payload: { text, orderId: o.id, kind: 'ad_report' } });
      } else {
        try { await this.notifier.notifyAlert(`📊 Звіт для «${o.advertiser}» готовий: ${url}\n(немає DM-треду — надішли рекламодавцю вручну)`); } catch { /* best-effort */ }
      }
    }
    return true;
  }
}
