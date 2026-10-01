import { z } from 'zod';
import { mapSpaceflightArticles, SPACEFLIGHT_ARTICLES_URL } from '../../../common/fetchers/apis/spaceflight-news.api';
import { clip, defineAdapter } from './types';

/** Spaceflight News API v4 (no key). Same endpoint as the space strategy. */
export const spaceflightNewsAdapter = defineAdapter({
  name: 'spaceflight_news',
  description: 'spaceflight_news — свіжі новини космонавтики (англ.), від нових до старих. params: {limit?: 1–20, search?: string}',
  params: z.object({
    limit:  z.number().int().min(1).max(20).default(10),
    search: z.string().trim().min(2).max(100).optional(),
  }).strict(),
  async fetch({ limit, search }, ctx) {
    const data = await ctx.getJson(SPACEFLIGHT_ARTICLES_URL, { limit, ordering: '-published_at', search });
    return {
      items: mapSpaceflightArticles(data).map((a) => ({
        title: a.title, summary: clip(a.description), url: a.source, image: a.imageUrl, date: a.publishedAt,
        extra: { news_site: (data?.results ?? []).find((r: any) => r.url === a.source)?.news_site ?? null },
      })),
    };
  },
});
