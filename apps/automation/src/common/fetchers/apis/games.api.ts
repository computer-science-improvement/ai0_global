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

/** One Epic promotional offer with its window as instants. */
export interface EpicOffer { startMs: number; endMs: number; startDate: string; endDate: string; percent: unknown }

function epicOffers(groups: any): EpicOffer[] {
  return (Array.isArray(groups) ? groups : [])
    .flatMap((g: any) => (Array.isArray(g?.promotionalOffers) ? g.promotionalOffers : []))
    .map((o: any) => ({
      startMs: new Date(o?.startDate).getTime(), endMs: new Date(o?.endDate).getTime(),
      startDate: o?.startDate, endDate: o?.endDate, percent: o?.discountSetting?.discountPercentage,
    }));
}

/**
 * Spec 086 FR-001: the offer that makes the game free right now — `start <= now < end` and 100% off — across all
 * `promotionalOffers` groups. Never a sale offer (any other discount) or an offer that has not started.
 */
export function epicFreeNowOffer(el: any, nowMs: number): EpicOffer | null {
  return epicOffers(el?.promotions?.promotionalOffers)
    .find((o) => o.startMs <= nowMs && o.endMs > nowMs && o.percent === 0) ?? null;
}

/** Spec 086 FR-001: the next free offer — in `upcomingPromotionalOffers`, 100% off, starting after now. */
export function epicUpcomingFreeOffer(el: any, nowMs: number): EpicOffer | null {
  return epicOffers(el?.promotions?.upcomingPromotionalOffers)
    .filter((o) => o.percent === 0 && o.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0] ?? null;
}

function epicItem(el: any, offer: EpicOffer): GameChannelItem {
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
    publishedAt: offer.startDate ?? null,
    platform:    'PC (Epic Games Store)',
    startDate:   offer.startDate ?? undefined,
    endDate:     offer.endDate ?? undefined,
    instructions: 'Додати у бібліотеку через Epic Games Store.',
  };
}

/** Epic `freeGamesPromotions` elements → games that are free right now (100% off, offer window open); dates of that offer. */
export function mapEpicFreeGames(elements: any[] | null | undefined, nowMs: number): GameChannelItem[] {
  return (elements ?? []).flatMap((el) => {
    const offer = epicFreeNowOffer(el, nowMs);
    return offer ? [epicItem(el, offer)] : [];
  });
}

/** Spec 086 FR-001: games with a free offer that has not started yet (not the ones free right now); `startDate` / `endDate` of that offer. */
export function mapEpicUpcomingFreeGames(elements: any[] | null | undefined, nowMs: number): GameChannelItem[] {
  return (elements ?? []).flatMap((el) => {
    if (epicFreeNowOffer(el, nowMs)) return [];
    const offer = epicUpcomingFreeOffer(el, nowMs);
    return offer ? [epicItem(el, offer)] : [];
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

/**
 * Spec 086 FR-002: «YYYY-MM-DD 23:59[:SS]» (space or T, no zone) is the end of a day, not a moment — it becomes the date,
 * so no `*_local` time is invented. Any other form stays as it is.
 */
export function gamerPowerEnd(raw: string | null | undefined): string | undefined {
  if (!raw || raw === 'N/A') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[ T]23:59(?::\d{2})?$/.exec(raw.trim());
  return m ? m[1] : raw;
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
      endDate:      gamerPowerEnd(g.end_date),
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
    // Spec 086 FR-003: the deal ends when the discount does (Unix seconds).
    endDate:     Number(item.discount_expiration) > 0 ? new Date(Number(item.discount_expiration) * 1000).toISOString() : undefined,
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
