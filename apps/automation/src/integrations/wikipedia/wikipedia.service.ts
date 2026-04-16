import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface WikiSummary {
  title:       string;
  description: string;
  extract:     string;
  imageUrl:    string | null;
  pageUrl:     string;
}

const WIKI_REST   = 'https://uk.wikipedia.org/api/rest_v1/page/summary';
const WIKI_API    = 'https://uk.wikipedia.org/w/api.php';
const USER_AGENT  = 'ai0_global_bot/1.0 (content automation; contact@example.com)';

@Injectable()
export class WikipediaService {
  private readonly logger = new Logger(WikipediaService.name);

  async getSummary(name: string): Promise<WikiSummary | null> {
    const direct = await this.fetchSummary(name);
    if (direct) return direct;

    const found = await this.search(name);
    if (!found) return null;

    return this.fetchSummary(found);
  }

  private async fetchSummary(title: string): Promise<WikiSummary | null> {
    try {
      const url = `${WIKI_REST}/${encodeURIComponent(title)}`;
      const res = await axios.get(url, { timeout: 10_000, headers: { 'User-Agent': USER_AGENT } });
      const d   = res.data;

      if (d.type === 'disambiguation') return null;

      const imageUrl = await this.fetchImage(d.title ?? title)
        ?? d.thumbnail?.source
        ?? null;

      return {
        title:       d.title ?? title,
        description: d.description ?? '',
        extract:     d.extract ?? '',
        imageUrl,
        pageUrl:     d.content_urls?.mobile?.page ?? d.content_urls?.desktop?.page ?? '',
      };
    } catch (err: any) {
      if (err.response?.status !== 404) {
        this.logger.warn(`Summary failed for "${title}": ${err.message}`);
      }
      return null;
    }
  }

  /** Fetch image via pageimages API — avoids Wikimedia Commons 403 */
  private async fetchImage(title: string): Promise<string | null> {
    try {
      const res = await axios.get(WIKI_API, {
        params: { action: 'query', titles: title, prop: 'pageimages', pithumbsize: 1200, format: 'json' },
        timeout: 10_000,
        headers: { 'User-Agent': USER_AGENT },
      });
      const pages = res.data?.query?.pages ?? {};
      const page  = Object.values(pages)[0] as any;
      return page?.thumbnail?.source ?? null;
    } catch {
      return null;
    }
  }

  private async search(name: string): Promise<string | null> {
    try {
      const res = await axios.get(WIKI_API, {
        params: { action: 'query', list: 'search', srsearch: name, srlimit: 1, format: 'json' },
        timeout: 10_000,
        headers: { 'User-Agent': USER_AGENT },
      });
      const hits: any[] = res.data?.query?.search ?? [];
      if (!hits.length) return null;
      this.logger.debug(`Search "${name}" → "${hits[0].title}"`);
      return hits[0].title as string;
    } catch (err: any) {
      this.logger.warn(`Search failed for "${name}": ${err.message}`);
      return null;
    }
  }
}
