import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';
import { TelegramNotifier }         from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }   from '../../stats/publications.repository';
import { CrossPostService } from '../../publishers/cross-post.service';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { QuotesRepository } from './quotes.repository';

@Injectable()
export class QuotesStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(QuotesStrategy.name);

  readonly type = 'quotes';

  constructor(
    private readonly registry:  ContentStrategyRegistry,
    private readonly db:        QuotesRepository,
    private readonly telegram:  TelegramPublisher,
    private readonly notifier:  TelegramNotifier,
    private readonly publications: PublicationsRepository,
    private readonly crossPost: CrossPostService,
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
    const category = params.category as string | undefined;
    const quote = await this.db.getRandom(channelId, category);

    if (!quote) {
      this.logger.debug('No unposted quotes available');
      return;
    }

    // Strip wrapping quotes and trailing dashes (fallback if DB not re-seeded)
    const clean = quote.text
      .trim()
      .replace(/^\d+\.\s*/, '')
      .replace(/^[\s"«»\u201C\u201D]+/, '')
      .replace(/[\s"«»\u201C\u201D]+$/, '')
      .replace(/\s*[–—]\s*$/, '')
      .trim();

    const isBirthday = quote.author
      ? await this.db.isBirthdayToday(quote.author)
      : false;

    const authorLine = quote.author
      ? `— <i>${quote.author}</i>${isBirthday ? '  🎂' : ''}`
      : null;

    const text = authorLine
      ? `«${clean}»\n\n${authorLine}`
      : `«${clean}»`;

    try {
      const messageId = await this.telegram.publish(
        { text, source: quote.url ?? '', tags: quote.category ? [quote.category] : [], title: quote.author ?? 'quote' },
        { id: channelId },
      );
      await this.db.markPosted(quote.id, channelId);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl: quote.url ?? null,
        title:     quote.author ?? 'quote',
        strategyType: this.type,
        tags:      quote.category ? [quote.category] : null,
      });
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: quote.category ? [quote.category] : [] },
      });
      this.logger.debug(`Published quote to ${channelId}`);
    } catch (err) {
      this.logger.error(`Publish failed: ${err.message}`);
    }
  }
}
