import { z } from 'zod';
import {
  EPIC_FREE_GAMES_PARAMS, EPIC_FREE_GAMES_URL, epicFreeNowOffer, GAMERPOWER_GIVEAWAYS_URL, GAMERPOWER_PARAMS, mapGamerPowerGiveaways,
} from '../../../common/fetchers/apis/games.api';
import { clip, defineAdapter } from './types';

const normTitle = (s: unknown): string =>
  typeof s === 'string' ? s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
const isEpic = (platforms: string | undefined): boolean => /epic games store/i.test(platforms ?? '');

/** GamerPower active giveaways (no key; the game-channel strategy's "gamerpower" source). */
export const gamerpowerAdapter = defineAdapter({
  name: 'gamerpower_giveaways',
  description: 'gamerpower_giveaways — активні роздачі ігор і лута на всіх платформах. ends_at — дата (без часу) або момент магазину (ends_at_source); точний час роздачі в Epic бери з epic_free_games. params: {platform?: pc|steam|epic-games-store|gog|ps5|xbox-series-xs|switch|android|ios, type?: game|loot|beta, limit?: 1–20}',
  params: z.object({
    platform: z.enum(['pc', 'steam', 'epic-games-store', 'gog', 'ps5', 'xbox-series-xs', 'switch', 'android', 'ios']).optional(),
    type:     z.enum(['game', 'loot', 'beta']).optional(),
    limit:    z.number().int().min(1).max(20).default(10),
  }).strict(),
  async fetch(p, ctx) {
    const data = await ctx.getJson(GAMERPOWER_GIVEAWAYS_URL, { ...GAMERPOWER_PARAMS, platform: p.platform, type: p.type });
    const list = Array.isArray(data) ? data : [];
    const games = mapGamerPowerGiveaways(list, ctx.now().getTime()).slice(0, p.limit);

    // Spec 086 FR-002: the store's own moment beats GamerPower's date. Epic is read once, only when an Epic giveaway is
    // in the result, and best-effort: a failed read leaves the GamerPower values.
    const epicEnds: Array<{ title: string; endsAt: string }> = [];
    if (games.some((g) => isEpic(g.platform))) {
      try {
        const epic = await ctx.getJson(EPIC_FREE_GAMES_URL, EPIC_FREE_GAMES_PARAMS);
        const nowMs = ctx.now().getTime();
        for (const el of epic?.data?.Catalog?.searchStore?.elements ?? []) {
          const offer = epicFreeNowOffer(el, nowMs);
          const title = normTitle(el?.title);
          if (offer && title.length >= 3) epicEnds.push({ title, endsAt: offer.endDate });
        }
      } catch { /* the GamerPower values stay */ }
    }
    const epicEnd = (g: { title: string; platform?: string }): string | null =>
      isEpic(g.platform) ? epicEnds.find((e) => normTitle(g.title).includes(e.title))?.endsAt ?? null : null;

    return {
      items: games.map((g) => {
        const fromEpic = epicEnd(g);
        return {
          title: g.title, summary: clip(g.description), url: g.source, image: g.imageUrl, date: g.publishedAt,
          extra: {
            platforms: g.platform ?? null, ends_at: fromEpic ?? g.endDate ?? null, ends_at_source: fromEpic ? 'epic' : 'gamerpower',
            instructions: clip(g.instructions, 300),
          },
        };
      }),
    };
  },
});
