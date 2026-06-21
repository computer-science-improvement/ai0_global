import { Injectable } from '@nestjs/common';
import { AdOrdersRepository } from './ad-orders.repository';
import { LiqpayService } from './liqpay.service';
import { AgentActionsRepository } from '../agent/agent-actions.repository';

@Injectable()
export class AdOrdersService {
  constructor(
    private readonly repo:    AdOrdersRepository,
    private readonly liqpay:  LiqpayService,
    private readonly actions: AgentActionsRepository,
  ) {}

  async createCheckout(id: string): Promise<{ data: string; signature: string; actionUrl: string }> {
    const o = await this.repo.findById(id);
    if (!o) throw new Error('order not found');
    await this.repo.setCheckout(id);
    return this.liqpay.buildCheckout({ orderId: id, amount: String(o.amount), currency: o.currency, description: o.description ?? `Ad order ${id}` });
  }

  async schedulePost(id: string, input: { channelId: string; text: string; scheduledAt: string }): Promise<{ actionId: string }> {
    const o = await this.repo.findById(id);
    if (!o) throw new Error('order not found');
    if (o.status !== 'paid') throw new Error('order is not paid');
    const action = await this.actions.create({ type: 'schedule_post', payload: { text: input.text, channelId: input.channelId, scheduledAt: input.scheduledAt } });
    await this.repo.attachAction(id, action.id);
    return { actionId: action.id };
  }
}
