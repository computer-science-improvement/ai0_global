import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { PostValidator }            from '../../common/ai/validators/post.validator';
import { ON_THIS_DAY_CHANNEL_SKILL } from '../../common/ai/skills/on-this-day-channel.skill';
import { ON_THIS_DAY_PROMPT, buildOnThisDayUserMessage } from '../../common/ai/prompts/on-this-day.prompts';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { Skill } from '../../common/ai/skills/skill.interface';
import { ByabbeFetcher } from '../../workflows/on-this-day/fetchers/byabbe.fetcher';
import { OnThisDayItem } from '../../workflows/on-this-day/types';

@Injectable()
export class OnThisDayStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(OnThisDayStrategy.name);

  readonly type = 'on-this-day';

  constructor(
    private readonly claude:    ClaudeAgent,
    private readonly validator: PostValidator,
    private readonly registry:  ContentStrategyRegistry,
    private readonly fetcher:   ByabbeFetcher,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [ON_THIS_DAY_CHANNEL_SKILL];
  }

  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    const data = await this.fetcher.fetch();
    if (!data || (!data.events.length && !data.births.length)) {
      this.logger.log('No data fetched from Byabbe');
      return null;
    }

    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    return {
      sourceUrl:   `https://byabbe.se/on-this-day/${month}/${day}`,
      title:       `On This Day ${month}/${day}`,
      contentType: 'history',
      data,
    };
  }

  async generate(
    fetchResult: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null> {
    if (!this.claude.available) {
      this.logger.warn('Claude not available');
      return null;
    }

    const item = fetchResult.data as OnThisDayItem;

    const userMessage = buildOnThisDayUserMessage(item.events, item.births);
    this.logger.debug(`User message:\n${userMessage}`);

    const draft = await this.claude.chat([
      { role: 'system', content: ON_THIS_DAY_PROMPT.system },
      { role: 'user',   content: userMessage },
    ]);

    if (draft?.trim() === 'SKIP_POST') {
      this.logger.warn('Model signalled SKIP_POST');
      return 'SKIP_POST';
    }

    if (!this.validator.check(draft, 'on-this-day')) return null;

    return {
      text:        draft!,
      sourceUrl:   fetchResult.sourceUrl,
      title:       fetchResult.title,
      contentType: fetchResult.contentType,
    };
  }
}
