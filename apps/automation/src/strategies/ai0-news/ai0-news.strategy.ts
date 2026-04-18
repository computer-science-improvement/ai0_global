import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync }             from 'fs';
import { join }                     from 'path';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { ReviewAgent }              from '../../common/ai/agents/review.agent';
import { FormatterService }         from '../../common/ai/formatter.service';
import { SummarizerService }        from '../../common/ai/summarizer.service';
import { AI0_NEWS_CHANNEL_SKILL }   from '../../common/ai/skills/ai0-news-channel.skill';
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
import { HttpFetcherService }       from '../../common/fetchers/http-fetcher.service';
import { BotLoggerService }         from '../../common/logger/bot-logger.service';
import { ContentCleanerService }    from '../../common/processors/content-cleaner.service';
import { ImageResolverService }     from '../../common/processors/image-resolver.service';
import { RawItem, PostPayload }     from '../../common/types';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';
import { SourceConfig }             from '../../common/types';

@Injectable()
export class Ai0NewsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(Ai0NewsStrategy.name);

  readonly type = 'ai0-news';
  private sources: SourceConfig[] = [];

  constructor(
    private readonly claude:     ClaudeAgent,
    private readonly rss:        RssFetcherService,
    private readonly http:       HttpFetcherService,
    private readonly cleaner:    ContentCleanerService,
    private readonly images:     ImageResolverService,
    private readonly formatter:  FormatterService,
    private readonly summarizer: SummarizerService,
    private readonly reviewer:   ReviewAgent,
    private readonly dedup:      DedupService,
    private readonly botLogger:  BotLoggerService,
    private readonly telegram:   TelegramPublisher,
    private readonly registry:   ContentStrategyRegistry,
  ) {}

  onModuleInit() {
    const path = join(__dirname, '..', '..', '..', 'config', 'sources', 'ai0-news.json');
    const cfg = JSON.parse(readFileSync(path, 'utf-8')) as { sources: SourceConfig[] };
    this.sources = cfg.sources;
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [AI0_NEWS_CHANNEL_SKILL];
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

  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const MIN_CONTENT_LENGTH = 200;

    // 1. Fetch all sources in parallel
    const rssSources = this.sources.filter(s => s.type === 'rss');
    const httpSources = this.sources.filter(s => s.type === 'http');

    this.logger.debug(`Fetching ${rssSources.length} RSS + ${httpSources.length} HTTP sources`);

    const [rssItems, httpResults] = await Promise.all([
      this.rss.fetchLatest(rssSources as any),
      Promise.all(httpSources.map(s => this.http.fetch(s as any))),
    ]);

    const httpItems = httpResults.filter((i): i is RawItem => i !== null);
    const allItems = [...rssItems, ...httpItems];

    if (!allItems.length) {
      this.logger.warn('No items fetched from any source');
      return;
    }

    this.logger.debug(`Fetched ${allItems.length} total items`);

    // 2. Clean HTML
    const cleaned = allItems.map(item => ({
      ...item,
      content: this.cleaner.clean(item.content),
    }));

    // 3. Dedup for this channel
    const unposted = await this.dedup.filterUnposted(cleaned, channelId);
    if (!unposted.length) {
      this.logger.debug('No unposted items after dedup');
      return;
    }

    this.logger.debug(`${unposted.length} unposted items after dedup`);

    // 4. Take FIRST unposted item only (one per cron trigger)
    const item = unposted[0];

    // 5. Resolve image
    const withImage = await this.images.resolve(item);

    // 6. Process the item
    await this.processItem(withImage, channelId);
  }

  private async processItem(item: RawItem, channelId: string): Promise<void> {
    const MIN_CONTENT_LENGTH = 800;

    // Enrich short content via Perplexity
    let content = item.content;
    if (!content || content.length < MIN_CONTENT_LENGTH) {
      this.logger.debug(`Content too short (${content?.length ?? 0}), fetching via summarizer`);
      const fetched = await this.summarizer.fetchByUrl(item.source);
      if (!fetched || fetched.trim() === 'SKIP_POST') {
        await this.botLogger.logError(item.source, channelId, 'SKIP_POST');
        return;
      }
      content = fetched;
    }

    const formattedText = content
      ? await this.formatter.formatRaw(content, 'telegram')
      : null;

    if (formattedText === 'SKIP_POST') {
      await this.botLogger.logError(item.source, channelId, 'SKIP_POST');
      return;
    }
    if (!formattedText) return;

    const reviewed = await this.reviewer.review(formattedText, [AI0_NEWS_CHANNEL_SKILL]);
    const text = this.buildMessage(reviewed, item);

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
      await this.dedup.markPosted(item.source, item.title, channelId);
      await this.botLogger.logSuccess(item.source, channelId, messageId);
      this.logger.debug(`Published to ${channelId}: ${item.title}`);
    } catch (err) {
      await this.botLogger.logError(item.source, channelId, err.message);
      this.logger.warn(`Publish failed for ${item.source}: ${err.message}`);
    }
  }

  private buildMessage(text: string, item: RawItem): string {
    const clean = text
      .replace(/\[\d+\]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

    const tags = item.tags
      .map(t => '#' + String(t).trim().replace(/[\s\-\.]+/g, '_').toLowerCase())
      .join(' ');

    const safeSource = item.source
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return clean + '\n\n' + tags + '\n\n<a href="' + safeSource + '">Посилання</a>';
  }
}
