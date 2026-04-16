import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GameChannelItem } from '../types';

const MIN_DISCOUNT = 50;

interface SteamAppDetails {
  short_description?: string;
  genres?: { description: string }[];
  pc_requirements?: { minimum?: string };
}

interface SteamReviewSummary {
  review_score_desc?: string;
  total_reviews?: number;
}

@Injectable()
export class SteamDealsFetcher {
  private readonly logger = new Logger(SteamDealsFetcher.name);

  async fetch(): Promise<GameChannelItem[]> {
    try {
      const res = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
        params:  { cc: 'UA', l: 'english' },
        timeout: 15_000,
      });

      const items: any[] = res.data?.specials?.items ?? [];

      const deals = items.filter((item) => (item.discount_percent ?? 0) >= MIN_DISCOUNT);

      // Enrich each deal with metadata from appdetails + reviews
      const enriched = await Promise.all(
        deals.map((item) => this.buildItem(item)),
      );

      return enriched;
    } catch (err) {
      this.logger.warn(`Steam deals fetch failed: ${err.message}`);
      return [];
    }
  }

  private async buildItem(item: any): Promise<GameChannelItem> {
    const appId = item.id;
    const currency   = item.currency ?? 'USD';
    const finalCents = item.final_price ?? 0;
    const origCents  = item.original_price ?? 0;
    const decimals   = currency === 'JPY' ? 0 : 2;
    const fmt = (cents: number) =>
      (cents / Math.pow(10, decimals)).toFixed(decimals);

    const [details, reviews] = await Promise.all([
      this.fetchAppDetails(appId),
      this.fetchReviews(appId),
    ]);

    return {
      type:        'deal',
      title:       item.name,
      description: details?.short_description ?? '',
      source:      `https://store.steampowered.com/app/${appId}`,
      imageUrl:    item.large_capsule_image || item.header_image || null,
      publishedAt: null,
      platform:    'PC (Steam)',
      discount:    item.discount_percent,
      salePrice:   `${fmt(finalCents)} ${currency}`,
      origPrice:   `${fmt(origCents)} ${currency}`,
      reviewScore: reviews?.review_score_desc ?? undefined,
      reviewCount: reviews?.total_reviews ?? undefined,
      genres:      details?.genres?.map((g) => g.description) ?? undefined,
      minRam:      this.parseRequirement(details, 'Memory'),
      minStorage:  this.parseRequirement(details, 'Storage'),
    };
  }

  private parseRequirement(details: SteamAppDetails | null, field: string): string | undefined {
    const html = details?.pc_requirements?.minimum;
    if (!html) return undefined;
    const match = html.match(new RegExp(`<strong>${field}:<\\/strong>\\s*([^<]+)`));
    return match?.[1]?.trim() || undefined;
  }

  private async fetchAppDetails(appId: number): Promise<SteamAppDetails | null> {
    try {
      const res = await axios.get('https://store.steampowered.com/api/appdetails', {
        params: { appids: appId, l: 'english' },
        timeout: 10_000,
      });
      const data = res.data?.[String(appId)];
      return data?.success ? data.data : null;
    } catch {
      return null;
    }
  }

  private async fetchReviews(appId: number): Promise<SteamReviewSummary | null> {
    try {
      const res = await axios.get(`https://store.steampowered.com/appreviews/${appId}`, {
        params: { json: 1, num_per_page: 0, language: 'all' },
        timeout: 10_000,
      });
      return res.data?.query_summary ?? null;
    } catch {
      return null;
    }
  }
}
