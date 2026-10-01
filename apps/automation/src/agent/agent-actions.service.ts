import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentActionsRepository } from './agent-actions.repository';
import { AgentReplySender } from './agent-reply-sender.service';
import { AgentScheduleExecutor } from './agent-schedule.executor';
import { AgentInboxRepository } from './agent-inbox.repository';
import type { AgentActionRow } from './agent.types';

@Injectable()
export class AgentActionsService {
  private readonly logger = new Logger(AgentActionsService.name);

  constructor(
    private readonly repo:    AgentActionsRepository,
    private readonly sender:  AgentReplySender,
    private readonly exec:    AgentScheduleExecutor,
    private readonly threads: AgentInboxRepository,
    private readonly config:  ConfigService,
  ) {}

  async approve(id: string): Promise<AgentActionRow> {
    const a = await this.repo.findById(id);
    if (!a) throw new Error('action not found');
    if (a.status !== 'pending') return a; // idempotent: only pending executes

    if (a.type === 'reply') {
      const cap = Number(this.config.get('AGENT_REPLY_DAILY_CAP')) || 20;
      const sent = await this.repo.countRepliesSince(24);
      if (sent >= cap) {
        await this.repo.setStatus(id, 'failed', { error: `daily reply cap reached (${cap})` });
        return { ...a, status: 'failed', error: `daily reply cap reached (${cap})` };
      }
      const peer = a.thread_id ? await this.threads.threadPeer(a.thread_id) : null;
      if (!peer) {
        await this.repo.setStatus(id, 'failed', { error: 'no thread peer' });
        return { ...a, status: 'failed', error: 'no thread peer' };
      }
      const text = String(a.payload.text ?? '');
      const res = await this.sender.sendReply(peer.peer_id, peer.peer_username, text);
      if (!res.ok) {
        await this.repo.setStatus(id, 'failed', { error: res.error });
        return { ...a, status: 'failed', error: res.error ?? 'send failed' };
      }
      await this.repo.setStatus(id, 'done', { executedAt: true });
      if (a.thread_id) await this.threads.stampReplied(a.thread_id, text);
      return { ...a, status: 'done' };
    }

    // schedule_post
    // schedule_post. With payload.orderId (ad order, spec 008) the executor
    // reserves an editor slot or falls back to scheduled_posts — see AdPlacement.
    const { text, channelId, scheduledAt, orderId } = a.payload as any;
    if (!text || !channelId || !scheduledAt) {
      await this.repo.setStatus(id, 'failed', { error: 'missing text/channelId/scheduledAt' });
      return { ...a, status: 'failed', error: 'missing fields' };
    }
    let placed;
    try {
      placed = await this.exec.schedule({ channelId, text, scheduledAt, orderId: orderId ?? null });
    } catch (err: any) {
      const error = `schedule failed: ${err?.message ?? err}`;
      await this.repo.setStatus(id, 'failed', { error });
      return { ...a, status: 'failed', error };
    }
    await this.repo.mergePayload(id, placed.kind === 'reserved_slot' ? { editorSlotId: placed.id } : { scheduledPostId: placed.id });
    await this.repo.setStatus(id, 'done', { executedAt: true });
    return { ...a, status: 'done' };
  }

  async reject(id: string): Promise<AgentActionRow> {
    const a = await this.repo.findById(id);
    if (!a) throw new Error('action not found');
    if (a.status === 'pending') await this.repo.setStatus(id, 'rejected');
    return { ...a, status: a.status === 'pending' ? 'rejected' : a.status };
  }
}
