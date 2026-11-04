import { z } from 'zod';
import { EPIC_FREE_GAMES_PARAMS, EPIC_FREE_GAMES_URL, mapEpicFreeGames, mapEpicUpcomingFreeGames } from '../../../common/fetchers/apis/games.api';
import type { GameChannelItem } from '../../../workflows/game-channel/types';
import { clip, defineAdapter, type ApiItem } from './types';

const UPCOMING_NOTE = 'status upcoming — гра ще не безкоштовна: пиши «безкоштовно з <starts_at_local>», не «вже можна забрати».';

/** Epic Games Store giveaways: free now and next (same endpoint as the game-channel strategy). */
export const epicFreeGamesAdapter = defineAdapter({
  name: 'epic_free_games',
  description: 'epic_free_games — роздачі Epic Games Store: зараз безкоштовні (status free_now, до ends_at) і наступні (status upcoming, з starts_at). params: {}',
  params: z.object({}).strict(),
  async fetch(_p, ctx) {
    const data = await ctx.getJson(EPIC_FREE_GAMES_URL, EPIC_FREE_GAMES_PARAMS);
    const elements = data?.data?.Catalog?.searchStore?.elements;
    const nowMs = ctx.now().getTime();
    // Spec 086 FR-001: free now first, then the offers that start later; each carries its own offer's window.
    const item = (g: GameChannelItem, status: 'free_now' | 'upcoming'): ApiItem => ({
      title: g.title, summary: clip(g.description), url: g.source, image: g.imageUrl, date: g.startDate ?? g.publishedAt,
      extra: { status, platform: g.platform, starts_at: g.startDate ?? null, ends_at: g.endDate ?? null },
    });
    const upcoming = mapEpicUpcomingFreeGames(elements, nowMs).map((g) => item(g, 'upcoming'));
    return {
      items: [...mapEpicFreeGames(elements, nowMs).map((g) => item(g, 'free_now')), ...upcoming],
      ...(upcoming.length ? { note: UPCOMING_NOTE } : {}),
    };
  },
});
