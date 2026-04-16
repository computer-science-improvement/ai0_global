import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { PostValidator }            from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { DedupService }             from '../../common/dedup/dedup.service';
import { SpaceNewsFetcher }         from '../../workflows/space/fetchers/space-news.fetcher';
import { SpaceItem }                from '../../workflows/space/types';
import { SPACE_NEWS_PROMPT, buildSpaceUserMessage } from '../../common/ai/prompts/space.prompts';
import { SPACE_CHANNEL_SKILL }      from '../../common/ai/skills/space-channel.skill';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import { RawItem }                  from '../../common/types';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';

@Injectable()
export class SpaceStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(SpaceStrategy.name);

  readonly type = 'space-news';

  constructor(
    private readonly claude:       ClaudeAgent,
    private readonly validator:    PostValidator,
    private readonly registry:     ContentStrategyRegistry,
    private readonly dedup:        DedupService,
    private readonly spaceFetcher: SpaceNewsFetcher,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [SPACE_CHANNEL_SKILL];
  }

  async fetch(_params: StrategyParams, channelId: string): Promise<StrategyFetchResult | null> {
    const items = await this.spaceFetcher.fetch();
    if (!items || items.length === 0) {
      this.logger.warn('No articles fetched from Space News');
      return null;
    }

    const rawItems: RawItem[] = items.map(i => ({
      title:   i.title,
      content: null,
      image:   i.imageUrl,
      source:  i.source,
      tags:    [i.contentType],
      isoDate: i.publishedAt,
    }));

    const unpostedRaw = await this.dedup.filterUnposted(rawItems, channelId);
    const unpostedSources = new Set(unpostedRaw.map(r => r.source));

    const item = items.find(i => unpostedSources.has(i.source));
    if (!item) {
      this.logger.debug('All space news articles already posted');
      return null;
    }

    return {
      sourceUrl:   item.source,
      title:       item.title,
      contentType: item.contentType,
      data:        item,
    };
  }

  async generate(
    fetchResult: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null> {
    const item = fetchResult.data as SpaceItem;

    if (!this.claude.available) {
      this.logger.warn('Claude not available');
      return null;
    }

    const text = await this.claude.chat([
      { role: 'system', content: SPACE_NEWS_PROMPT.system },
      { role: 'user',   content: buildSpaceUserMessage(item) },
    ]);

    if (text?.trim() === 'SKIP_POST') {
      this.logger.warn('Model signalled SKIP_POST');
      return 'SKIP_POST';
    }

    if (!this.validator.check(text, 'space-news')) return null;

    const finalText = text + '\n\n<a href="' + item.source + '">Посилання</a>';

    return {
      text:        finalText,
      imageUrl:    item.imageUrl ?? undefined,
      sourceUrl:   fetchResult.sourceUrl,
      title:       fetchResult.title,
      contentType: fetchResult.contentType,
    };
  }
}
