import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { PostValidator }            from '../../common/ai/validators/post.validator';
import { ReviewAgent }              from '../../common/ai/agents/review.agent';
import { GAMING_CHANNEL_SKILL }     from '../../common/ai/skills/gaming-channel.skill';
import {
  GAME_PROMPTS,
  buildGameChannelUserMessage,
  buildDealPost,
} from '../../common/ai/prompts/game-channel.prompts';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { DedupService }             from '../../common/dedup/dedup.service';
import { ImageResolverService }     from '../../common/processors/image-resolver.service';
import { RawItem }                  from '../../common/types';
import { TelegramPublisher }        from '../../publishers/telegram.publisher';
import { TelegramNotifier }         from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }   from '../../stats/publications.repository';
import { GamerPowerFetcher }        from '../../workflows/game-channel/fetchers/gamerpower.fetcher';
import { EpicGamesFetcher }         from '../../workflows/game-channel/fetchers/epic-games.fetcher';
import { SteamDealsFetcher }        from '../../workflows/game-channel/fetchers/steam-deals.fetcher';
import { GameNewsFetcher }          from '../../workflows/game-channel/fetchers/game-news.fetcher';
import { GameChannelItem }          from '../../workflows/game-channel/types';

@Injectable()
export class GameChannelStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(GameChannelStrategy.name);

  readonly type = 'game-channel';

  constructor(
    private readonly claude:     ClaudeAgent,
    private readonly validator:  PostValidator,
    private readonly reviewer:   ReviewAgent,
    private readonly dedup:      DedupService,
    private readonly images:     ImageResolverService,
    private readonly telegram:   TelegramPublisher,
    private readonly registry:   ContentStrategyRegistry,
    private readonly gamerpower: GamerPowerFetcher,
    private readonly epic:       EpicGamesFetcher,
    private readonly steam:      SteamDealsFetcher,
    private readonly gameNews:   GameNewsFetcher,
    private readonly notifier:   TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [GAMING_CHANNEL_SKILL];
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
    const TYPE_PRIORITY: Record<string, number> = { giveaway: 0, deal: 1, news: 2 };

    // 1. Fetch all sources
    this.logger.debug('Fetching all game-channel sources');

    const [giveaways, epicFree, deals, news] = await Promise.all([
      this.gamerpower.fetch(),
      this.epic.fetch(),
      this.steam.fetch(),
      this.gameNews.fetch(),
    ]);

    const allItems: GameChannelItem[] = [...giveaways, ...epicFree, ...deals, ...news];
    if (!allItems.length) {
      this.logger.warn('No items fetched from any game source');
      return;
    }

    this.logger.debug(`Fetched ${allItems.length} total game items`);

    // 2. Dedup
    const rawItems: RawItem[] = allItems.map(i => ({
      title: i.title,
      content: null,
      image: i.imageUrl,
      source: i.source,
      tags: [i.type],
      isoDate: i.publishedAt,
    }));

    const unpostedRaw = await this.dedup.filterUnposted(rawItems, channelId);
    if (!unpostedRaw.length) {
      this.logger.debug('No unposted items after dedup');
      return;
    }

    const postedUrls = new Set(
      rawItems.filter((_, i) => !unpostedRaw.includes(rawItems[i])).map(r => r.source),
    );
    const unposted = allItems.filter(i => !postedUrls.has(i.source));

    // 3. Sort by priority
    unposted.sort((a, b) => {
      const pa = TYPE_PRIORITY[a.type] ?? 9;
      const pb = TYPE_PRIORITY[b.type] ?? 9;
      if (pa !== pb) return pa - pb;
      return new Date(a.publishedAt ?? 0).getTime() - new Date(b.publishedAt ?? 0).getTime();
    });

    // 3b. Fair-mix
    const lastType = await this.dedup.getLastPostedType(channelId);
    const hasOtherTypes = unposted.some(i => i.type !== 'giveaway');
    let item = unposted[0];
    if (lastType === 'giveaway' && hasOtherTypes) {
      item = unposted.find(i => i.type !== 'giveaway')!;
    }

    this.logger.debug(`Selected item: [${item.type}] ${item.title}`);

    // 4. Format with Claude
    const prompt = GAME_PROMPTS[item.type];
    if (!this.claude.available) {
      this.logger.warn('Claude not available');
      return;
    }

    const userMessage = buildGameChannelUserMessage(item);
    const aiText = await this.claude.chat([
      { role: 'system', content: prompt.system },
      { role: 'user', content: userMessage },
    ]);

    if (aiText?.trim() === 'SKIP_POST') {
      this.logger.debug(`SKIP_POST for ${item.title}`);
      await this.dedup.markPosted(item.source, item.title, channelId, item.type);
      return;
    }

    if (!this.validator.check(aiText, 'game-channel / ' + item.type)) return;

    // 5. Review + build text
    let text: string;
    if (item.type === 'deal') {
      const reviewed = await this.reviewer.review(aiText!, [GAMING_CHANNEL_SKILL]);
      text = this.appendLink(buildDealPost(item, reviewed), item);
    } else {
      const reviewed = await this.reviewer.review(aiText!, [GAMING_CHANNEL_SKILL]);
      text = this.appendLink(reviewed, item);
    }

    // 6. Download image
    let imageBuffer: Buffer | undefined;
    if (item.imageUrl) {
      imageBuffer = (await this.images.download(item.imageUrl)) ?? undefined;
    }

    // 7. Publish
    try {
      let messageId: string;
      if (imageBuffer && text.length <= 1024) {
        messageId = await this.telegram.publishPrompt(
          { imageBuffer, caption: text },
          { id: channelId },
        );
      } else {
        messageId = await this.telegram.publish(
          {
            text,
            imageBuffer,
            imageUrl: item.imageUrl ?? undefined,
            source: item.source,
            tags: [item.type],
            title: item.title,
          },
          { id: channelId },
        );
      }
      await this.dedup.markPosted(item.source, item.title, channelId, item.type);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    item.source,
        title:        item.title,
        strategyType: this.type,
        tags:         [item.type],
      });
      this.logger.debug(`Published [${item.type}] to ${channelId}: ${item.title}`);
    } catch (err) {
      this.logger.error('Publish failed: ' + err.message);
    }
  }

  private appendLink(text: string, item: GameChannelItem): string {
    if (!item.source) return text;
    return text + '\n\n<a href="' + item.source + '">Посилання</a>';
  }
}
