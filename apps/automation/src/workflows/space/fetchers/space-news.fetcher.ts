import { Injectable, Logger } from '@nestjs/common';
import { SpaceItem } from '../types';
import { mapSpaceflightArticles, spaceflightArticlesUrl } from '../../../common/fetchers/apis/spaceflight-news.api';

const API_URL = spaceflightArticlesUrl(10);

@Injectable()
export class SpaceNewsFetcher {
  private readonly logger = new Logger(SpaceNewsFetcher.name);

  async fetch(): Promise<SpaceItem[]> {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) {
        this.logger.warn(`Spaceflight News API returned ${res.status}`);
        return [];
      }

      return mapSpaceflightArticles(await res.json());
    } catch (err) {
      this.logger.warn(`Spaceflight News fetch failed: ${err.message}`);
      return [];
    }
  }
}
