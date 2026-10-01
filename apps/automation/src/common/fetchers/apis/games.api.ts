// Game sources (Epic free games, GamerPower giveaways, Steam specials): endpoints
// + pure response mapping. Shared by the legacy game-channel fetchers and the
// editor fetch_api adapters. No I/O here.
import type { GameChannelItem } from '../../../workflows/game-channel/types';

export const EPIC_FREE_GAMES_URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
export const EPIC_FREE_GAMES_PARAMS = { locale: 'en', country: 'UA', allowCountries: 'UA' };

export const GAMERPOWER_GIVEAWAYS_URL = 'https://gamerpower.com/api/giveaways';
export const GAMERPOWER_PARAMS = { 'sort-by': 'date', status: 'active' };

export const STEAM_FEATURED_URL = 'https://store.steampowered.com/api/featuredcategories/';
export const STEAM_FEATURED_PARAMS = { cc: 'UA', l: 'english' };
export const STEAM_APPDETAILS_URL = 'https://store.steampowered.com/api/appdetails';
export const steamReviewsUrl = (appId: number | string) => `https://store.steampowered.com/appreviews/${appId}`;
export const STEAM_MIN_DISCOUNT = 50;

/** Epic `freeGamesPromotions` elements → games that are free right now (100% off, offer window open). */
export function mapEpicFreeGames(elements: any[] | null | undefined, nowMs: number): GameChannelItem[] {
  return (elements ?? [])
    .filter((el) => {
      // Must have an active promotional offer (currently free)
      const offers: any[] = el.promotions?.promotionalOffers ?? [];
      return offers.some((group) =>
        (group.promotionalOffers ?? []).some((offer: any) => {
          const start = new Date(offer.startDate).getTime();
          const end   = new Date(offer.endDate).getTime();
          return start <= nowMs && end > nowMs && offer.discountSetting?.discountPercentage === 0;
        }),
      );
    })
    .map((el) => {
      const offer = el.promotions.promotionalOffers
        .flatMap((g: any) => g.promotionalOffers)
        .find((o: any) => new Date(o.endDate).getTime() > nowMs);

      const image =
        el.keyImages?.find((img: any) => img.type === 'OfferImageWide')?.url ??
        el.keyImages?.find((img: any) => img.type === 'Thumbnail')?.url ??
        null;

      const slug = el.productSlug || el.urlSlug || el.catalogNs?.mappings?.[0]?.pageSlug;
      const url  = slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/free-games';

      return {
        type:        'giveaway' as const,
        title:       el.title,
        description: el.description ?? '',
        source:      url,
        imageUrl:    image,
        publishedAt: offer?.startDate ?? null,
        platform:    'PC (Epic Games Store)',
        endDate:     offer?.endDate ?? undefined,
        instructions: 'Додати у бібліотеку через Epic Games Store.',
      };
    });
}

interface GamerPowerItem {
  id:                number;
  title:             string;
  description:       string;
  instructions:      string;
  type:              string;
  platforms:         string;
  end_date:          string;
  gamerpower_url:    string;
  image:             string;
  published_date:    string;
  status:            string;
}

/** GamerPower giveaways → active ones whose end date (if any) is still ahead. */
export function mapGamerPowerGiveaways(items: GamerPowerItem[] | null | undefined, nowMs: number): GameChannelItem[] {
  return (items ?? [])
    .filter((g) => {
      if (String(g.status ?? '').toLowerCase() !== 'active') return false;
      if (!g.end_date || g.end_date === 'N/A') return true;
      const end = new Date(g.end_date.replace(' ', 'T')).getTime();
      return isNaN(end) || end > nowMs;
    })
    .map((g) => ({
      type:         'giveaway' as const,
      title:        g.title,
      description:  g.description,
      source:       g.gamerpower_url,
      imageUrl:     g.image || null,
      publishedAt:  g.published_date,
      platform:     g.platforms,
      endDate:      g.end_date !== 'N/A' ? g.end_date : undefined,
      instructions: g.instructions,
    }));
}

export interface SteamAppDetails {
  short_description?: string;
  genres?: { description: string }[];
  pc_requirements?: { minimum?: string };
}

export interface SteamReviewSummary {
  review_score_desc?: string;
  total_reviews?: number;
}

/** `specials.items` of featuredcategories, filtered to at least `minDiscount`%. */
export function steamSpecials(data: any, minDiscount = STEAM_MIN_DISCOUNT): any[] {
  const items: any[] = data?.specials?.items ?? [];
  return items.filter((item) => (item.discount_percent ?? 0) >= minDiscount);
}

export function parseSteamRequirement(details: SteamAppDetails | null, field: string): string | undefined {
  const html = details?.pc_requirements?.minimum;
  if (!html) return undefined;
  const match = html.match(new RegExp(`<strong>${field}:<\\/strong>\\s*([^<]+)`));
  return match?.[1]?.trim() || undefined;
}

/** One Steam special (+ optional appdetails / review summary enrichment) → item. */
export function mapSteamDeal(item: any, details: SteamAppDetails | null, reviews: SteamReviewSummary | null): GameChannelItem {
  const appId = item.id;
  const currency   = item.currency ?? 'USD';
  const finalCents = item.final_price ?? 0;
  const origCents  = item.original_price ?? 0;
  const decimals   = currency === 'JPY' ? 0 : 2;
  const fmt = (cents: number) =>
    (cents / Math.pow(10, decimals)).toFixed(decimals);

  return {
    type:        'deal',
    title:       item.name,
    description: details?.short_description ?? '',
    source:      `https://store.steampowered.com/app/${appId}`,
    imageUrl:    item.large_capsule_image || item.header_image || null,
    publishedAt: null,
    platform:    'PC (Steam)',
    discount:    item.discount_percent,
    salePrice:   `${fmt(finalCents)} ${currency}`,
    origPrice:   `${fmt(origCents)} ${currency}`,
    reviewScore: reviews?.review_score_desc ?? undefined,
    reviewCount: reviews?.total_reviews ?? undefined,
    genres:      details?.genres?.map((g) => g.description) ?? undefined,
    minRam:      parseSteamRequirement(details, 'Memory'),
    minStorage:  parseSteamRequirement(details, 'Storage'),
  };
}
