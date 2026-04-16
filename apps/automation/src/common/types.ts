/** Normalized item from any source (RSS or HTTP API) */
export interface RawItem {
  title: string;
  content: string | null;
  image: string | null;
  source: string;        // article URL (used as dedup key)
  tags: string[];
  isoDate: string | null;
}

/** Unified payload sent to any publisher */
export interface PostPayload {
  text: string;            // final formatted text (ready for the platform)
  imageUrl?: string;
  imageBuffer?: Buffer;    // downloaded image binary (preferred over imageUrl)
  source: string;          // original article URL
  tags: string[];
  title?: string;
}

/** RSS source config */
export interface RssSource {
  type: 'rss';
  url: string;
  tags: string[];
}

/** HTTP source config — no auth or CSRF */
export interface HttpSource {
  type: 'http';
  url: string;
  tags: string[];
  auth?: { type: 'csrf'; tokenUrl: string } | { type: 'none' };
}

export type SourceConfig = RssSource | HttpSource;

export type Platform = 'telegram' | 'instagram' | 'threads' | 'facebook';
