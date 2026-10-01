import type { ComposedPost } from '../scheduled-posts/scheduled-posts.types';
import type { EditorCard } from '../editor/card';
import type { ReserveSlotInput } from '../editor/repo/editor-plans.repository';
import { localDate } from '../editor/roles/time';
import { composeText } from '../editor/post/render-telegram';
import {
  SponsoredCreative, SponsoredCreativeSchema, creativeFromText, creativeToSpec, renderSponsored, sponsoredFooter,
} from '../editor/post/sponsored';

export interface ChannelRef {
  /** tracked_channels.id (scheduled_publications FK). */
  trackedId:  string;
  /** tracked_channels.channel_key (editor + published_posts key). */
  channelKey: string | null;
  /** Bot that publishes for the channel: its own bot, else the default bot. */
  botId:      string | null;
}

export interface PlacementOrder {
  id:            string;
  advertiser:    string;
  sponsor_label: string | null;
  creative:      unknown;
}

export interface AdPlacementPorts {
  editorEnabled(): boolean;
  channelRef(idOrKey: string): Promise<ChannelRef | null>;
  card(channelKey: string): Promise<Pick<EditorCard, 'timezone' | 'linkStyle'> | null>;
  reserveSlot(i: ReserveSlotInput): Promise<string>;
  createScheduledPost(p: ComposedPost): Promise<{ id: string }>;
  findOrder(id: string): Promise<PlacementOrder | null>;
  setPlacement(orderId: string, p: { slotId: string | null; publishAt: Date }): Promise<void>;
}

export type Placement = { kind: 'reserved_slot' | 'scheduled_post'; id: string };

/**
 * Executes an approved `schedule_post` action (spec 008 T003).
 *
 * Precedence for an order-backed action (payload.orderId):
 *   1. EDITOR_ENABLED=true AND the channel has an editor card (any mode) →
 *      a reserved editor slot. The editor scheduler publishes it with the
 *      SponsoredPublisher at the agreed time, no LLM, and the order moves to
 *      published → reported automatically.
 *   2. Otherwise → the SP2 scheduled_posts queue (rendered creative incl. the
 *      #реклама line). The order stays `scheduled`: no automatic post link or report.
 * A legacy action without orderId keeps the old plain-text scheduled_posts behaviour.
 */
export class AdPlacement {
  constructor(private readonly p: AdPlacementPorts) {}

  async place(input: { channelId: string; text: string; scheduledAt: string; orderId?: string | null }): Promise<Placement> {
    const at = new Date(input.scheduledAt);
    if (Number.isNaN(at.getTime())) throw new Error(`invalid scheduledAt ${input.scheduledAt}`);
    const ref = await this.p.channelRef(input.channelId);

    if (!input.orderId) return this.legacy(input, ref);

    const order = await this.p.findOrder(input.orderId);
    if (!order) throw new Error(`ad order ${input.orderId} not found`);
    const creative: SponsoredCreative = order.creative != null ? SponsoredCreativeSchema.parse(order.creative) : creativeFromText(input.text);
    const info = { advertiser: order.advertiser, sponsorLabel: order.sponsor_label };

    const card = ref?.channelKey && this.p.editorEnabled() ? await this.p.card(ref.channelKey) : null;
    if (ref?.channelKey && card) {
      const slotId = await this.p.reserveSlot({
        channelKey: ref.channelKey, planDate: localDate(at, card.timezone), scheduledAt: at,
        format: creative.format, topic: `Реклама: ${order.advertiser}`.slice(0, 300),
        sourceHints: [`ad_order:${order.id}`], postSpec: creative,
      });
      await this.p.setPlacement(order.id, { slotId, publishAt: at });
      return { kind: 'reserved_slot', id: slotId };
    }

    const rendered = renderSponsored(creative, { linkStyle: 'inline' }, info);
    const first = rendered.messages[0];
    const buttons = first && 'buttons' in first ? first.buttons : [];
    const image = creative.media[0]?.url ?? null;
    const post = await this.p.createScheduledPost({
      channelId:      ref?.trackedId ?? input.channelId,
      sender:         'bot',
      botId:          ref?.botId ?? null,
      text:           composeText(creativeToSpec(creative, info), { footer: sponsoredFooter(info), linkStyle: 'inline' }),
      mediaType:      image ? 'photo' : 'none',
      mediaUrl:       image,
      mediaPlacement: creative.placement,
      buttons:        buttons.map((row) => ({ buttons: row.map((b) => ({ label: b.text, url: b.url })) })),
      scheduledAt:    at.toISOString(),
    });
    await this.p.setPlacement(order.id, { slotId: null, publishAt: at });
    return { kind: 'scheduled_post', id: post.id };
  }

  /** Pre-008 behaviour: plain text into scheduled_posts (now with the channel's bot, so the worker can send it). */
  private async legacy(input: { channelId: string; text: string; scheduledAt: string }, ref: ChannelRef | null): Promise<Placement> {
    const post = await this.p.createScheduledPost({
      channelId:      ref?.trackedId ?? input.channelId,
      sender:         'bot',
      botId:          ref?.botId ?? null,
      text:           input.text,
      mediaType:      'none',
      mediaUrl:       null,
      mediaPlacement: 'below',
      buttons:        [],
      scheduledAt:    input.scheduledAt,
    });
    return { kind: 'scheduled_post', id: post.id };
  }
}
