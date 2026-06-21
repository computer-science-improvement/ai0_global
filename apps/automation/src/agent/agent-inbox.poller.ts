import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentTriageService } from './agent-triage.service';
import { AgentInboxRepository } from './agent-inbox.repository';
import { selectNewIncoming } from './agent-dialogs.helpers';

@Injectable()
export class AgentInboxPoller {
  private readonly logger = new Logger(AgentInboxPoller.name);

  constructor(
    private readonly client: AgentMtprotoClient,
    private readonly triage: AgentTriageService,
    private readonly repo:   AgentInboxRepository,
    private readonly config: ConfigService,
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
      await this.repo.upsertThread(dm, t);
    }
    await this.repo.touchCursor('agent');
    if (fresh.length) this.logger.log(`agent: triaged ${fresh.length} new DM thread(s)`);
    return { triaged: fresh.length };
  }
}
