import { safeGet, RawGet } from '../../net/safe-http';
import type { Lookup } from '../../net/ssrf-guard';
import { API_SOURCE_NAMES, ApiSourceName } from './names';
import { AdapterContext, ApiAdapter, ApiAdapterError, Query } from './types';
import { nasaApodAdapter } from './nasa-apod.adapter';
import { spaceflightNewsAdapter } from './spaceflight-news.adapter';
import { tmdbTrendingAdapter } from './tmdb-trending.adapter';
import { epicFreeGamesAdapter } from './epic-free-games.adapter';
import { steamDealsAdapter } from './steam-deals.adapter';
import { gamerpowerAdapter } from './gamerpower.adapter';
import { onThisDayAdapter } from './on-this-day.adapter';

export { API_SOURCE_NAMES } from './names';
export type { ApiSourceName } from './names';
export { ApiAdapterError } from './types';
export type { ApiAdapter, ApiItem, ApiResult, AdapterContext } from './types';

export const API_ADAPTERS: Record<ApiSourceName, ApiAdapter> = {
  nasa_apod:            nasaApodAdapter,
  spaceflight_news:     spaceflightNewsAdapter,
  tmdb_trending:        tmdbTrendingAdapter,
  epic_free_games:      epicFreeGamesAdapter,
  steam_deals:          steamDealsAdapter,
  gamerpower_giveaways: gamerpowerAdapter,
  on_this_day:          onThisDayAdapter,
};

// Every registered adapter has a name in API_SOURCE_NAMES and vice versa.
for (const n of API_SOURCE_NAMES) if (API_ADAPTERS[n].name !== n) throw new Error(`api adapter ${n} misregistered`);

/** API keys travel in query strings (NASA, TMDB): never echo them back into traces. */
export function redactSecrets(s: string): string {
  return s.replace(/([?&](?:api_key|key|token|access_token)=)[^&\s"']+/gi, '$1***');
}

export function withQuery(url: string, query: Query = {}): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

export interface AdapterContextDeps {
  env:     (key: string) => string | undefined;
  now?:    () => Date;
  lookup?: Lookup;
  get?:    RawGet;
}

/** JSON GET over safeGet: SSRF check on every redirect hop, 2 MB cap, 10 s timeout. */
export function makeAdapterContext(d: AdapterContextDeps): AdapterContext {
  return {
    env: d.env,
    now: d.now ?? (() => new Date()),
    async getJson(url, query) {
      const res = await safeGet(withQuery(url, query), { lookup: d.lookup, get: d.get, timeoutMs: 15_000, accept: 'application/json' });
      if (res.status >= 400) throw new ApiAdapterError('http_error', `${new URL(res.url).hostname} → status ${res.status}`);
      try {
        return JSON.parse(res.body);
      } catch {
        throw new ApiAdapterError('bad_response', `${new URL(res.url).hostname} returned non-JSON`);
      }
    },
  };
}
