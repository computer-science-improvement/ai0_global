import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
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

  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const fact = await this.db.getRandom(channelId);

    if (!fact) {
      this.logger.debug('No unposted facts available');
      return;
    }

    const text = [
      fact.content,
      '',
      `— з добірки «${fact.article_title}»`,
      '',
      '#цікавіфакти',
    ].join('\n');

    let imageBuffer: Buffer | undefined;
    if (fact.image_url) {
      imageBuffer = await this.downloadImage(fact.image_url);
    }

    try {
      await this.telegram.publish(
        {
          text,
          imageBuffer,
          source: fact.article_url ?? fact.article_slug,
          tags:   ['цікавіфакти'],
          title:  fact.article_title,
        },
        { id: channelId },
      );
      await this.db.markPosted(fact.id, channelId);
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
