/** fetch_api sources (spec 009 T001). Kept separate so card validation can import it without the adapters. */
export const API_SOURCE_NAMES = [
  'nasa_apod', 'spaceflight_news', 'tmdb_trending', 'epic_free_games', 'steam_deals', 'gamerpower_giveaways', 'on_this_day',
] as const;

export type ApiSourceName = typeof API_SOURCE_NAMES[number];

/**
 * The key an adapter reads (spec 023 FR-008: the catalog says `configured`, never the value). `required`:
 * without it the adapter fails; otherwise it falls back (NASA's DEMO_KEY, rate-limited).
 */
export const API_KEY_ENV: Partial<Record<ApiSourceName, { env: string; required: boolean }>> = {
  nasa_apod:     { env: 'NASA_API_KEY', required: false },
  tmdb_trending: { env: 'TMDB_API_KEY', required: true },
};
