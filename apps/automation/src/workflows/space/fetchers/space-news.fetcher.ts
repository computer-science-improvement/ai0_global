import { Injectable, Logger } from '@nestjs/common';
import { SpaceItem } from '../types';

const API_URL =
  'https://api.spaceflightnewsapi.net/v4/articles/?limit=10&ordering=-published_at';

interface SpaceflightArticle {
  id:           number;
  title:        string;
  url:          string;
  image_url:    string;
  summary:      string;
  published_at: string;
}

interface SpaceflightResponse {
  results: SpaceflightArticle[];
}

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

      const data: SpaceflightResponse = await res.json();
      if (!data.results?.length) return [];

      return data.results.map((a) => ({
        title:       a.title,
        description: a.summary,
        source:      a.url,
        imageUrl:    a.image_url ?? null,
        publishedAt: a.published_at ?? null,
        contentType: 'news' as const,
      }));
    } catch (err) {
      this.logger.warn(`Spaceflight News fetch failed: ${err.message}`);
      return [];
    }
  }
}
