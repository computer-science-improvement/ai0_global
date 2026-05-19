import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
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

  async execute(channelId: string, params: StrategyParams): Promise<void> {
    const TYPE_PRIORITY: Record<string, number> = { giveaway: 0, deal: 1, news: 2 };

    // Source filter — when `params.sources` is set, fetch only the listed
    // fetchers. Lets one strategy class be bound to multiple crons with
    // different schedules (e.g. giveaways daily at 11:00, deals/news every
    // 2 hours). Absent / empty → all sources (legacy behaviour).
    const requested = Array.isArray((params as any)?.sources)
      ? ((params as any).sources as string[])
      : null;
    const want = (s: string) => !requested || requested.length === 0 || requested.includes(s);

    this.logger.debug(
      `Fetching game-channel sources: ${requested?.join(',') ?? 'all'}`,
    );

    const [giveaways, epicFree, deals, news] = await Promise.all([
      want('gamerpower') ? this.gamerpower.fetch() : Promise.resolve([]),
      want('epic')       ? this.epic.fetch()       : Promise.resolve([]),
      want('steam')      ? this.steam.fetch()      : Promise.resolve([]),
      want('news')       ? this.gameNews.fetch()   : Promise.resolve([]),
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

    // 6b. No image — try to find a YouTube video embedded in the article so
    // Telegram can render a large video preview instead of a bare link.
    let previewUrl: string | undefined;
    if (!imageBuffer && !item.imageUrl && item.source) {
      previewUrl = (await this.findYoutubeUrl(item.source)) ?? undefined;
      if (previewUrl) {
        text = `${text}\n\n${previewUrl}`;
      }
    }

    // 7. Publish
    // markPosted BEFORE telegram.publish. Symmetric with ai0-news fix from
    // 2026-05-15: if publish times out / crashes between Telegram-send and DB
    // write, the next cron tick would otherwise re-select the same item. We
    // accept the one-in-thousands loss-on-publish-failure trade-off to make
    // duplicates impossible.
    await this.dedup.markPosted(item.source, item.title, channelId, item.type);

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
            previewUrl,
          },
          { id: channelId },
        );
      }
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

  /**
   * Fetch the article URL and return the first YouTube video URL found
   * (iframe embed, og:video meta tag, or inline watch/youtu.be link),
   * normalized to `https://www.youtube.com/watch?v=<ID>` so Telegram renders
   * a video link preview reliably. Returns null if nothing is found or the
   * fetch fails. Best-effort: never throws.
   */
  private async findYoutubeUrl(articleUrl: string): Promise<string | null> {
    try {
      const res = await axios.get<string>(articleUrl, {
        timeout: 8000,
        responseType: 'text',
        maxContentLength: 5_000_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AI0Bot/1.0)',
          Accept: 'text/html',
        },
      });
      const html = res.data;
      if (typeof html !== 'string') return null;

      // Common video ID patterns. The first capture is the 11-char YouTube ID.
      const patterns = [
        /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i,
        /youtube\.com\/watch\?[^"'<>\s]*v=([A-Za-z0-9_-]{11})/i,
        /youtu\.be\/([A-Za-z0-9_-]{11})/i,
        /youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/i,
      ];

      for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) {
          return `https://www.youtube.com/watch?v=${m[1]}`;
        }
      }
      return null;
    } catch (err: any) {
      this.logger.debug(`findYoutubeUrl(${articleUrl}) failed: ${err.message}`);
      return null;
    }
  }
}
