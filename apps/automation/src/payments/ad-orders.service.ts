import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AdOrdersRepository, CreateOrderInput, OrderPatch } from './ad-orders.repository';
import { AdPricesRepository } from './ad-prices.repository';
import { LiqpayService } from './liqpay.service';
import { AgentActionsRepository } from '../agent/agent-actions.repository';
import { SponsoredCreative, SponsoredCreativeSchema, creativeFromText, lintSponsored, renderSponsored } from '../editor/post/sponsored';
import { htmlToPlain } from '../editor/post/inline-markup';
import type { AdOrderRow } from './ad-orders.types';

export interface CreateOrderRequest {
  advertiser:    string;
  channelId?:    string | null;
  /** Required unless priceId is given; with a priceId the server computes it. */
  amount?:       string | null;
  currency?:     string | null;
  description?:  string | null;
  priceId?:      string | null;
  creative?:     unknown;
  sponsorLabel?: string | null;
  publishAt?:    string | null;
  threadId?:     string | null;
}

function parseCreative(raw: unknown): SponsoredCreative {
  const r = SponsoredCreativeSchema.safeParse(raw);
  if (!r.success) throw new BadRequestException(`invalid creative: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

function parseDate(s: string | null | undefined, field: string): Date | null {
  if (s == null || s === '') return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} must be an ISO date`);
  return d;
}

@Injectable()
export class AdOrdersService {
  constructor(
    private readonly repo:    AdOrdersRepository,
    private readonly liqpay:  LiqpayService,
    private readonly actions: AgentActionsRepository,
    private readonly prices:  AdPricesRepository,
  ) {}

  /** With a priceId the amount (UAH) and default channel come from the active price — never from the client. */
  async create(req: CreateOrderRequest): Promise<AdOrderRow> {
    const input: CreateOrderInput = {
      advertiser: req.advertiser, channelId: req.channelId ?? null, amount: req.amount ?? '', currency: req.currency || 'UAH',
      description: req.description ?? null, sponsorLabel: req.sponsorLabel?.trim() || null,
      publishAt: parseDate(req.publishAt, 'publishAt'), threadId: req.threadId ?? null,
      creative: req.creative == null ? null : parseCreative(req.creative),
    };
    if (req.priceId) {
      const price = await this.prices.findById(req.priceId);
      if (!price || !price.active) throw new BadRequestException('price not found or inactive');
      input.priceId = price.id;
      input.amount = Number(price.price_uah).toFixed(2);
      input.currency = 'UAH';
      input.channelId = req.channelId || price.channel_key;
    } else if (!req.amount || !/^\d+(\.\d{1,2})?$/.test(req.amount)) {
      throw new BadRequestException('amount is required (decimal string) when no priceId is given');
    }
    return this.repo.create(input);
  }

  async update(id: string, req: Omit<CreateOrderRequest, 'advertiser' | 'amount' | 'currency' | 'priceId'>): Promise<AdOrderRow> {
    const patch: OrderPatch = {};
    if (req.channelId !== undefined)    patch.channelId = req.channelId;
    if (req.creative !== undefined)     patch.creative = req.creative === null ? null : parseCreative(req.creative);
    if (req.sponsorLabel !== undefined) patch.sponsorLabel = req.sponsorLabel?.trim() || null;
    if (req.publishAt !== undefined)    patch.publishAt = parseDate(req.publishAt, 'publishAt');
    if (req.threadId !== undefined)     patch.threadId = req.threadId;
    if (req.description !== undefined)  patch.description = req.description;
    const row = await this.repo.update(id, patch);
    if (!row) throw new NotFoundException('order not found or already published');
    return row;
  }

  async createCheckout(id: string): Promise<{ data: string; signature: string; actionUrl: string }> {
    const o = await this.repo.findById(id);
    if (!o) throw new NotFoundException('order not found');
    await this.repo.setCheckout(id);
    return this.liqpay.buildCheckout({ orderId: id, amount: String(o.amount), currency: o.currency, description: o.description ?? `Ad order ${id}` });
  }

  /**
   * Paid order → pending `schedule_post` action (owner approval gate, SP2).
   * The creative is the order's own (or the legacy plain `text`), linted with
   * the relaxed sponsored rules; the action carries a plain-text preview that
   * already shows the #реклама line. Approval places the post (reserved editor
   * slot or the scheduled_posts fallback) — see AdPlacement.
   */
  async schedulePost(id: string, input: { channelId?: string | null; text?: string | null; scheduledAt?: string | null }): Promise<{ actionId: string }> {
    const o = await this.repo.findById(id);
    if (!o) throw new NotFoundException('order not found');
    if (o.status !== 'paid') throw new BadRequestException('order is not paid');
    const channelId = input.channelId || o.channel_id;
    if (!channelId) throw new BadRequestException('channelId is required');
    const at = parseDate(input.scheduledAt, 'scheduledAt') ?? o.publish_at;
    if (!at) throw new BadRequestException('scheduledAt is required (or set publish_at on the order)');

    let creative: SponsoredCreative;
    if (o.creative != null) creative = parseCreative(o.creative);
    else if (input.text?.trim()) creative = creativeFromText(input.text);
    else throw new BadRequestException('the order has no creative and no text was given');

    const info = { advertiser: o.advertiser, sponsorLabel: o.sponsor_label };
    const lint = lintSponsored(creative, { linkStyle: 'inline', language: 'uk' }, info);
    if (!lint.ok) throw new BadRequestException(`creative invalid: ${lint.errors.map((e) => e.message).join('; ')}`);
    if (o.creative == null) await this.repo.update(id, { creative });

    const preview = htmlToPlain(renderSponsored(creative, { linkStyle: 'inline' }, info).preview);
    const action = await this.actions.create({
      type: 'schedule_post',
      threadId: o.thread_id ?? null,
      payload: { text: preview, channelId, scheduledAt: at.toISOString(), orderId: o.id },
    });
    await this.repo.attachAction(id, action.id);
    return { actionId: action.id };
  }
}
