import type { ChannelMode, EditorCard } from '../card';
import { parseResourceRef } from '../agents/agent.types';
import { PostSpecSchema } from '../post/post-spec';
import { similarity } from '../post/similarity';
import type { TgMessage } from '../post/render-telegram';
import { PlatformPostSpecSchema, type RenderedPlatformPost } from '../platform/platform-spec';
import { publishApprovedPlatform, type PublishPlatformDeps } from '../platform/publish-platform';
import { sendRendered, type PublishSpecDeps } from '../publish/publish-spec';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import { SIMILARITY_LIMIT } from '../tools/role-tools';
import { localDate, zonedToUtc } from '../roles/time';
import type { ApprovalsRepository } from './approvals.repository';
import { PAUSED_ERROR, slotRef } from '../pauses/resource-pauses';

export interface ApprovalPublisherDeps {
  repo:     Pick<ApprovalsRepository, 'claimApprovedDue' | 'publishedSource' | 'publishedTexts' | 'cancelPlatformPosts'>;
  plans:    Pick<EditorPlansRepository, 'updateSlot' | 'countPublishedSince'>;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  /** The effective mode of the channel now (orchestrator ∧ card). */
  mode:     (card: EditorCard) => Promise<ChannelMode>;
  /** The live Telegram send path (publisher, publication row, throttle, mirrors). */
  telegram: PublishSpecDeps;
  /** The live platform path (019). */
  platform: PublishPlatformDeps;
  /** Spec 022: Bot API forwardMessage into `toKey` (an approved repost); returns the new message id. */
  forward?: (toKey: string, fromKey: string, messageId: number) => Promise<number>;
  /** The owner sees a post dropped after approval (dedup) in the inbox (English); `alert` is the Telegram alert's wording. */
  notice?:  (slot: EditorSlot, title: string, body: string, alert?: { title: string; body: string }) => Promise<void>;
  /** Spec 020: an idea becomes `used` once its slots are done. */
  onSlotDone?: (slot: EditorSlot) => Promise<void>;
  /** Spec 025 FR-013: an approved post on a paused resource is skipped (`resource_paused`), not sent. */
  paused?:  (ref: string) => Promise<boolean>;
  log?:     (msg: string) => void;
}

export const APPROVED_CLAIM_BATCH = 5;

type Outcome = 'published' | 'skipped' | 'failed';

/**
 * Publishes posts the owner approved, at their time (spec 031 FR-006). The
 * only code that sends an approval-mode post: it claims a slot only with
 * `approved_at`, re-checks what can change while a post waits (mode, pause,
 * dedup, cap) and sends the stored render unchanged — what the owner approved
 * is exactly what goes out.
 */
export class ApprovalPublisher {
  constructor(private readonly d: ApprovalPublisherDeps) {}

  async publishDue(now: Date): Promise<{ published: number; skipped: number; failed: number }> {
    const out = { published: 0, skipped: 0, failed: 0 };
    for (const slot of await this.d.repo.claimApprovedDue(now, APPROVED_CLAIM_BATCH)) {
      let r: Outcome;
      try {
        r = await this.publishOne(slot, now);
      } catch (err: any) {
        r = 'failed';
        await this.fail(slot, `publish failed: ${err?.message ?? err}`);
      }
      out[r]++;
      if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
    }
    return out;
  }

  private async fail(slot: EditorSlot, error: string): Promise<'failed'> {
    await this.d.plans.updateSlot(slot.id, { status: 'failed', error: error.slice(0, 2000) });
    return 'failed';
  }

