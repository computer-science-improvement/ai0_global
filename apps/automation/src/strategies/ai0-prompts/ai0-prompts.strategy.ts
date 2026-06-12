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
import type { PublishDestination }  from '../../common/content-strategy/publish-destination';
import { PromptsRepository }        from './prompts.repository';
import { PromptHeroScraperService } from '../../workflows/ai0-prompts/prompthero-scraper.service';

@Injectable()
export class Ai0PromptsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(Ai0PromptsStrategy.name);

  readonly type = 'ai0-prompts';
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
  ) {}

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

    // 1. Pick random category
    const category = this.categories[Math.floor(Math.random() * this.categories.length)];
    this.logger.debug(`Selected category: ${category}`);

    // 2. Get next unposted prompt from DB
    const row = await this.db.getNext(category, postedKey);
    if (!row) {
      this.logger.debug(`No unposted prompts for category: ${category}`);
      return;
    }

    // 3. Fetch and scrape the prompthero page
    let html: string | null = null;
    try {
      const res = await axios.get(row.prompt_source, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        timeout: 15_000,
      });
      html = typeof res.data === 'string' ? res.data : null;
    } catch (err) {
      this.logger.warn('Page fetch failed: ' + err.message);
      return;
    }
    if (!html) return;

    const meta = this.scraper.extractMeta(html);
    if (!meta) {
      this.logger.warn('Failed to extract meta from page');
      return;
    }

    // 4. Validate prompt length
    if (meta.prompt.length < MIN_PROMPT_LENGTH) {
      this.logger.debug(`Prompt too short (${meta.prompt.length}), marking as error`);
      await this.db.markError(row.id);
      return;
    }

    // 5. Build message
    const message = this.scraper.buildMessage(meta);
    if (message.isError) {
      this.logger.warn('Message build returned error');
      await this.db.markError(row.id);
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
      try {
        const id = await this.dispatcher.publish(
          dest.platform,
          { text: message.caption, imageUrl: row.id, source: '', tags: [category] },
          { id: dest.targetId, token: dest.token },
        );
        await this.db.markPosted(row.id, postedKey);
        this.logger.debug(`Published prompt to ${dest.platform} (${id})`);
      } catch (err: any) {
        this.logger.error(`Meta publish failed → ${dest.platform}: ${err.message}`);
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
      this.logger.warn('Image download failed: ' + err.message);
      return;
    }

    // 7. Publish
    try {
      const messageId = await this.telegram.publishPrompt(
        {
          imageBuffer,
          caption: message.caption,
          replyText: message.replyText ?? undefined,
        },
        { id: channelId },
      );
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
    } catch (err) {
      this.logger.error('Publish failed: ' + err.message);
    }
  }
}
