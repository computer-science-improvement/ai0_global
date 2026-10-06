import { Injectable, Logger } from '@nestjs/common';
import { ReviewAgent }          from '../ai/agents/review.agent';
import { DedupService }         from '../dedup/dedup.service';
import { ImageResolverService } from '../processors/image-resolver.service';
import { TelegramPublisher }      from '../../publishers/telegram.publisher';
import { TelegramNotifier }       from '../../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../../publishers/posting-throttle.service';
import { CrossPostService }       from '../../publishers/cross-post.service';
import { PublicationsRepository } from '../../stats/publications.repository';
import { RunSkippedError, isChannelPausedError, isPermanentTelegramError } from '../../publishers/errors';
import {
  ContentStrategy,
  StrategyParams,
  isStrategyRejection,
} from './content-strategy.interface';
import type { PublishDestination } from './publish-destination';
import { withLlmContext } from '../ai/usage/llm-context';
import { strategyFeature, strategyResource } from '../ai/usage/features';

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
   * Every LLM call inside is attributed to `strategy.<id>.generate` on the
   * spend ledger (spec 029); sub-steps (review, translation …) override the feature.
   */
  run(
    strategy: ContentStrategy,
    channelId: string,
    params: StrategyParams,
    strategyId: string,
    dest?: PublishDestination,
  ): Promise<void> {
    return withLlmContext(
      { feature: strategyFeature(strategyId), resourceRef: strategyResource(strategyId) },
      () => this.runAttributed(strategy, channelId, params, strategyId, dest),
    );
  }

  private async runAttributed(
    strategy: ContentStrategy,
    channelId: string,
    params: StrategyParams,
    strategyId: string,
    dest?: PublishDestination,
  ): Promise<void> {
    const tag = `[${strategyId}]`;
    const lockKey = dest?.throttleKey ?? channelId;

    // Atomic in-flight lock: prevents the parallel-cron race where N
    // strategies for the same channel all pass canPublish() in the same
    // tick and then all publish. tryLock() grabs the slot synchronously;
    // concurrent callers see it taken and bail out. The lock is released
    // on every skip/error path so the next cron tick can immediately retry
    // without bumping the 20-min cooldown timestamp.
    if (!this.throttle.tryLock(lockKey)) {
      const reason = this.throttle.logCooldown(strategyId, lockKey) ?? 'posting cooldown / in-flight lock';
      // Not a silent return: the scheduler records this tick as 'skipped'
      // (not 'ok') so the run log says what actually happened.
      throw new RunSkippedError(`Skipped — ${reason} on ${lockKey}`);
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
        await strategy.execute(channelId, params, dest);
      } catch (err: any) {
        this.logger.error(`${tag} Strategy execute failed: ${err.message}`);
        // Surface every escaped error (Telegram and Meta alike) so the
        // scheduler records the run as an error — not 'ok' — in strategy_runs.
        // Strategies still handle their own expected failures internally; this
        // is only what escapes them. The finally below releases the lock first.
        throw err;
      } finally {
        // tryLock() invariant: we got here only because canPublish() was
        // true (no prior publish in the window). If the strategy published
        // via telegram.publisher → recordPublish bumped lastPublishedAt
        // and remainingMs is now ~cooldownMs. If it skipped, remainingMs
        // is still 0. Use that to decide: only release the lock when there
        // was NO publish, so skips don't waste the 20-min window.
        //
        // Meta destinations: the strategy's meta branch publishes via the
        // PublisherDispatcher and does NOT call recordPublish, so remainingMs
        // stays 0 and the lock is released here every tick. That's intended —
        // a Meta binding's cadence is governed by its own cron schedule, not
        // the posting cooldown. (If per-account Meta cooldown is ever needed,
        // the meta branch must call throttle.recordPublish(dest.throttleKey).)
        if (this.throttle.remainingMs(lockKey) === 0) {
          this.throttle.releaseLock(lockKey);
        }
      }
      this.logger.log(`${tag} Finished (custom execute)`);
      return;
    }

    if (dest && dest.platform !== 'telegram') {
      this.throttle.releaseLock(lockKey);
      this.logger.warn(`${tag} Meta destination not supported by the generic pipeline — skipping`);
      return;
    }

    // Generic pipeline. EVERY exit — early return, skip, or a throw from
    // fetch/dedup/generate/review/publish — goes through the finally, which
    // frees the lock unless a publish was recorded (recordPublish already
    // released it and started the cooldown; remainingMs > 0 tells us so).
    try {
      await this.runGeneric(strategy, channelId, params, tag);
    } finally {
      if (this.throttle.remainingMs(lockKey) === 0) {
        this.throttle.releaseLock(lockKey);
      }
    }
  }

  /** fetch → dedup → generate → review → publish → mark posted. Lock-free:
   *  the caller owns lock release. */
  private async runGeneric(
    strategy: ContentStrategy,
    channelId: string,
    params: StrategyParams,
    tag: string,
  ): Promise<void> {
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

    if (isStrategyRejection(post)) {
      // Permanent: this item will never yield a valid post. Mark it errored so
      // the next tick moves on instead of regenerating it forever.
      this.logger.warn(`${tag} Rejected (${post.rejected}) — marking source as errored`);
      await this.dedup.markError(
        fetchResult.sourceUrl, fetchResult.title, channelId, post.rejected,
      );
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
    let messageId: string;
    try {
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
    } catch (err) {
      this.logger.error(`${tag} Publish failed: ${err.message}`);
      // A paused channel is an expected skip, not a failure worth a DM.
      if (!isChannelPausedError(err)) {
        await this.notifier.notifyFailed(channelId, err.message, post.sourceUrl);
      }
      // Telegram rejected this content itself (unparseable HTML, bad media…):
      // retrying the same source would fail the same way every tick.
      if (isPermanentTelegramError(err)) {
        const reason = err.response?.data?.description ?? err.message;
        await this.dedup.markError(post.sourceUrl, post.title, channelId, `publish: ${reason}`);
      }
      // Rethrow so strategy_runs records 'error' (or 'skipped' when paused)
      // instead of 'ok'. The caller's finally still releases the lock.
      throw err;
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
  }
}
