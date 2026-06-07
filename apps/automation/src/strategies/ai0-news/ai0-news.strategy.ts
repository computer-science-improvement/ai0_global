import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync }             from 'fs';
import { join }                     from 'path';
import { PostGenerationAgent }      from '../../common/ai/post-generation.agent';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import { AI0_NEWS_CHANNEL_SKILL }   from '../../common/ai/skills/ai0-news-channel.skill';
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
import { HttpFetcherService }       from '../../common/fetchers/http-fetcher.service';
import { BotLoggerService }         from '../../common/logger/bot-logger.service';
import { ContentCleanerService }    from '../../common/processors/content-cleaner.service';
import { ImageResolverService }     from '../../common/processors/image-resolver.service';
import { RawItem, PostPayload }     from '../../common/types';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';
import { TelegramNotifier }         from '../../publishers/telegram-notifier.service';
import { CrossPostService }         from '../../publishers/cross-post.service';
import { SourceConfig }             from '../../common/types';

@Injectable()
export class Ai0NewsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(Ai0NewsStrategy.name);

  readonly type = 'ai0-news';
  private sources: SourceConfig[] = [];

  constructor(
    private readonly rss:        RssFetcherService,
    private readonly http:       HttpFetcherService,
    private readonly cleaner:    ContentCleanerService,
    private readonly images:     ImageResolverService,
    private readonly postAgent:  PostGenerationAgent,
    private readonly dedup:      DedupService,
    private readonly semanticDedup: SemanticDedupService,
    private readonly topicRouter:   TopicRouterService,
    private readonly botLogger:  BotLoggerService,
    private readonly telegram:   TelegramPublisher,
    private readonly notifier:   TelegramNotifier,
    private readonly registry:   ContentStrategyRegistry,
    private readonly crossPost:  CrossPostService,
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
      await this.notifier.notifySkipped(channelId, 'no items fetched from any source');
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
      await this.notifier.notifySkipped(channelId, `no new items (${cleaned.length} candidates all already posted)`);
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
    const shortContent = !item.content || item.content.length < MIN_CONTENT_LENGTH;

    // Semantic dedup: cross-strategy check — another strategy on this channel
    // may have already covered this story. Cheap haiku call before the heavier
    // generation pipeline.
    const verdict = await this.semanticDedup.check(channelId, {
      title:   item.title,
      content: item.content ?? '',
    });
    if (verdict !== 'NEW') {
      await this.dedup.markPosted(item.source, item.title, channelId);
      this.logger.debug(`Skipped (${verdict}): ${item.source}`);
      await this.notifier.notifySkipped(channelId, `semantic dedup: ${verdict} — ${item.title.slice(0, 80)}`);
      return;
    }

    // Delegate the full AI transformation (enrich if needed → write → clean)
    // to PostGenerationAgent. NestJS keeps I/O, the agent owns prose.
    const result = await this.postAgent.generate({
      mode:            'news',
      channelSkill:    'channel-ai0-news',
      needsEnrichment: shortContent,
      rawData: {
        title:   item.title,
        content: item.content ?? '',
        source:  item.source,
        tags:    item.tags,
      },
    });

    if (result === 'SKIP_POST') {
      await this.dedup.markPosted(item.source, item.title, channelId);
      this.logger.debug(`Skipped (SKIP_POST): ${item.source}`);
      await this.notifier.notifySkipped(channelId, `SKIP_POST from agent — ${item.title.slice(0, 80)}`);
      return;
    }
    if (!result) {
      // Null = transient/agent failure — leave dedup untouched so we retry next cron.
      this.logger.warn(`Agent returned null for ${item.source} — will retry`);
      return;
    }

    // Prefer the agent-supplied tag (when it later opts to generate one). Fall back to
    // source-level tags otherwise.
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

    // markPosted BEFORE telegram.publish. If the process is killed (deploy,
    // OOM, crash) AFTER the Telegram send but BEFORE the DB write, the next
    // cron tick would otherwise re-publish — exactly the SpaceXAI duplicate
    // we hit on 2026-05-15. Trade-off: a publish failure now leaves a row
    // in posted_news without a Telegram message — the article is lost. We
    // accept that one-in-thousands loss to make duplicates impossible.
    await this.dedup.markPosted(item.source, item.title, channelId);

    try {
      const messageId = await this.telegram.publish(payload, { id: channelId });
      await this.botLogger.logSuccess(item.source, channelId, messageId, {
        title: item.title, strategyType: this.type, tags: item.tags ?? null,
      });
      this.logger.debug(`Published to ${channelId}: ${item.title}`);

      // Mirror to any configured Meta cross-post targets. Never throws.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: item.tags ?? [], imageUrl: item.image ?? undefined },
      });

      // Topic routing: forward to a sibling channel if the post matches one.
      // Fire-and-forget — the main publication is already successful.
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
      // Source attribution lines the AI sometimes adds
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
      // Trailing "Тег: ..." / "Tag: ..." meta-lines from broken JSON output
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
