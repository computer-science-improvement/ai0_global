import { Injectable, Logger } from '@nestjs/common';
import { ReviewAgent }          from '../ai/agents/review.agent';
import { DedupService }         from '../dedup/dedup.service';
import { ImageResolverService } from '../processors/image-resolver.service';
import { TelegramPublisher }      from '../../publishers/telegram.publisher';
import { TelegramNotifier }       from '../../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../../publishers/posting-throttle.service';
import { CrossPostService }       from '../../publishers/cross-post.service';
import { PublicationsRepository } from '../../stats/publications.repository';
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
    private readonly publications: PublicationsRepository,
    private readonly crossPost: CrossPostService,
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

    // Atomic in-flight lock: prevents the parallel-cron race where N
    // strategies for the same channel all pass canPublish() in the same
    // tick and then all publish. tryLock() grabs the slot synchronously;
    // concurrent callers see it taken and bail out. The lock is released
    // on every skip/error path so the next cron tick can immediately retry
    // without bumping the 20-min cooldown timestamp.
    if (!this.throttle.tryLock(channelId)) {
      this.throttle.logCooldown(strategyId, channelId);
      return;
    }

    this.logger.log(`${tag} Starting`);

    // Full pipeline override. Strategies with custom execute() are
    // responsible for calling telegram.publisher.publish() on success
    // (which calls recordPublish → releases the lock + sets cooldown).
    // For ALL non-publish exit paths (skips, errors, dedup-hits) we
    // release the lock here in a finally — those exits don't bump
    // cooldown, so the next cron tick can immediately retry.
    if (strategy.execute) {
      try {
        await strategy.execute(channelId, params);
      } catch (err: any) {
        this.logger.error(`${tag} Strategy execute failed: ${err.message}`);
      } finally {
        // tryLock() invariant: we got here only because canPublish() was
        // true (no prior publish in the window). If the strategy published
        // via telegram.publisher → recordPublish bumped lastPublishedAt
        // and remainingMs is now ~cooldownMs. If it skipped, remainingMs
        // is still 0. Use that to decide: only release the lock when there
        // was NO publish, so skips don't waste the 20-min window.
        if (this.throttle.remainingMs(channelId) === 0) {
          this.throttle.releaseLock(channelId);
        }
      }
      this.logger.log(`${tag} Finished (custom execute)`);
      return;
    }

    // 1. Fetch
    const fetchResult = await strategy.fetch(params, channelId);
    if (!fetchResult) {
      this.throttle.releaseLock(channelId);
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
      this.throttle.releaseLock(channelId);
      this.logger.log(`${tag} Already posted: ${fetchResult.title}`);
      return;
    }

    // 3. Generate (AI)
    const post = await strategy.generate(fetchResult, params);

    if (post === 'SKIP_POST') {
      this.throttle.releaseLock(channelId);
      this.logger.warn(`${tag} SKIP_POST signalled — marking as posted`);
      await this.dedup.markPosted(
        fetchResult.sourceUrl, fetchResult.title, channelId, fetchResult.contentType,
      );
      return;
    }

    if (!post) {
      this.throttle.releaseLock(channelId);
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
      await this.publications.insert({
        channelId,
        messageId,
        sourceUrl:    post.sourceUrl,
        title:        post.title,
        strategyType: strategy.type,
        tags:         [post.contentType],
      });

      // Fan out to any configured Meta cross-post targets for this channel
      // (mirror mode). Never throws — Meta failures are isolated + logged.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text: reviewed, tags: [post.contentType], imageUrl: post.imageUrl },
      });
    } catch (err) {
      this.throttle.releaseLock(channelId);
      this.logger.error(`${tag} Publish failed: ${err.message}`);
      await this.notifier.notifyFailed(channelId, err.message, post.sourceUrl);
    }
  }
}
