import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GameChannelItem } from '../types';
import {
  STEAM_APPDETAILS_URL, STEAM_FEATURED_PARAMS, STEAM_FEATURED_URL, STEAM_MIN_DISCOUNT,
  SteamAppDetails, SteamReviewSummary, mapSteamDeal, steamReviewsUrl, steamSpecials,
} from '../../../common/fetchers/apis/games.api';

@Injectable()
export class SteamDealsFetcher {
  private readonly logger = new Logger(SteamDealsFetcher.name);

  async fetch(): Promise<GameChannelItem[]> {
    try {
      const res = await axios.get(STEAM_FEATURED_URL, {
        params:  STEAM_FEATURED_PARAMS,
        timeout: 15_000,
      });

      const deals = steamSpecials(res.data, STEAM_MIN_DISCOUNT);

      // Enrich each deal with metadata from appdetails + reviews
      const enriched = await Promise.all(
        deals.map((item) => this.buildItem(item)),
      );

      return enriched;
    } catch (err) {
      this.logger.warn(`Steam deals fetch failed: ${err.message}`);
      return [];
    }
  }

  private async buildItem(item: any): Promise<GameChannelItem> {
    const [details, reviews] = await Promise.all([
      this.fetchAppDetails(item.id),
      this.fetchReviews(item.id),
    ]);
    return mapSteamDeal(item, details, reviews);
  }

  private async fetchAppDetails(appId: number): Promise<SteamAppDetails | null> {
    try {
      const res = await axios.get(STEAM_APPDETAILS_URL, {
        params: { appids: appId, l: 'english' },
        timeout: 10_000,
      });
      const data = res.data?.[String(appId)];
      return data?.success ? data.data : null;
    } catch {
      return null;
    }
  }

  private async fetchReviews(appId: number): Promise<SteamReviewSummary | null> {
    try {
      const res = await axios.get(steamReviewsUrl(appId), {
        params: { json: 1, num_per_page: 0, language: 'all' },
        timeout: 10_000,
      });
      return res.data?.query_summary ?? null;
    } catch {
      return null;
    }
  }
}
