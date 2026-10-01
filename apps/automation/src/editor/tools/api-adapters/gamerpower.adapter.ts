import { z } from 'zod';
import { GAMERPOWER_GIVEAWAYS_URL, GAMERPOWER_PARAMS, mapGamerPowerGiveaways } from '../../../common/fetchers/apis/games.api';
import { clip, defineAdapter } from './types';

/** GamerPower active giveaways (no key; the game-channel strategy's "gamerpower" source). */
export const gamerpowerAdapter = defineAdapter({
  name: 'gamerpower_giveaways',
  description: 'gamerpower_giveaways — активні роздачі ігор і лута на всіх платформах. params: {platform?: pc|steam|epic-games-store|gog|ps5|xbox-series-xs|switch|android|ios, type?: game|loot|beta, limit?: 1–20}',
  params: z.object({
    platform: z.enum(['pc', 'steam', 'epic-games-store', 'gog', 'ps5', 'xbox-series-xs', 'switch', 'android', 'ios']).optional(),
    type:     z.enum(['game', 'loot', 'beta']).optional(),
    limit:    z.number().int().min(1).max(20).default(10),
  }).strict(),
  async fetch(p, ctx) {
    const data = await ctx.getJson(GAMERPOWER_GIVEAWAYS_URL, { ...GAMERPOWER_PARAMS, platform: p.platform, type: p.type });
    const list = Array.isArray(data) ? data : [];
    return {
      items: mapGamerPowerGiveaways(list, ctx.now().getTime()).slice(0, p.limit).map((g) => ({
        title: g.title, summary: clip(g.description), url: g.source, image: g.imageUrl, date: g.publishedAt,
        extra: { platforms: g.platform ?? null, ends_at: g.endDate ?? null, instructions: clip(g.instructions, 300) },
      })),
    };
  },
});
