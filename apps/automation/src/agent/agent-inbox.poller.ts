import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentTriageService } from './agent-triage.service';
import { AgentInboxRepository } from './agent-inbox.repository';
import { selectNewIncoming } from './agent-dialogs.helpers';
import { AgentActionsRepository } from './agent-actions.repository';
import { AdPricesRepository, toPublicPrice } from '../payments/ad-prices.repository';
import { priceListReply, pricesForInquiry } from '../payments/ad-price-list';
import type { TriageResult } from './agent.types';

@Injectable()
export class AgentInboxPoller {
  private readonly logger = new Logger(AgentInboxPoller.name);

  constructor(
    private readonly client: AgentMtprotoClient,
    private readonly triage: AgentTriageService,
    private readonly repo:   AgentInboxRepository,
    private readonly config: ConfigService,
    private readonly actions: AgentActionsRepository,
    private readonly prices:  AdPricesRepository,
  ) {}

  // Cadence is fixed at registration time; AGENT_ENABLED gates execution.
  @Cron(process.env.AGENT_POLL_CRON || '*/5 * * * *')
  async tick(): Promise<void> {
    try { await this.pollOnce(); }
    catch (err: any) { this.logger.warn(`agent poll failed: ${err.message}`); }
  }

  /** Poll once. Returns { triaged } count of new threads processed. */
  async pollOnce(): Promise<{ triaged: number }> {
    if (this.config.get<string>('AGENT_ENABLED') !== 'true') return { triaged: 0 };
    if (!(await this.client.hasSession())) {
      this.logger.log('agent enabled but no active agent session — skipping');
      return { triaged: 0 };
    }

    const dialogs = await this.client.fetchRecentDialogs();
    const lastIds = new Map<string, number>();
    for (const d of dialogs) lastIds.set(d.peerId, await this.repo.lastMessageIdFor(d.peerId));

    const fresh = selectNewIncoming(dialogs, lastIds);
    for (const dm of fresh) {
      const t = await this.triage.triage(dm.text);
      const threadId = await this.repo.upsertThread(dm, t);
      if (t.category === 'ad' && threadId) await this.draftPriceReply(threadId, t);
    }
    await this.repo.touchCursor('agent');
    if (fresh.length) this.logger.log(`agent: triaged ${fresh.length} new DM thread(s)`);
    return { triaged: fresh.length };
  }

  /**
   * Sales tooling (spec 008 T007): an ad inquiry gets a DRAFT reply with the
   * active price list (deterministic template — prices are never written by the
   * model). It is a pending `reply` action: the owner approves the send, and the
   * AGENT_REPLY_DAILY_CAP applies at approval. One pending draft per thread.
   */
  private async draftPriceReply(threadId: string, t: TriageResult): Promise<void> {
    try {
      const prices = pricesForInquiry((await this.prices.list({ activeOnly: true })).map(toPublicPrice), t.fields.channel);
      if (!prices.length) return;
      if (await this.actions.hasPending(threadId, 'reply')) return;
      await this.actions.create({ type: 'reply', threadId, payload: { text: priceListReply(prices), kind: 'price_list' } });
    } catch (err: any) {
      this.logger.warn(`price-list draft failed for thread ${threadId}: ${err?.message ?? err}`);
    }
  }
}
