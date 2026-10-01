import { z } from 'zod';
import { EPIC_FREE_GAMES_PARAMS, EPIC_FREE_GAMES_URL, mapEpicFreeGames } from '../../../common/fetchers/apis/games.api';
import { clip, defineAdapter } from './types';

/** Epic Games Store games that are free right now (same endpoint as the game-channel strategy). */
export const epicFreeGamesAdapter = defineAdapter({
  name: 'epic_free_games',
  description: 'epic_free_games — ігри, які зараз безкоштовні в Epic Games Store (до якої дати). params: {}',
  params: z.object({}).strict(),
  async fetch(_p, ctx) {
    const data = await ctx.getJson(EPIC_FREE_GAMES_URL, EPIC_FREE_GAMES_PARAMS);
    const games = mapEpicFreeGames(data?.data?.Catalog?.searchStore?.elements, ctx.now().getTime());
    return {
      items: games.map((g) => ({
        title: g.title, summary: clip(g.description), url: g.source, image: g.imageUrl, date: g.publishedAt,
        extra: { platform: g.platform, ends_at: g.endDate ?? null },
      })),
    };
  },
});
