// group-fanout.service.ts — one shared fan-out path. After a strategy publishes
// to a group member, mirror the SAME content to every OTHER member — but only
// when the member just published to IS the group's designated source. Meta
// targets go through the dispatcher (full carousel or single); the Telegram
// target gets the cover image + caption (the bot API has no album). Each target
// is isolated: one failure never blocks the others or the primary publish.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TikTokCarouselPublisher } from '../../publishers/tiktok/tiktok-carousel.publisher';
import { DestinationResolver } from './destination-resolver.service';
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import { TelegramPublisher } from '../../publishers/telegram.publisher';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import { RunTracer } from '../observability/run-tracer.service';
import type { PublishDestination, DestinationPlatform } from './publish-destination';
import type { MetaPlatform } from '../../config/meta-accounts.repository';

export interface GroupContent {
  caption: string;
  /** Optional per-target caption (e.g. platform-specific hashtags / Telegram
   *  link). Called with each target's platform; falls back to `caption`. */
  captionFor?: (platform: DestinationPlatform) => string;
  tags: string[];
  /** >=1 image URL. Meta gets a carousel when `carousel` is true, else a single
   *  post from imageUrls[0]. Telegram always gets imageUrls[0] (cover). */
  imageUrls: string[];
  /** Whether Meta targets receive a multi-image carousel/album. */
  carousel: boolean;
  /**
   * Optional per-target content (editor agent): when set it replaces caption /
   * images / carousel for that target; null skips the target.
   */
  render?: (platform: DestinationPlatform) => { caption: string; imageUrls: string[]; carousel: boolean } | null;
}

/**
 * Spec 024 FR-003: the one gate for automatic duplication
 * (NetworkRepository.autoDuplicateActive). False → the group is an independent
 * network whose agent decides per resource, so nothing is mirrored.
 */
export interface AutoDuplicateGate {
  autoDuplicateActive(groupId: string): Promise<boolean>;
}
export const AUTO_DUPLICATE_GATE = 'AUTO_DUPLICATE_GATE';

/** Per-target result. Strategies ignore it; the editor records failures on the slot. */
export interface FanOutOutcome {
  platform: string;
  status:   'ok' | 'skipped' | 'failed';
  detail?:  string;
}

@Injectable()
export class GroupFanOutService {
  private readonly logger = new Logger(GroupFanOutService.name);

  constructor(
    private readonly resolver:   DestinationResolver,
    private readonly dispatcher: PublisherDispatcher,
    private readonly telegram:   TelegramPublisher,
    private readonly tracer:     RunTracer,
    @Optional() private readonly tiktok?: TikTokCarouselPublisher,
    @Optional() @Inject(AUTO_DUPLICATE_GATE) private readonly gate?: AutoDuplicateGate | null,
  ) {}

  /** Unknown (no gate wired, DB error) → keep mirroring as before. */
  private async gateOpen(groupId: string): Promise<boolean> {
    if (!this.gate) return true;
    try {
      return await this.gate.autoDuplicateActive(groupId);
    } catch (err: any) {
      this.logger.warn(`auto-duplicate gate of group ${groupId} failed, mirroring: ${err?.message ?? err}`);
      return true;
    }
  }

  /**
   * @param source     the destination the strategy just published to
   * @param content    the rendered content to mirror
   * @param markPosted records the per-target dedup key on success
   */
  async fanOut(
    source: PublishDestination,
    content: GroupContent,
    markPosted: (postedKey: string) => Promise<void>,
  ): Promise<FanOutOutcome[]> {
    const outcomes: FanOutOutcome[] = [];
    const group = await this.resolver.resolveGroupForDest(source);
    if (!group || !group.isSource) return outcomes; // not a source publish → nothing to mirror

    const targets = await this.resolver.resolveGroupTargets(group.groupId, source.platform);
    if (!(await this.gateOpen(group.groupId))) {
      for (const t of targets) {
        outcomes.push({ platform: t.platform, status: 'skipped', detail: 'independent network' });
        this.tracer.event('GroupFanOut', `publish:${t.platform}`, 'skipped', 'independent network');
      }
      this.logger.debug(`Fan-out skipped for group ${group.groupId}: independent network`);
      return outcomes;
    }
    for (const t of targets) {
      try {
        let id: string;
        let text = content.captionFor ? content.captionFor(t.platform) : content.caption;
        let imageUrls = content.imageUrls;
        let carousel = content.carousel;
        if (content.render) {
          const r = content.render(t.platform);
          if (!r) { outcomes.push({ platform: t.platform, status: 'skipped', detail: 'not supported for this post' }); continue; }
          ({ caption: text, imageUrls, carousel } = r);
          carousel = carousel && imageUrls.length >= 2;
        }
        if (t.platform === 'tiktok') {
          // TikTok photo mode: needs at least one hosted image (spec 019 — the mirror gap fix).
          if (!this.tiktok) { outcomes.push({ platform: t.platform, status: 'skipped', detail: 'tiktok publisher unavailable' }); continue; }
          if (!imageUrls.length) { outcomes.push({ platform: t.platform, status: 'skipped', detail: 'tiktok needs an image' }); continue; }
          // Meta-bound captions arrive HTML-escaped (their publishers strip HTML); TikTok takes plain text.
          const plain = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
          id = await this.tiktok.publishCarousel(t.targetId, imageUrls, plain);
        } else if (t.platform === 'telegram') {
          id = await this.telegram.publish(
            { text, imageUrl: imageUrls[0], source: '', tags: content.tags },
            { id: t.targetId, token: '' },
          );
        } else if (carousel) {
          id = await this.dispatcher.publishCarousel(
            t.platform as MetaPlatform,
            { text, tags: content.tags, source: '' },
            imageUrls,
            { id: t.targetId, token: t.token! },
          );
        } else {
          id = await this.dispatcher.publish(
            t.platform as MetaPlatform,
            { text, imageUrl: imageUrls[0], source: '', tags: content.tags },
            { id: t.targetId, token: t.token! },
          );
        }
        await markPosted(t.postedKey);
        outcomes.push({ platform: t.platform, status: 'ok', detail: String(id) });
        this.logger.debug(`Fan-out → ${t.platform} (${id})`);
        // Record the (previously invisible) per-target outcome in the run trace.
        this.tracer.event('GroupFanOut', `publish:${t.platform}`, 'ok', id);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`Fan-out failed → ${t.platform}: ${msg}`);
        // Isolated failure: never rethrown, but now surfaced as an error step so
        // a failed IG/Threads/FB mirror is visible in the activity log.
        this.tracer.event('GroupFanOut', `publish:${t.platform}`, 'error', err);
        outcomes.push({ platform: t.platform, status: 'failed', detail: msg });
        if (isPermanentMetaMediaError(msg)) {
          try { await markPosted(t.postedKey); } catch { /* best-effort */ }
        }
      }
    }
    return outcomes;
  }
}
