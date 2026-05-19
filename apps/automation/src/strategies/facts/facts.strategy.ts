import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { FactsRepository } from './facts.repository';

@Injectable()
export class FactsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(FactsStrategy.name);

  readonly type = 'facts';

  constructor(
    private readonly registry: ContentStrategyRegistry,
    private readonly db:       FactsRepository,
    private readonly telegram: TelegramPublisher,
    private readonly notifier: TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() {
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

  async execute(channelId: string, params: StrategyParams): Promise<void> {
    // Curated bindings (e.g. motivation channel) restrict to a hand-picked
    // subset of article_title values via `params.articleTitles`. When absent
    // or empty, fall back to the full random pool.
    const articleTitles = Array.isArray((params as any)?.articleTitles)
      ? ((params as any).articleTitles as string[])
      : null;

    const fact = articleTitles && articleTitles.length
      ? await this.db.getRandomByArticleTitles(channelId, articleTitles)
      : await this.db.getRandom(channelId);

    if (!fact) {
      this.logger.debug('No unposted facts available');
      return;
    }

    const text = [
      fact.content,
      '',
      '#факти',
    ].join('\n');

    let imageBuffer: Buffer | undefined;
    if (fact.image_url) {
      imageBuffer = await this.downloadImage(fact.image_url);
    }

    // markPosted BEFORE telegram.publish. Symmetric with ai0-news / game-channel
    // fix: if publish fails between Telegram-send and DB write, the next cron
    // tick would otherwise pick the same fact again. We accept the one-in-thousands
    // loss-on-publish-failure trade-off to make duplicates impossible.
    await this.db.markPosted(fact.id, channelId);

    try {
      const messageId = await this.telegram.publish(
        {
          text,
          imageBuffer,
          source: fact.article_url ?? fact.article_slug,
          tags:   ['факти'],
          title:  fact.article_title,
        },
        { id: channelId },
      );
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    fact.article_url ?? fact.article_slug,
        title:        fact.article_title,
        strategyType: this.type,
        tags:         ['факти'],
      });
      this.logger.debug(`Published fact "${fact.article_title}" to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Publish failed: ${err.message}`);
    }
  }

  private async downloadImage(url: string): Promise<Buffer | undefined> {
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 10_000,
      });
      return Buffer.from(res.data);
    } catch (err: any) {
      this.logger.warn(`Image download failed (${url}): ${err.message}`);
      return undefined;
    }
  }
}
