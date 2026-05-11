import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import Parser from 'rss-parser';
import axios, { AxiosRequestConfig } from 'axios';
import { RawItem, RssSource } from '../types';
import { StructuredLoggerService } from '../logging/structured-logger.service';

const RSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)',
  'Accept':     'application/rss+xml, application/xml, text/xml, */*',
};

const parser = new Parser({ timeout: 15000, headers: RSS_HEADERS });

@Injectable()
export class RssFetcherService implements OnModuleInit {
  private readonly logger = new Logger(RssFetcherService.name);
  private proxies: string[] = [];

  constructor(private readonly structured: StructuredLoggerService) {}

  onModuleInit() {
    try {
      const path = join(__dirname, '..', '..', '..', 'config', 'proxies.json');
      const cfg  = JSON.parse(readFileSync(path, 'utf-8'));
      this.proxies = Array.isArray(cfg.list) ? cfg.list.filter(Boolean) : [];
    } catch {
      // no proxies configured
    }
  }

  /** Fetch multiple RSS feeds and return the latest item per domain */
  async fetchLatest(sources: RssSource[]): Promise<RawItem[]> {
    const allItems: Array<RawItem & { domain: string }> = [];

    await Promise.all(
      sources.map(async (src) => {
        try {
          const feed = await this.parseFeed(src.url);
          const feedDomain = this.getDomain(src.url);
          const items = feed.items ?? [];
          this.structured.rss({
            source: src.url,
            count:  items.length,
            tags:   src.tags,
            titles: items.slice(0, 10).map((i) => i.title ?? ''),
          });
          for (const entry of items) {
            // Use feed domain + tag to allow multiple feeds from same publisher (e.g. theverge health vs tech)
            const domain = `${feedDomain}:${(src.tags ?? []).join(',')}`;
            allItems.push({
              domain,
              title:   entry.title ?? '',
              content: (entry['content:encoded'] as string) || entry.content || null,
              image:   this.extractImage(entry),
              source:  entry.link ?? src.url,
              tags:    src.tags,
              isoDate: entry.isoDate ?? entry.pubDate ?? null,
            });
          }
        } catch (err) {
          this.logger.warn(`Failed to fetch RSS ${src.url}: ${err.message}`);
          this.structured.error(`RSS fetch failed: ${src.url}`, { source: src.url, error: err.message });
        }
      }),
    );

    return this.pickLatestPerDomain(allItems);
  }

  /** Fetch and parse RSS feed, retrying through proxies on 403 and sanitizing broken XML */
  private async parseFeed(url: string): Promise<Parser.Output<Record<string, unknown>>> {
    // Try direct first — fall back to sanitized parse on XML errors
    try {
      return await parser.parseURL(url);
    } catch (err) {
      const is403 = err.statusCode === 403 || err.response?.status === 403;
      const isXmlError = /Invalid character in entity name|Unencoded|Non-whitespace before first tag|Unexpected end/i.test(err.message ?? '');

      if (isXmlError) {
        this.logger.warn(`RSS XML error for ${url} — refetching and sanitizing`);
        const res = await axios.get<string>(url, {
          headers: RSS_HEADERS, timeout: 15_000, responseType: 'text',
        });
        return await parser.parseString(this.sanitizeXml(res.data as string));
      }

      if (!is403) throw err;
      this.logger.warn(`RSS 403 for ${url} — retrying via proxy`);
    }

    // Retry with each proxy — skip on 403, try next only on connection/timeout errors
    for (const proxyUrl of this.proxies) {
      try {
        const config = this.buildProxyConfig(proxyUrl);
        const res    = await axios.get(url, {
          ...config,
          headers: RSS_HEADERS,
          timeout: 15_000,
        });
        this.logger.debug(`RSS via proxy: ${url}`);
        try {
          return await parser.parseString(res.data as string);
        } catch (parseErr: any) {
          if (/Invalid character in entity name|Unencoded|Non-whitespace/i.test(parseErr.message ?? '')) {
            return await parser.parseString(this.sanitizeXml(res.data as string));
          }
          throw parseErr;
        }
      } catch (err) {
        const status = err.response?.status;
        if (status === 403) {
          throw new Error(`RSS 403 via proxy — skipping ${url}`);
        }
        // connection/timeout error — try next proxy
      }
    }

    throw new Error(`All proxies unavailable for ${url}`);
  }

  /**
   * Escape bare `&` that aren't already part of a valid XML/HTML entity.
   * Some feeds (e.g. marktechpost) ship unescaped ampersands inside titles
   * or descriptions, which kills the XML parser with "Invalid character in
   * entity name". This regex preserves real entities like `&amp;` `&#38;` `&#xA0;`.
   */
  private sanitizeXml(xml: string): string {
    return xml.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{0,10}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;');
  }

  private buildProxyConfig(proxyUrl: string): AxiosRequestConfig {
    try {
      let host: string, port: number, username: string, password: string;
      if (proxyUrl.startsWith('http')) {
        const u = new URL(proxyUrl);
        host = u.hostname; port = parseInt(u.port, 10);
        username = decodeURIComponent(u.username); password = decodeURIComponent(u.password);
      } else {
        const [h, p, u, pw] = proxyUrl.split(':');
        host = h; port = parseInt(p, 10); username = u; password = pw;
      }
      return { proxy: { protocol: 'http', host, port, auth: { username, password } } };
    } catch {
      return {};
    }
  }

  /** Pick the single most recent item from each domain */
  private pickLatestPerDomain(
    items: Array<RawItem & { domain: string }>,
  ): RawItem[] {
    const map = new Map<string, RawItem & { domain: string }>();
    for (const item of items) {
      const existing = map.get(item.domain);
      if (
        !existing ||
        new Date(item.isoDate ?? 0) > new Date(existing.isoDate ?? 0)
      ) {
        map.set(item.domain, item);
      }
    }
    return Array.from(map.values()).map(({ domain: _d, ...item }) => item);
  }

  private getDomain(url: string): string {
    const m = url.match(/^(?:https?:\/\/)?([^/?#]+)/i);
    return m ? m[1] : url;
  }

  /** Extract image URL from RSS entry */
  private extractImage(entry: Record<string, unknown>): string | null {
    // 1. Explicit image object in feed (most reliable)
    if (entry.image && typeof entry.image === 'object') {
      return (entry.image as { url?: string }).url ?? null;
    }

    // 2. media:content or media:thumbnail
    const media = (entry['media:content'] ?? entry['media:thumbnail']) as Record<string, unknown> | undefined;
    if (media?.url && typeof media.url === 'string') return media.url;

    // 3. enclosure (podcast-style feeds sometimes use this for images)
    const enclosure = entry.enclosure as Record<string, unknown> | undefined;
    if (enclosure?.url && typeof enclosure.url === 'string' && String(enclosure.type ?? '').startsWith('image/')) {
      return enclosure.url as string;
    }

    // 4. content:encoded — find a large image (has explicit width >= 400)
    const encoded = entry['content:encoded'] as string | undefined;
    if (encoded) {
      // Try to find an img tag that has a width attribute >= 400
      const imgTags = [...encoded.matchAll(/<img[^>]+>/gi)];
      for (const [tag] of imgTags) {
        const widthMatch = tag.match(/width="(\d+)"/i);
        if (widthMatch && parseInt(widthMatch[1], 10) >= 400) {
          const srcMatch = tag.match(/src="([^"]+)"/i);
          if (srcMatch) return srcMatch[1].replace(/&#038;/g, '&');
        }
      }
    }

    return null;
  }
}
