import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { HttpSource, RawItem } from '../types';
import { ArticleExtractorService } from '../processors/article-extractor.service';

type HttpSourceWithCsrf = HttpSource & { auth: { type: 'csrf'; tokenUrl: string } };

function isCsrfSource(source: HttpSource): source is HttpSourceWithCsrf {
  return source.auth?.type === 'csrf';
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

@Injectable()
export class HttpFetcherService {
  private readonly logger = new Logger(HttpFetcherService.name);

  constructor(private readonly extractor: ArticleExtractorService) {}

  async fetch(source: HttpSource): Promise<RawItem | null> {
    try {
      const data = isCsrfSource(source)
        ? await this.fetchWithCsrf(source)
        : await this.fetchDirect(source);

      return await this.mapByDomain(source, data);
    } catch (err) {
      this.logger.warn(`Failed to fetch ${source.url}: ${err.message}`);
      return null;
    }
  }

  private async fetchDirect(source: HttpSource) {
    const res = await axios.get(source.url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
      timeout: 15000,
    });
    return res.data;
  }

  private async fetchWithCsrf(source: HttpSourceWithCsrf) {
    // Step 1: get CSRF token + session cookie
    const tokenRes = await axios.get(source.auth.tokenUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Referer: source.url,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
    });

    const csrf = tokenRes.data;
    const rawCookie = tokenRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(rawCookie)
      ? rawCookie.map((c) => c.split(';')[0]).join('; ')
      : (rawCookie ?? '').split(';')[0];

    // Step 2: fetch data with CSRF token
    const res = await axios.get(source.url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
        Referer: source.url,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrf,
        Cookie: cookieHeader,
      },
      timeout: 15000,
    });
    return res.data;
  }

  /** Map raw API response to RawItem based on domain */
  private async mapByDomain(source: HttpSource, data: unknown): Promise<RawItem | null> {
    const domain = this.getDomain(source.url);

    switch (domain) {
      case 'mms.gov.ua':
        return this.mapMmsGovUa(source, data);
      default:
        this.logger.warn(`No mapper for domain: ${domain}`);
        return null;
    }
  }

  private async mapMmsGovUa(source: HttpSource, data: unknown): Promise<RawItem | null> {
    const body = (data as { body?: { data?: Record<string, unknown[]> } })?.body ?? data as Record<string, unknown>;
    const posts = (body as { data?: Record<string, unknown[]> })?.data;
    if (!posts) return null;

    // Get yesterday's date in Kyiv timezone
    const kyivNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
    kyivNow.setDate(kyivNow.getDate() - 1);
    const dd   = String(kyivNow.getDate()).padStart(2, '0');
    const mm   = String(kyivNow.getMonth() + 1).padStart(2, '0');
    const yyyy = String(kyivNow.getFullYear());
    const key  = `${dd}.${mm}.${yyyy}`;

    const todayPosts = posts[key];
    if (!Array.isArray(todayPosts) || !todayPosts.length) return null;

    const post = todayPosts[0] as { title?: string; url?: string; date_from?: string };
    if (!post.title || !post.url) return null;

    const content = await this.fetchAndExtract(post.url);

    return {
      title:   post.title,
      content,
      image:   null,
      source:  post.url,
      tags:    source.tags,
      isoDate: post.date_from ?? null,
    };
  }

  private async fetchAndExtract(url: string): Promise<string | null> {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        timeout: 15_000,
      });
      const html = typeof res.data === 'string' ? res.data : null;
      return html ? this.extractor.extract(html, url) : null;
    } catch (err) {
      this.logger.warn(`Failed to fetch article from ${url}: ${err.message}`);
      return null;
    }
  }

  private getDomain(url: string): string {
    const m = String(url).match(/^(?:https?:\/\/)?(?:www\.)?([^/?:#]+)/i);
    return m ? m[1] : '';
  }
}
