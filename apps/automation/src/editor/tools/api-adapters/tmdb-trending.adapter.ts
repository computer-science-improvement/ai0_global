import { z } from 'zod';
import { mapTmdbTrending, tmdbTrendingUrl } from '../../../common/fetchers/apis/tmdb.api';
import { ApiAdapterError, clip, defineAdapter } from './types';

/** TMDB trending movies/series. Key: TMDB_API_KEY (same as the movies strategy). */
export const tmdbTrendingAdapter = defineAdapter({
  name: 'tmdb_trending',
  description: 'tmdb_trending — популярні фільми/серіали тижня або дня з TMDB (опис, рейтинг, жанри, постер). params: {media?: all|movie|tv, window?: day|week, language?: en-US|uk-UA, limit?: 1–20, min_votes?: number}',
  params: z.object({
    media:     z.enum(['all', 'movie', 'tv']).default('all'),
    window:    z.enum(['day', 'week']).default('week'),
    language:  z.enum(['en-US', 'uk-UA']).default('en-US'),
    limit:     z.number().int().min(1).max(20).default(10),
    min_votes: z.number().int().min(0).max(100_000).default(50),
  }).strict(),
  async fetch(p, ctx) {
    const apiKey = ctx.env('TMDB_API_KEY');
    if (!apiKey) throw new ApiAdapterError('missing_api_key', 'TMDB_API_KEY не налаштований — джерело недоступне');
    const data = await ctx.getJson(tmdbTrendingUrl(p.media, p.window), { api_key: apiKey, language: p.language });
    const results: any[] = (data?.results ?? []).map((r: any) => ({ ...r, media_type: r.media_type ?? (p.media === 'tv' ? 'tv' : 'movie') }));
    return {
      items: mapTmdbTrending(results, { minVotes: p.min_votes, limit: p.limit }).map((m) => ({
        title: m.title, summary: clip(m.overview), url: m.source, image: m.imageUrl, date: m.releaseDate || null,
        extra: {
          media_type: m.mediaType, original_title: m.originalTitle, vote_average: m.voteAverage, vote_count: m.voteCount,
          genres: m.genreNames, backdrop: m.backdropUrl,
        },
      })),
    };
  },
});
