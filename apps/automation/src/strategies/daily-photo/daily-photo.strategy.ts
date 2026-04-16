import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { PostValidator }            from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { NasaApodFetcher }          from '../../workflows/daily-photo/fetchers/nasa-apod.fetcher';
import { DailyPhotoItem }           from '../../workflows/daily-photo/types';
import { APOD_PROMPT, buildApodUserMessage } from '../../common/ai/prompts/daily-photo.prompts';
import { DAILY_PHOTO_CHANNEL_SKILL } from '../../common/ai/skills/daily-photo-channel.skill';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';

@Injectable()
export class DailyPhotoStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(DailyPhotoStrategy.name);

  readonly type = 'daily-photo';

  constructor(
    private readonly claude:    ClaudeAgent,
    private readonly validator: PostValidator,
    private readonly registry:  ContentStrategyRegistry,
    private readonly fetcher:   NasaApodFetcher,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [DAILY_PHOTO_CHANNEL_SKILL];
  }

  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    const item = await this.fetcher.fetch();
    if (!item) {
      this.logger.warn('No photo fetched from NASA APOD');
      return null;
    }

    const dateFormatted = item.date.replace(/-/g, '').slice(2);
    const sourceUrl = 'https://apod.nasa.gov/apod/ap' + dateFormatted + '.html';

    return {
      sourceUrl,
      title:       item.title,
      contentType: 'apod',
      data:        item,
    };
  }

  async generate(
    fetchResult: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null> {
    const item = fetchResult.data as DailyPhotoItem;

    if (!this.claude.available) {
      this.logger.warn('Claude not available');
      return null;
    }

    const translated = await this.claude.chat([
      { role: 'system', content: APOD_PROMPT.system },
      { role: 'user',   content: buildApodUserMessage(item) },
    ]);

    if (translated?.trim() === 'SKIP_POST') {
      this.logger.warn('Model signalled SKIP_POST');
      return 'SKIP_POST';
    }

    if (!this.validator.check(translated, 'daily-photo')) return null;

    const lines = [`<b>${item.title}</b>`, '', translated!];
    if (item.copyright) {
      lines.push('', `© ${item.copyright}`);
    }

    let message = lines.join('\n');

    if (message.length > 900) {
      const copyrightSuffix = item.copyright ? `\n\n© ${item.copyright}` : '';
      const maxExplanation = 900 - `<b>${item.title}</b>`.length - 2 - copyrightSuffix.length;
      message = [
        `<b>${item.title}</b>`,
        '',
        translated!.slice(0, maxExplanation - 3) + '...',
        ...(item.copyright ? ['', `© ${item.copyright}`] : []),
      ].join('\n');
    }

    return {
      text:        message,
      imageUrl:    item.imageUrl,
      sourceUrl:   fetchResult.sourceUrl,
      title:       fetchResult.title,
      contentType: 'apod',
    };
  }
}
