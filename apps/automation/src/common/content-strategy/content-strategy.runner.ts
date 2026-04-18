import { Injectable, Logger } from '@nestjs/common';
import { ReviewAgent }          from '../ai/agents/review.agent';
import { DedupService }         from '../dedup/dedup.service';
import { ImageResolverService } from '../processors/image-resolver.service';
import { TelegramPublisher }      from '../../publishers/telegram.publisher';
import { TelegramNotifier }       from '../../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../../publishers/posting-throttle.service';
import {
  ContentStrategy,
  StrategyParams,
} from './content-strategy.interface';

@Injectable()
export class ContentStrategyRunner {
  private readonly logger = new Logger(ContentStrategyRunner.name);

  constructor(
    private readonly reviewer:  ReviewAgent,
    private readonly dedup:     DedupService,
    private readonly images:    ImageResolverService,
    private readonly telegram:  TelegramPublisher,
    private readonly notifier:  TelegramNotifier,
    private readonly throttle:  PostingThrottleService,
  ) {}

  /**
   * Execute a content strategy for a specific channel with given params.
   * Pipeline: fetch → dedup → generate → review → publish → mark posted.
   */
  async run(
    strategy: ContentStrategy,
    channelId: string,
    params: StrategyParams,
    strategyId: string,
  ): Promise<void> {
    const tag = `[${strategyId}]`;

    if (!this.throttle.canPublish(channelId)) {
      this.throttle.logCooldown(strategyId, channelId);
      return;
    }

    this.logger.log(`${tag} Starting`);

    // Full pipeline override
    if (strategy.execute) {
      await strategy.execute(channelId, params);
      this.logger.log(`${tag} Finished (custom execute)`);
      return;
    }

    // 1. Fetch
    const fetchResult = await strategy.fetch(params, channelId);
    if (!fetchResult) {
      this.logger.log(`${tag} Nothing to publish`);
      return;
    }

    this.logger.debug(`${tag} Fetched: ${fetchResult.title}`);

    // 2. Dedup
    const unposted = await this.dedup.filterUnposted(
      [{
        title:   fetchResult.title,
        content: null,
        image:   null,
        source:  fetchResult.sourceUrl,
        tags:    [fetchResult.contentType],
        isoDate: new Date().toISOString(),
      }],
      channelId,
    );

    if (!unposted.length) {
      this.logger.log(`${tag} Already posted: ${fetchResult.title}`);
      return;
    }

    // 3. Generate (AI)
    const post = await strategy.generate(fetchResult, params);

    if (post === 'SKIP_POST') {
      this.logger.warn(`${tag} SKIP_POST signalled — marking as posted`);
      await this.dedup.markPosted(
        fetchResult.sourceUrl, fetchResult.title, channelId, fetchResult.contentType,
      );
      return;
    }

    if (!post) {
      this.logger.warn(`${tag} Generation failed — will retry next run`);
      return;
    }

    // 4. Review
    const skills   = strategy.getSkills(params);
    const reviewed = await this.reviewer.review(post.text, skills);

    // 5. Download image (if any)
    let imageBuffer: Buffer | undefined;
    if (post.imageUrl) {
      imageBuffer = (await this.images.download(post.imageUrl)) ?? undefined;
    }

    // 6. Publish
    try {
      let messageId: string;
      if (imageBuffer && reviewed.length <= 1024) {
        messageId = await this.telegram.publishPrompt(
          { imageBuffer, caption: reviewed },
          { id: channelId },
        );
      } else {
        messageId = await this.telegram.publish(
          {
            text:     reviewed,
            imageBuffer,
            imageUrl: post.imageUrl,
            source:   post.sourceUrl,
            tags:     [post.contentType],
            title:    post.title,
          },
          { id: channelId },
        );
      }

      await this.dedup.markPosted(
        post.sourceUrl, post.title, channelId, post.contentType,
      );
      this.logger.log(`${tag} Published: ${post.title}`);
      await this.notifier.notifyPublished(channelId, messageId);
    } catch (err) {
      this.logger.error(`${tag} Publish failed: ${err.message}`);
      await this.notifier.notifyFailed(channelId, err.message, post.sourceUrl);
    }
  }
}
