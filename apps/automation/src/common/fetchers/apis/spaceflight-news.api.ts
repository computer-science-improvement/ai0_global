// Spaceflight News API v4: endpoint + pure response mapping. Shared by the
// legacy SpaceNewsFetcher (space strategy) and the editor fetch_api adapter.
import type { SpaceItem } from '../../../workflows/space/types';

export const SPACEFLIGHT_ARTICLES_URL = 'https://api.spaceflightnewsapi.net/v4/articles/';

export function spaceflightArticlesUrl(limit = 10): string {
  return `${SPACEFLIGHT_ARTICLES_URL}?limit=${limit}&ordering=-published_at`;
}

interface SpaceflightArticle {
  id:           number;
  title:        string;
  url:          string;
  image_url:    string;
  summary:      string;
  published_at: string;
}

export function mapSpaceflightArticles(data: { results?: SpaceflightArticle[] } | null | undefined): SpaceItem[] {
  if (!data?.results?.length) return [];
  return data.results.map((a) => ({
    title:       a.title,
    description: a.summary,
    source:      a.url,
    imageUrl:    a.image_url ?? null,
    publishedAt: a.published_at ?? null,
    contentType: 'news' as const,
  }));
}
