// group-fanout.service.ts — one shared fan-out path. After a strategy publishes
// to a group member, mirror the SAME content to every OTHER member — but only
// when the member just published to IS the group's designated source. Meta
// targets go through the dispatcher (full carousel or single); the Telegram
// target gets the cover image + caption (the bot API has no album). Each target
// is isolated: one failure never blocks the others or the primary publish.
import { Injectable, Logger } from '@nestjs/common';
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
}

@Injectable()
export class GroupFanOutService {
  private readonly logger = new Logger(GroupFanOutService.name);

  constructor(
    private readonly resolver:   DestinationResolver,
    private readonly dispatcher: PublisherDispatcher,
    private readonly telegram:   TelegramPublisher,
    private readonly tracer:     RunTracer,
  ) {}

  /**
   * @param source     the destination the strategy just published to
   * @param content    the rendered content to mirror
   * @param markPosted records the per-target dedup key on success
   */
  async fanOut(
    source: PublishDestination,
    content: GroupContent,
    markPosted: (postedKey: string) => Promise<void>,
  ): Promise<void> {
    const group = await this.resolver.resolveGroupForDest(source);
    if (!group || !group.isSource) return; // not a source publish → nothing to mirror

    const targets = await this.resolver.resolveGroupTargets(group.groupId, source.platform);
    for (const t of targets) {
      try {
        let id: string;
        const text = content.captionFor ? content.captionFor(t.platform) : content.caption;
        if (t.platform === 'telegram') {
          id = await this.telegram.publish(
            { text, imageUrl: content.imageUrls[0], source: '', tags: content.tags },
            { id: t.targetId, token: '' },
          );
        } else if (content.carousel) {
          id = await this.dispatcher.publishCarousel(
            t.platform as MetaPlatform,
            { text, tags: content.tags, source: '' },
            content.imageUrls,
            { id: t.targetId, token: t.token! },
          );
        } else {
          id = await this.dispatcher.publish(
            t.platform as MetaPlatform,
            { text, imageUrl: content.imageUrls[0], source: '', tags: content.tags },
            { id: t.targetId, token: t.token! },
          );
        }
        await markPosted(t.postedKey);
        this.logger.debug(`Fan-out → ${t.platform} (${id})`);
        // Record the (previously invisible) per-target outcome in the run trace.
        this.tracer.event('GroupFanOut', `publish:${t.platform}`, 'ok', id);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`Fan-out failed → ${t.platform}: ${msg}`);
        // Isolated failure: never rethrown, but now surfaced as an error step so
        // a failed IG/Threads/FB mirror is visible in the activity log.
        this.tracer.event('GroupFanOut', `publish:${t.platform}`, 'error', err);
        if (isPermanentMetaMediaError(msg)) {
          try { await markPosted(t.postedKey); } catch { /* best-effort */ }
        }
      }
    }
  }
}
