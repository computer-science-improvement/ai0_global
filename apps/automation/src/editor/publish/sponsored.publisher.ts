import type { EditorCard } from '../card';
import type { EditorPlansRepository, EditorSlot, SlotResultPatch } from '../repo/editor-plans.repository';
import { lintSponsored, renderSponsored, SponsoredCreativeSchema } from '../post/sponsored';
import type { TgMessage } from '../post/render-telegram';
import type { SendResult } from './telegram-editor.publisher';
import { ChannelPausedForEditorError } from './telegram-editor.publisher';

/** A reserved slot is never posted more than this long after the agreed time. */
export const RESERVED_MAX_LATE_MS = 6 * 3600_000;
export const RESERVED_CLAIM_BATCH = 5;

export interface SponsoredOrder {
  id:           string;
  advertiser:   string;
  sponsorLabel: string | null;
  status:       string;
  creative:     unknown;
  /** ad_prices.format of the order ('post' | 'pin_24h' | 'digest_sponsor'), null for orders without a price. */
  format?:      string | null;
}

export interface SponsoredOrdersPort {
  /** The ad order that owns a reserved slot (ad_orders.editor_slot_id). */
  findBySlot(slotId: string): Promise<SponsoredOrder | null>;
  /** status → published, published_post_id set, report token issued. */
  markPublished(orderId: string, postId: number): Promise<void>;
}

export interface SponsoredPublisherDeps {
  plans:         Pick<EditorPlansRepository, 'claimDueReserved' | 'updateSlot' | 'insertPublication'>;
  channels:      { get(channelKey: string): Promise<Pick<EditorCard, 'linkStyle' | 'language'> | null> };
  publisher:     { send(channelKey: string, messages: TgMessage[]): Promise<SendResult> };
  orders:        SponsoredOrdersPort;
  recordPublish: (channelKey: string) => void;
  notify:        (text: string) => Promise<void>;
  log?:          (msg: string) => void;
}

const DEFAULT_CARD: Pick<EditorCard, 'linkStyle' | 'language'> = { linkStyle: 'inline', language: 'uk' };

/**
 * Publishes reserved (paid ad) slots deterministically — no LLM, no editor
 * mode check (a paid ad goes out even when the channel's editor is off or in
 * shadow). The channel's publish_paused kill switch still applies (enforced by
 * TelegramEditorPublisher). The creative is the snapshot approved by the owner
 * (slot.post_spec), rendered with the code-added #реклама label. Failures are
 * final (status failed + owner alert) so a post can never be sent twice.
 */
export class SponsoredPublisher {
  constructor(private readonly d: SponsoredPublisherDeps) {}

  async publishDue(now: Date): Promise<number> {
    const slots = await this.d.plans.claimDueReserved(now, RESERVED_CLAIM_BATCH);
    let published = 0;
    for (const slot of slots) {
      if (await this.publishClaimed(slot, now)) published++;
    }
    return published;
  }

  /** Publish one already-claimed (running) reserved slot through the ad path. Never throws. */
  async publishClaimed(slot: EditorSlot, now: Date): Promise<boolean> {
    try {
      return await this.publishSlot(slot, now);
    } catch (err: any) {
      return this.fail(slot, `crashed: ${err?.message ?? err}`);
    }
  }

  private async publishSlot(slot: EditorSlot, now: Date): Promise<boolean> {
    const order = await this.d.orders.findBySlot(slot.id);
    if (!order) return this.fail(slot, 'no ad order owns this reserved slot');
    if (order.status === 'canceled') {
      await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: 'ad order canceled' });
      return false;
    }
    const lateMs = now.getTime() - slot.scheduledAt.getTime();
    if (lateMs > RESERVED_MAX_LATE_MS) {
      return this.fail(slot, `missed window: ${Math.round(lateMs / 60_000)} min late`, order);
    }

    const card = (await this.d.channels.get(slot.channelKey)) ?? DEFAULT_CARD;
    const info = { advertiser: order.advertiser, sponsorLabel: order.sponsorLabel };
    const raw = slot.postSpec ?? order.creative;
    const lint = lintSponsored(raw, card, info);
    if (!lint.ok) return this.fail(slot, `creative invalid: ${lint.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`, order);
    const creative = SponsoredCreativeSchema.parse(raw);
    const rendered = renderSponsored(creative, card, info);

    let sent: SendResult;
    try {
      sent = await this.d.publisher.send(slot.channelKey, rendered.messages);
    } catch (err: any) {
      const reason = err instanceof ChannelPausedForEditorError ? err.message : `send failed: ${err?.message ?? err}`;
      return this.fail(slot, reason, order);
    }

    const messageId = sent.messageIds[rendered.primary] ?? sent.messageIds[0];
    const postId = await this.d.plans.insertPublication({
      channelKey: slot.channelKey, messageId, sourceUrl: `ad://order/${order.id}`, title: `Реклама: ${order.advertiser}`.slice(0, 120),
      tags: ['реклама'], format: creative.format, slotId: slot.id, strategyType: 'ad',
    });
    this.d.recordPublish(slot.channelKey);
    const patch: SlotResultPatch = {
      status: 'published', publishedPostId: postId, renderedPreview: rendered.preview,
      error: sent.partialError ? `partial: ${sent.partialError}` : null,
    };
    await this.d.plans.updateSlot(slot.id, patch);
    await this.d.orders.markPublished(order.id, postId);
    const pin = order.format === 'pin_24h' ? '\n📌 Формат pin_24h: закріпи цей пост на 24 год і відкріпи після.' : '';
    await this.safeNotify(`💰 Реклама «${order.advertiser}» опублікована в ${slot.channelKey} (msg ${messageId}).${pin}`);
    return true;
  }

  private async fail(slot: EditorSlot, error: string, order?: SponsoredOrder): Promise<false> {
    await this.d.plans.updateSlot(slot.id, { status: 'failed', error });
    this.d.log?.(`reserved slot ${slot.id} failed: ${error}`);
    await this.safeNotify(`⚠️ Реклама${order ? ` «${order.advertiser}»` : ''} у ${slot.channelKey} не вийшла: ${error}. Перенеси замовлення на /app/ads.`);
    return false;
  }

  private async safeNotify(text: string): Promise<void> {
    try { await this.d.notify(text); } catch { /* alerts are best-effort */ }
  }
}
