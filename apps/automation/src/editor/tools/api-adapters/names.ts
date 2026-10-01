/** fetch_api sources (spec 009 T001). Kept separate so card validation can import it without the adapters. */
export const API_SOURCE_NAMES = [
  'nasa_apod', 'spaceflight_news', 'tmdb_trending', 'epic_free_games', 'steam_deals', 'gamerpower_giveaways', 'on_this_day',
] as const;

export type ApiSourceName = typeof API_SOURCE_NAMES[number];
