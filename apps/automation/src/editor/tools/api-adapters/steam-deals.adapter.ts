import { z } from 'zod';
import {
  mapSteamDeal, STEAM_APPDETAILS_URL, STEAM_FEATURED_PARAMS, STEAM_FEATURED_URL, steamReviewsUrl, steamSpecials,
} from '../../../common/fetchers/apis/games.api';
import { clip, defineAdapter } from './types';

/** Steam featured specials with a big discount (same source as the game-channel strategy). */
export const steamDealsAdapter = defineAdapter({
  name: 'steam_deals',
  description: 'steam_deals — знижки Steam (ціна, знижка, відгуки, жанри). params: {min_discount?: 1–100 (50), limit?: 1–10 (5), enrich?: bool (true — опис, жанри, відгуки; +2 запити на гру)}',
  params: z.object({
    min_discount: z.number().int().min(1).max(100).default(50),
    limit:        z.number().int().min(1).max(10).default(5),
    enrich:       z.boolean().default(true),
  }).strict(),
  async fetch(p, ctx) {
    const data = await ctx.getJson(STEAM_FEATURED_URL, STEAM_FEATURED_PARAMS);
    const specials = steamSpecials(data, p.min_discount).slice(0, p.limit);
    const deals = await Promise.all(specials.map(async (item) => {
      if (!p.enrich) return mapSteamDeal(item, null, null);
      // Enrichment is best-effort, exactly like SteamDealsFetcher: a failed lookup leaves the fields empty.
      const [details, reviews] = await Promise.all([
        ctx.getJson(STEAM_APPDETAILS_URL, { appids: item.id, l: 'english' })
          .then((d) => (d?.[String(item.id)]?.success ? d[String(item.id)].data : null)).catch(() => null),
        ctx.getJson(steamReviewsUrl(item.id), { json: 1, num_per_page: 0, language: 'all' })
          .then((d) => d?.query_summary ?? null).catch(() => null),
      ]);
      return mapSteamDeal(item, details, reviews);
    }));
    return {
      items: deals.map((g) => ({
        title: g.title, summary: clip(g.description), url: g.source, image: g.imageUrl, date: null,
        extra: {
          discount_percent: g.discount, sale_price: g.salePrice, original_price: g.origPrice,
          review_score: g.reviewScore ?? null, review_count: g.reviewCount ?? null, genres: g.genres ?? [],
        },
      })),
    };
  },
});
