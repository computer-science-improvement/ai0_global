import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync }             from 'fs';
import { join }                     from 'path';
import axios from 'axios';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';
import { TelegramNotifier }         from '../../publishers/telegram-notifier.service';
import { CrossPostService }         from '../../publishers/cross-post.service';
import { PublicationsRepository }   from '../../stats/publications.repository';
import { PublisherDispatcher }      from '../../publishers/publisher-dispatcher.service';
import { GroupFanOutService }       from '../../common/content-strategy/group-fanout.service';
import { DestinationResolver }      from '../../common/content-strategy/destination-resolver.service';
import { RunTracer }                from '../../common/observability/run-tracer.service';
import { composeMetaCaption, promptHashtags } from '../../common/content-strategy/meta-caption.util';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import { isPermanentTelegramError } from '../../publishers/errors';
import type { PublishDestination, DestinationPlatform }  from '../../common/content-strategy/publish-destination';
import type { MetaPlatform }       from '../../config/meta-accounts.repository';
import { PromptsRepository }        from './prompts.repository';
import { PromptHeroScraperService } from '../../workflows/ai0-prompts/prompthero-scraper.service';

@Injectable()
export class Ai0PromptsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(Ai0PromptsStrategy.name);

  readonly type = 'ai0-prompts';
  readonly supportedPlatforms: DestinationPlatform[] = ['telegram', 'instagram', 'facebook', 'threads'];
  private categories: string[] = [];

  constructor(
    private readonly registry: ContentStrategyRegistry,
    private readonly telegram: TelegramPublisher,
    private readonly db:       PromptsRepository,
    private readonly scraper:  PromptHeroScraperService,
    private readonly notifier: TelegramNotifier,
    private readonly publications: PublicationsRepository,
    private readonly crossPost: CrossPostService,
    private readonly dispatcher: PublisherDispatcher,
    private readonly groupFanOut: GroupFanOutService,
    private readonly destinations: DestinationResolver,
    private readonly tracer:     RunTracer,
  ) {}

  /** Meta publishing is fashion-only (per requirement). Telegram keeps the
   *  full rotation of categories. */
  private static readonly META_CATEGORY = 'fashion';

  onModuleInit() {
    const path = join(__dirname, '..', '..', '..', 'config', 'sources', 'ai0-prompts.json');
    const cfg = JSON.parse(readFileSync(path, 'utf-8')) as { categories: string[] };
    this.categories = cfg.categories;
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [];
  }

  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    return null;
  }

  async generate(
    _data: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null> {
    return null;
  }

  async execute(channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    const MIN_PROMPT_LENGTH = 50;
    const USER_AGENT =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

    const postedKey = dest?.postedKey ?? 'TELEGRAM';
    const isMeta = !!dest && dest.platform !== 'telegram';

    // 1. Pick category. Meta (FB/IG/Threads) publishes ONLY the fashion category;
    //    Telegram keeps the full random rotation.
    const category = isMeta
      ? Ai0PromptsStrategy.META_CATEGORY
      : this.categories[Math.floor(Math.random() * this.categories.length)];
    this.logger.debug(`Selected category: ${category}`);

    // 2. Get next unposted prompt from DB
    const row = await this.tracer.span('Prompts', 'select', () => this.db.getNext(category, postedKey));
    if (!row) {
      this.logger.debug(`No unposted prompts for category: ${category}`);
      return;
    }

    // Poisoned rows are marked errored for this destination (posted
    // ["error:<key>"]) so getNext moves past them; transient failures (timeouts,
    // 5xx, rate limits) return unmarked and the row is retried next tick.
    const markError = (reason: string) => {
      this.logger.warn(`Prompt ${row.id} unpublishable (${reason}) — marking errored for ${postedKey}`);
      return this.db.markError(row.id, postedKey, reason);
    };

    // 3. Fetch and scrape the prompthero page
    let html: string | null = null;
    try {
      const res = await axios.get(row.prompt_source, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        timeout: 15_000,
      });
      html = typeof res.data === 'string' ? res.data : null;
    } catch (err) {
      if (isGone(err)) { await markError(`dead page (HTTP ${err.response.status})`); return; }
      this.logger.warn('Page fetch failed: ' + err.message);
      return;
    }
    if (!html) { await markError('page body is not HTML'); return; }

    const meta = this.scraper.extractMeta(html);
    if (!meta) {
      await markError('no prompt metadata on page');
      return;
    }

    // 4. Validate prompt length
    if (meta.prompt.length < MIN_PROMPT_LENGTH) {
      await markError(`prompt too short (${meta.prompt.length})`);
      return;
    }

    // 5. Build message
    const message = this.scraper.buildMessage(meta);
    if (message.isError) {
      await markError('message build failed');
      return;
    }

    // 5a. Native Meta publish: row.id IS the PromptHero image URL — Meta
    // fetches it directly. Skip Telegram image download, notifier,
    // publications, and crossPost (those are TG-only paths).
    if (dest && dest.platform !== 'telegram') {
      if (!dest.token) {
        this.logger.error(`Meta publish skipped (${row.id}): token missing for ${dest.platform}`);
        return;
      }
      // English AI/fashion hashtags on every Meta platform + a link to the
      // group's Telegram channel on Facebook & Threads (Instagram excluded).
      const hashtags = promptHashtags(category);
      const telegramLink = await this.destinations.resolveGroupTelegramLink(dest);
      const captionFor = (platform: DestinationPlatform) =>
        platform === 'telegram'
          ? message.caption
          : composeMetaCaption(platform, {
              base: message.caption, hashtags, telegramLink,
              linkLabel: '📲 More on Telegram:',
            });

      try {
        const id = await this.tracer.span(dest.platform, 'publish', () => this.dispatcher.publish(
          dest.platform as MetaPlatform,
          { text: captionFor(dest.platform), imageUrl: row.id, source: '', tags: [category] },
          { id: dest.targetId, token: dest.token! },
        ));
        await this.db.markPosted(row.id, postedKey);
        this.logger.debug(`Published prompt to ${dest.platform} (${id})`);

        await this.groupFanOut.fanOut(
          dest,
          { caption: message.caption, captionFor, tags: [category], imageUrls: [row.id], carousel: false },
          (key) => this.db.markPosted(row.id, key),
        );
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`Meta publish failed → ${dest.platform}: ${msg}`);
        // Permanent media errors (bad aspect ratio, unsupported format) will
        // never succeed for this image — mark it done for this destination so
        // the queue advances instead of re-selecting it every tick.
        if (isPermanentMetaMediaError(msg)) {
          try { await this.db.markPosted(row.id, postedKey); } catch { /* best-effort */ }
        }
        // Surface to the runner → scheduler records the run as an error.
        throw new Error(`Meta publish (${dest.platform}): ${msg}`);
      }
      return;
    }

    // 6. Download image
    let imageBuffer: Buffer | null = null;
    try {
      const res = await axios.get(row.id, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15_000,
      });
      imageBuffer = Buffer.from(res.data);
    } catch (err) {
      if (isGone(err)) { await markError(`dead image (HTTP ${err.response.status})`); return; }
      this.logger.warn('Image download failed: ' + err.message);
      return;
    }

    // 7. Publish
    try {
      const buf = imageBuffer; // narrowed Buffer (catch above returns) — closure loses the narrowing
      const messageId = await this.tracer.span('telegram', 'publish', () => this.telegram.publishPrompt(
        {
          imageBuffer: buf,
          caption: message.caption,
          replyText: message.replyText ?? undefined,
        },
        { id: channelId },
      ));
      await this.db.markPosted(row.id, postedKey);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.prompt_source,
        title:        meta.prompt.slice(0, 200),
        strategyType: this.type,
        tags:         [category],
      });
      // row.id IS the PromptHero image URL (the TG image above is downloaded
      // from it) — Meta fetches it directly; failures are isolated.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text: message.caption, tags: [category], imageUrl: row.id },
      });
      this.logger.debug(`Published prompt to ${channelId}`);
      await this.groupFanOut.fanOut(
        { platform: 'telegram', targetId: channelId, metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: channelId },
        { caption: message.caption, tags: [category], imageUrls: [row.id], carousel: false },
        (key) => this.db.markPosted(row.id, key),
      );
    } catch (err) {
      this.logger.error('Publish failed: ' + err.message);
      // Telegram rejected this image/caption itself (bad dimensions, unparseable
      // HTML…) — it would fail the same way every tick and block the category.
      if (isPermanentTelegramError(err)) {
        await markError(`publish: ${err.response?.data?.description ?? err.message}`);
      }
    }
  }
}

/** The resource is gone for good (404 Not Found / 410 Gone), not just flaky. */
function isGone(err: any): boolean {
  const status = err?.response?.status;
  return status === 404 || status === 410;
}
