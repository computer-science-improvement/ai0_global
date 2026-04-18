import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Parser from 'rss-parser';
import { GameChannelItem } from '../types';

const NEWS_FEEDS = [
  { url: 'https://www.polygon.com/feed/',                                     name: 'Polygon'       },
  { url: 'https://www.eurogamer.net/?format=rss',                            name: 'Eurogamer'     },
  { url: 'https://www.pcgamer.com/rss/',                                     name: 'PC Gamer'      },
  { url: 'https://www.rockpapershotgun.com/feed/',                           name: 'RockPaperShotgun' },
  { url: 'https://www.gamespot.com/feeds/news/',                             name: 'GameSpot'      },
];

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)',
    'Accept':     'application/rss+xml, application/xml, text/xml, */*',
  },
});

@Injectable()
export class GameNewsFetcher {
  private readonly logger = new Logger(GameNewsFetcher.name);

  /** Fetch XML with axios and fix unescaped & before parsing */
  private async fetchXml(url: string): Promise<string> {
    const res = await axios.get<string>(url, {
      timeout: 15_000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    // Fix bare & that are not part of a valid XML entity (e.g. &amp; &#38; &lt; etc.)
    return (res.data as string).replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z]\w*);)/gi, '&amp;');
  }

  async fetch(): Promise<GameChannelItem[]> {
    const results: GameChannelItem[] = [];

    await Promise.all(
      NEWS_FEEDS.map(async (feed) => {
        try {
          const xml    = await this.fetchXml(feed.url);
          const parsed = await parser.parseString(xml);
          const entry  = parsed.items?.[0];
          if (!entry?.link) return;

          const content = (entry['content:encoded'] as string) || entry.content || entry.summary || '';
          const imageUrl = this.extractImage(entry) ?? null;

          results.push({
            type:        'news',
            title:       entry.title ?? '',
            description: this.stripHtml(content).slice(0, 500),
            source:      entry.link,
            imageUrl,
            publishedAt: entry.isoDate ?? entry.pubDate ?? null,
          });
        } catch (err) {
          this.logger.warn(`RSS fetch failed for ${feed.name}: ${err.message}`);
        }
      }),
    );

    return results;
  }

  private extractImage(entry: Record<string, unknown>): string | null {
    const encoded = entry['content:encoded'] as string | undefined;
    if (encoded) {
      const m = encoded.match(/<img[^>]+src="([^"]+)"/i);
      if (m) return m[1];
    }
    if (entry.image && typeof entry.image === 'object') {
      return (entry.image as { url?: string }).url ?? null;
    }
    return null;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
}
