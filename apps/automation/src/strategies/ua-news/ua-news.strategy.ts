import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FormatterService }         from '../../common/ai/formatter.service';
import { SummarizerService }        from '../../common/ai/summarizer.service';
import { UA_NEWS_CHANNEL_SKILL }    from '../../common/ai/skills/ua-news-channel.skill';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { DedupService }             from '../../common/dedup/dedup.service';
import { RssFetcherService }        from '../../common/fetchers/rss-fetcher.service';
import { ContentCleanerService }    from '../../common/processors/content-cleaner.service';
import { ImageResolverService }     from '../../common/processors/image-resolver.service';
import { BotLoggerService }         from '../../common/logger/bot-logger.service';
import { RawItem, PostPayload }     from '../../common/types';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';

@Injectable()
export class UaNewsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(UaNewsStrategy.name);

  readonly type = 'ua-news';

  constructor(
    private readonly rss:        RssFetcherService,
    private readonly cleaner:    ContentCleanerService,
    private readonly images:     ImageResolverService,
    private readonly formatter:  FormatterService,
    private readonly summarizer: SummarizerService,
    private readonly dedup:      DedupService,
    private readonly botLogger:  BotLoggerService,
    private readonly telegram:   TelegramPublisher,
    private readonly registry:   ContentStrategyRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [UA_NEWS_CHANNEL_SKILL];
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

  async execute(channelId: string, params: StrategyParams): Promise<void> {
    const feedUrl    = params.feedUrl as string;
    const sourceName = (params.sourceName as string) || 'ua-news';
    const tags       = (params.tags as string[]) || [];

    if (!feedUrl) {
      this.logger.warn('No feedUrl in params, skipping');
      return;
    }

    // 1. Fetch RSS
    const rssItems = await this.rss.fetchLatest([
      { type: 'rss', url: feedUrl, tags },
    ]);

    if (!rssItems.length) {
      this.logger.debug(`No items from ${sourceName}`);
      return;
    }

    this.logger.debug(`Fetched ${rssItems.length} items from ${sourceName}`);

    // 2. Clean HTML
    const cleaned = rssItems.map(item => ({
      ...item,
      content: this.cleaner.clean(item.content),
    }));

    // 3. Dedup
    const unposted = await this.dedup.filterUnposted(cleaned, channelId);
    if (!unposted.length) {
      this.logger.debug(`No unposted items from ${sourceName}`);
      return;
    }

    this.logger.debug(`${unposted.length} unposted items from ${sourceName}`);

    // 4. Take first unposted item
    const item = unposted[0];

    // 5. Resolve image
    const withImage = await this.images.resolve(item);

    // 6. Process
    await this.processItem(withImage, channelId, sourceName);
  }

  private async processItem(item: RawItem, channelId: string, sourceName: string): Promise<void> {
    const MIN_CONTENT_LENGTH = 200;

    // Enrich short content via Perplexity
    let content = item.content;
    if (!content || content.length < MIN_CONTENT_LENGTH) {
      this.logger.debug(`Content too short (${content?.length ?? 0}), enriching via summarizer`);
      const fetched = await this.summarizer.fetchByUrl(item.source);
      if (!fetched || fetched.trim() === 'SKIP_POST') {
        // URL is inaccessible — remove from queue permanently via dedup
        await this.dedup.markPosted(item.source, item.title, channelId, sourceName);
        this.logger.debug(`Skipped (inaccessible): ${item.source}`);
        return;
      }
      content = fetched;
    }

    const formattedText = content
      ? await this.formatter.formatNewsItem(item.title, content, item.source)
      : null;

    if (formattedText === 'SKIP_POST') {
      // Content unformattable — remove from queue permanently via dedup
      await this.dedup.markPosted(item.source, item.title, channelId, sourceName);
      this.logger.debug(`Skipped (unformattable): ${item.source}`);
      return;
    }
    if (!formattedText) return;

    const text = this.buildMessage(formattedText, item, sourceName);

    let imageBuffer: Buffer | undefined;
    if (item.image) {
      imageBuffer = (await this.images.download(item.image)) ?? undefined;
    }

    const payload: PostPayload = {
      text,
      imageBuffer,
      imageUrl: item.image ?? undefined,
      source: item.source,
      tags: item.tags,
      title: item.title,
    };

    if (await this.botLogger.hasLog(item.source, channelId)) return;

    try {
      const messageId = await this.telegram.publish(payload, { id: channelId });
      await this.dedup.markPosted(item.source, item.title, channelId, sourceName);
      await this.botLogger.logSuccess(item.source, channelId, messageId);
      this.logger.debug(`Published to ${channelId}: ${item.title}`);
    } catch (err) {
      await this.botLogger.logError(item.source, channelId, err.message);
      this.logger.warn(`Publish failed for ${item.source}: ${err.message}`);
    }
  }

  private buildMessage(text: string, item: RawItem, sourceName: string): string {
    const clean = text
      .replace(/\[\d+\]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

    const allTags = item.tags
      .map(t => '#' + String(t).trim().replace(/[\s\-\.]+/g, '_').toLowerCase())
      .join(' ');

    const safeSource = item.source
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return clean + '\n\n' + allTags + '\n\n<a href="' + safeSource + '">Джерело</a>';
  }
}
