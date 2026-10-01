import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { PostValidator }            from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { DedupService }             from '../../common/dedup/dedup.service';
import { TmdbFetcher }              from '../../workflows/movies/fetchers/tmdb.fetcher';
import { MovieItem }                from '../../workflows/movies/types';
import { MOVIE_PROMPT, buildMovieUserMessage, buildMoviePost } from '../../common/ai/prompts/movies.prompts';
import { MOVIES_CHANNEL_SKILL }     from '../../common/ai/skills/movies-channel.skill';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import { RawItem }                  from '../../common/types';
import { escapeAttr }               from '../../common/html';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
  StrategyRejection,
} from '../../common/content-strategy/content-strategy.interface';

@Injectable()
export class MoviesStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(MoviesStrategy.name);

  readonly type = 'movies';

  constructor(
    private readonly claude:    ClaudeAgent,
    private readonly validator: PostValidator,
    private readonly registry:  ContentStrategyRegistry,
    private readonly dedup:     DedupService,
    private readonly tmdb:      TmdbFetcher,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [MOVIES_CHANNEL_SKILL];
  }

  async fetch(_params: StrategyParams, channelId: string): Promise<StrategyFetchResult | null> {
    const items = await this.tmdb.fetchTrending();
    if (!items || items.length === 0) {
      this.logger.warn('No movies fetched from TMDB');
      return null;
    }

    const rawItems: RawItem[] = items.map(i => ({
      title:   i.title,
      content: null,
      image:   i.imageUrl,
      source:  i.source,
      tags:    [i.mediaType],
      isoDate: i.releaseDate,
    }));

    const unpostedRaw = await this.dedup.filterUnposted(rawItems, channelId);
    const unpostedSources = new Set(unpostedRaw.map(r => r.source));

    const item = items.find(i => unpostedSources.has(i.source));
    if (!item) {
      this.logger.debug('All trending movies already posted');
      return null;
    }

    return {
      sourceUrl:   item.source,
      title:       item.title,
      contentType: item.mediaType,
      data:        item,
    };
  }

  async generate(
    fetchResult: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | StrategyRejection | null> {
    const item = fetchResult.data as MovieItem;

    if (!this.claude.available) {
      this.logger.warn('Claude not available');
      return null;
    }

    const aiText = await this.claude.chat([
      { role: 'system', content: MOVIE_PROMPT.system },
      { role: 'user',   content: buildMovieUserMessage(item) },
    ]);

    if (aiText?.trim() === 'SKIP_POST') {
      this.logger.warn('Model signalled SKIP_POST');
      return 'SKIP_POST';
    }

    // Permanent rejections (refusal, too short, …) mark the source errored in
    // the runner; transient ones (no response, rate limit) return null → retry.
    const verdict = this.validator.validate(aiText);
    if (!verdict.valid) return this.validator.reject(verdict, 'movies');

    const link = '\n\n<a href="' + escapeAttr(item.source) + '">TMDB</a>';
    let text = buildMoviePost(item, aiText!) + link;

    if (text.length > 900) {
      const truncated = aiText!.slice(0, aiText!.length - (text.length - 890)) + '...';
      text = buildMoviePost(item, truncated) + link;
    }

    return {
      text,
      imageUrl:    item.imageUrl ?? undefined,
      sourceUrl:   fetchResult.sourceUrl,
      title:       fetchResult.title,
      contentType: fetchResult.contentType,
    };
  }
}
