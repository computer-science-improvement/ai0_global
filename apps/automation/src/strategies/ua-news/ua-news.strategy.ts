import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PostGenerationAgent }      from '../../common/ai/post-generation.agent';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { DedupService }             from '../../common/dedup/dedup.service';
import { SemanticDedupService }     from '../../common/dedup/semantic-dedup.service';
import { TopicRouterService }       from '../../common/routing/topic-router.service';
import { RssFetcherService }        from '../../common/fetchers/rss-fetcher.service';
import { ContentCleanerService }    from '../../common/processors/content-cleaner.service';
import { ImageResolverService }     from '../../common/processors/image-resolver.service';
import { BotLoggerService }         from '../../common/logger/bot-logger.service';
import { RawItem, PostPayload }     from '../../common/types';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';
import { CrossPostService } from '../../publishers/cross-post.service';

@Injectable()
export class UaNewsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(UaNewsStrategy.name);

  readonly type = 'ua-news';

  constructor(
    private readonly rss:           RssFetcherService,
    private readonly cleaner:       ContentCleanerService,
    private readonly images:        ImageResolverService,
    private readonly postAgent:     PostGenerationAgent,
    private readonly dedup:         DedupService,
    private readonly semanticDedup: SemanticDedupService,
    private readonly topicRouter:   TopicRouterService,
    private readonly botLogger:     BotLoggerService,
    private readonly telegram:      TelegramPublisher,
    private readonly registry:      ContentStrategyRegistry,
    private readonly crossPost: CrossPostService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] { return []; }

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

    const rssItems = await this.rss.fetchLatest([{ type: 'rss', url: feedUrl, tags }]);
    if (!rssItems.length) {
      this.logger.debug(`No items from ${sourceName}`);
      return;
    }

    const cleaned = rssItems.map(item => ({
      ...item,
      content: this.cleaner.clean(item.content),
    }));

    const unposted = await this.dedup.filterUnposted(cleaned, channelId);
    if (!unposted.length) {
      this.logger.debug(`No unposted items from ${sourceName}`);
      return;
    }

    const item = unposted[0];
    const withImage = await this.images.resolve(item);

    await this.processItem(withImage, channelId, sourceName);
  }

  private async processItem(item: RawItem, channelId: string, sourceName: string): Promise<void> {
    const MIN_CONTENT_LENGTH = 800;
    const shortContent = !item.content || item.content.length < MIN_CONTENT_LENGTH;

    // Cross-strategy semantic dedup — another ua-news feed (or ai0-news) may
    // have already covered this story on the same channel.
    const verdict = await this.semanticDedup.check(channelId, {
      title:   item.title,
      content: item.content ?? '',
    });
    if (verdict !== 'NEW') {
      await this.dedup.markPosted(item.source, item.title, channelId, sourceName);
      this.logger.debug(`Skipped (${verdict}): ${item.source}`);
      return;
    }

    const result = await this.postAgent.generate({
      mode:            'news',
      channelSkill:    'channel-ua-news',
      needsEnrichment: shortContent,
      rawData: {
        title:   item.title,
        content: item.content ?? '',
        source:  item.source,
        tags:    item.tags,
      },
    });

    if (result === 'SKIP_POST') {
      await this.dedup.markPosted(item.source, item.title, channelId, sourceName);
      this.logger.debug(`Skipped (SKIP_POST): ${item.source}`);
      return;
    }
    if (!result) {
      this.logger.warn(`Agent returned null for ${item.source} — will retry`);
      return;
    }

    // Prefer the agent-supplied tag (when it later opts to generate one). Fall back to params-level tags otherwise.
    const agentTags = result.tag ? [result.tag] : (item.tags ?? []);
    const text = this.buildMessage(result.text, { ...item, tags: agentTags });

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

    // markPosted BEFORE telegram.publish — same reasoning as ai0-news.
    // A process kill (deploy, OOM) between Telegram send and DB write
    // would otherwise let the next cron re-publish. Trade-off: if publish
    // fails afterwards, the article is marked as posted in DB but absent
    // from Telegram (lost). Accepted to prevent duplicates.
    await this.dedup.markPosted(item.source, item.title, channelId, sourceName);

    try {
      const messageId = await this.telegram.publish(payload, { id: channelId });
      await this.botLogger.logSuccess(item.source, channelId, messageId, {
        title: item.title, strategyType: this.type, tags: item.tags ?? null,
      });
      this.logger.debug(`Published to ${channelId}: ${item.title}`);

      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text: payload.text, tags: item.tags ?? [], imageUrl: item.image ?? undefined },
      });

      // Topic routing: forward to a sibling channel if the post matches one.
      const targetChannel = await this.topicRouter.route(result.text, channelId);
      if (targetChannel) {
        try {
          await this.telegram.forward(channelId, targetChannel, messageId);
        } catch (fwdErr: any) {
          this.logger.warn(`Forward to ${targetChannel} failed: ${fwdErr.message}`);
        }
      }
    } catch (err) {
      await this.botLogger.logError(item.source, channelId, err.message);
      this.logger.warn(
        `Publish failed for ${item.source}: ${err.message} — ` +
        `posted_news already marked, article will NOT retry`,
      );
    }
  }

  private buildMessage(text: string, item: RawItem): string {
    // Defensive strip — duplicates of the cleanup `PostGenerationAgent` already
    // runs via `cleanFinalText`. Kept here as a belt-and-braces guard against
    // any future change that bypasses the helper.
    const stripped = text
      // Source attribution lines
      .replace(/^\s*(Джерело|Source)\s*[:：].*$/gim, '')
      // Friendly preambles the AI adds despite "no preamble" rule —
      // including markdown-bold and HTML-bold wrapped variants
      .replace(
        /^\s*(?:\*\*|__|<b>|<strong>)\s*(Ось\s+)?(готов(ий|ого)\s+)?пост\s*[:：]?\s*(?:\*\*|__|<\/b>|<\/strong>)\s*$/gim,
        '',
      )
      .replace(/^\s*(Ось\s+)?(готов(ий|ого)\s+)?пост\s*[:：]\s*$/gim, '')
      .replace(/^\s*final\s+post\s*[:：]\s*$/gim, '')
      // Standalone separator lines ("---", "***", "===")
      .replace(/^\s*[-*=]{3,}\s*$/gm, '')
      // Trailing meta lines like "Тег: #xyz", "Tag: xyz"
      .replace(/^\s*(Тег|ТЕГ|Tag|tag)\s*[:：]\s*[`'"#\w-]*\s*$/gim, '')
      // Markdown-style links [text](url) — don't render in Telegram HTML mode
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
      // Inline hashtags anywhere (we append our own hashtag line below)
      .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
      // Markdown code fences left around the whole post
      .replace(/^```(?:json|markdown|html|text)?\s*$/gim, '')
      // Collapse extra blank lines left behind by the strips above
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const clean = stripped
      .replace(/\[\d+\]/g, '');

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