  private async skip(slot: EditorSlot, reason: string, notice?: DedupNotice): Promise<'skipped'> {
    await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: reason });
    if (slot.platformPostId) await this.d.repo.cancelPlatformPosts([slot.platformPostId], reason);
    if (notice && this.d.notice) await this.d.notice(slot, notice.title, notice.body, notice.alert).catch(() => {});
    return 'skipped';
  }

  private async publishOne(slot: EditorSlot, now: Date): Promise<Outcome> {
    if (!slot.approvedAt) return this.fail(slot, 'not approved'); // unreachable: the claim requires approved_at
    const card = await this.d.card(slot.channelKey);
    if (!card) return this.fail(slot, 'no channel card');
    const mode = await this.d.mode(card);
    if (mode === 'off' || mode === 'shadow') return this.skip(slot, 'mode_changed');
    if (this.d.paused && await this.d.paused(slotRef(slot))) return this.skip(slot, PAUSED_ERROR);
    const render = slot.renderMessages;
    if (!render) return this.fail(slot, 'approved post has no stored render');

    if (render.kind === 'forward') {
      // An approved repost (spec 022): the same native forward the live path makes, at the slot time.
      if (!this.d.forward) return this.fail(slot, 'forwarding is not available in this process');
      try {
        const id = await this.d.forward(slot.channelKey, render.fromKey, render.messageId);
        await this.d.plans.updateSlot(slot.id, { status: 'published', renderedPreview: `↪️ Forwarded ${render.fromKey}/${render.messageId} → ${id}`, error: null });
        return 'published';
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (/not found|message to forward/i.test(msg)) return this.skip(slot, `source_missing: ${msg}`.slice(0, 2000));
        return this.fail(slot, msg);
      }
    }

    const target = slot.resourceRef ? parseResourceRef(slot.resourceRef) : null;
    if (target && target.platform !== 'telegram') {
      if (render.kind !== 'platform') return this.fail(slot, 'stored render is not a platform post');
      const spec = PlatformPostSpecSchema.safeParse(slot.postSpec);
      if (!spec.success || !slot.platformPostId) return this.fail(slot, 'approved platform post is incomplete');
      const r = await publishApprovedPlatform(this.d.platform, {
        resourceRef: slot.resourceRef!, postId: slot.platformPostId, spec: spec.data, rendered: render.rendered as unknown as RenderedPlatformPost,
      });
      if ('error' in r) {
        if (r.error === 'dedup_after_approval') return this.skip(slot, 'dedup_after_approval', dedupNotice(slot, { en: 'a similar source or idea went out on this resource while the post waited', uk: r.details }));
        return this.fail(slot, `${r.error}${r.details ? `: ${r.details}` : ''}`);
      }
      await this.d.plans.updateSlot(slot.id, { status: 'published', error: r.warnings.length ? r.warnings.join(' | ').slice(0, 2000) : null });
      return 'published';
    }

    if (render.kind !== 'telegram') return this.fail(slot, 'stored render is not a Telegram post');
    const parsed = PostSpecSchema.safeParse(slot.postSpec);
    if (!parsed.success) return this.fail(slot, 'approved post has an invalid spec');
    const spec = parsed.data;

    // Dedup after approval: the source or a near-identical text went out while the post waited.
    const ref = spec.library_ref ?? spec.source?.url ?? null;
    if (ref && await this.d.repo.publishedSource(slot.channelKey, ref, slot.id)) {
      return this.skip(slot, 'dedup_after_approval', dedupNotice(slot, { en: 'this source was already published in the channel', uk: 'це джерело вже опубліковано в каналі' }));
    }
    const preview = slot.renderedPreview ?? '';
    const maxSim = (await this.d.repo.publishedTexts(slot.channelKey, slot.id)).reduce((m, t) => Math.max(m, similarity(preview, t)), 0);
    if (preview && maxSim >= SIMILARITY_LIMIT) {
      return this.skip(slot, 'dedup_after_approval', dedupNotice(slot, { en: `similarity ${maxSim.toFixed(2)} with a published post`, uk: `схожість ${maxSim.toFixed(2)} з опублікованим постом` }));
    }
    const dayStart = zonedToUtc(localDate(now, card.timezone), '00:00', card.timezone);
    const today = await this.d.plans.countPublishedSince(slot.channelKey, dayStart);
    if (today >= card.postsPerDayMax) return this.fail(slot, `daily_cap_reached: ${today}/${card.postsPerDayMax}`);

    // The stored render — exactly what the owner approved. A paused channel throws in the publisher (failed path).
    try {
      const res = await sendRendered(this.d.telegram, {
        channelKey: slot.channelKey, spec, card, sourceRef: ref, mediaKey: slot.id, slotId: slot.id,
        onPublished: async (p) => {
          await this.d.plans.updateSlot(slot.id, {
            status: 'published', publishedPostId: p.postId, error: p.partialError ? `partial: ${p.partialError}` : null,
          });
        },
      }, {
        rendered: { messages: render.messages as TgMessage[], primary: render.primary, preview },
        prepared: slot.preparedMedia ?? {},
      });
      if (res.mirrorWarnings.length) {
        const partial = res.partialError ? `partial: ${res.partialError}` : null;
        await this.d.plans.updateSlot(slot.id, { error: [partial, ...res.mirrorWarnings].filter(Boolean).join(' | ').slice(0, 2000) }).catch(() => {});
      }
      return 'published';
    } catch (err: any) {
      return this.fail(slot, String(err?.message ?? err));
    }
  }
}

type DedupNotice = { title: string; body: string; alert: { title: string; body: string } };

/** Inbox copy is English (AI0-79); the Telegram alert keeps its wording. */
function dedupNotice(slot: EditorSlot, details: { en: string; uk?: string }): DedupNotice {
  const ref = slot.resourceRef ?? slot.channelKey;
  return {
    title: `♻️ ${ref}: an approved post did not go out — duplicate`,
    body: `"${slot.topic}" skipped (dedup_after_approval): ${details.en}.`,
    alert: {
      title: `♻️ ${ref}: апрувнутий пост не вийшов — дубль`,
      body: `«${slot.topic}» пропущено (dedup_after_approval)${details.uk ? `: ${details.uk}` : ''}.`,
    },
  };
}
