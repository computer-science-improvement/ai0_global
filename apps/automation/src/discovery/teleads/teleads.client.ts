// apps/automation/src/discovery/teleads/teleads.client.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import axios from 'axios';

const BASE = 'https://teleads.com.ua/api/promo';

export interface TeleAdsPrice {
  id: number;
  type: string;        // '1day', '24h', 'always', etc.
  price: number;       // kopecks (UAH × 100)
}

export interface TeleAdsCategory {
  id: number;
  slug: string;
  title: string;
  status: string;
}

export interface TeleAdsAvatar {
  media?: {
    sizes?: Record<string, { url: string; width: number; height: number }>;
  };
}

export interface TeleAdsProduct {
  id: number;
  slug: string;
  link: string;
  title: string;
  description: string | null;
  source: string;
  status: string;
  type: string;
  language: string | null;
  sex: string;
  sex_ratio: number | null;
  prices: TeleAdsPrice[];
  categories: TeleAdsCategory[];
  avatar: TeleAdsAvatar | null;
}

export interface TeleAdsPage {
  data: TeleAdsProduct[];
  meta: { current_page: number; last_page: number; total: number; per_page: string | number };
  links: { first: string; last: string; prev: string | null; next: string | null };
}

/**
 * Pluggable HTTP fetcher. Real impl uses axios. Tests inject a stub. Returns
 * `data` and `status` so the retry path can branch on 429 / 5xx.
 */
export type HttpGet = (url: string, params: Record<string, string | number>) =>
  Promise<{ status: number; data: any }>;

const defaultHttpGet: HttpGet = async (url, params) => {
  const res = await axios.get(url, {
    params,
    timeout: 15_000,
    headers: { 'User-Agent': 'ai0_global/discovery (+ ingestion)' },
  });
  return { status: res.status, data: res.data };
};

@Injectable()
export class TeleAdsClient {
  private readonly logger = new Logger(TeleAdsClient.name);

  constructor(@Optional() private readonly httpGet: HttpGet = defaultHttpGet) {}

  async listProducts(opts: {
    page: number;
    perPage: number;
    categories?: number[];
    sort?: string;
  }): Promise<TeleAdsPage> {
    const params: Record<string, string | number> = {
      status: 'enabled',
      page: opts.page,
      per_page: opts.perPage,
    };
    if (opts.categories && opts.categories.length > 0) {
      params.filter = `categories:${opts.categories.join(',')};`;
    }
    if (opts.sort) params.sorting = opts.sort;

    return this.requestWithRetry(`${BASE}/products/`, params);
  }

  async listCategories(): Promise<TeleAdsCategory[]> {
    const res = await this.requestWithRetry(`${BASE}/categories/`, {
      type: 'product',
      status: 'enabled',
    });
    return res.data;
  }

  /** Exposed for tests + the (rare) caller that needs custom params. */
  async requestWithRetry(
    url: string,
    params: Record<string, string | number>,
    attempt = 1,
  ): Promise<any> {
    try {
      const { data } = await this.httpGet(url, params);
      return data;
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      const retriable = status === 429 || (status && status >= 500);
      if (retriable && attempt < 3) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        this.logger.warn(`TeleAds ${status} on ${url} — retry ${attempt}/3 after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        return this.requestWithRetry(url, params, attempt + 1);
      }
      throw err;
    }
  }
}
