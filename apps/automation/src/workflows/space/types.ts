export type SpaceContentType = 'news' | 'launch' | 'discovery';

export interface SpaceItem {
  title:       string;
  description: string;
  source:      string;       // URL — used for dedup
  imageUrl:    string | null;
  publishedAt: string | null;
  contentType: SpaceContentType;
}
