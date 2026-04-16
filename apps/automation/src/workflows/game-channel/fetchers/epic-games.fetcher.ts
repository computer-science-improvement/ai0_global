import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GameChannelItem } from '../types';

const API_URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';

@Injectable()
export class EpicGamesFetcher {
  private readonly logger = new Logger(EpicGamesFetcher.name);

  async fetch(): Promise<GameChannelItem[]> {
    try {
      const res = await axios.get(API_URL, {
        params:  { locale: 'en', country: 'UA', allowCountries: 'UA' },
        timeout: 15_000,
      });

      const elements: any[] = res.data?.data?.Catalog?.searchStore?.elements ?? [];
      const now = Date.now();

      return elements
        .filter((el) => {
          // Must have an active promotional offer (currently free)
          const offers: any[] = el.promotions?.promotionalOffers ?? [];
          return offers.some((group) =>
            (group.promotionalOffers ?? []).some((offer: any) => {
              const start = new Date(offer.startDate).getTime();
              const end   = new Date(offer.endDate).getTime();
              return start <= now && end > now && offer.discountSetting?.discountPercentage === 0;
            }),
          );
        })
        .map((el) => {
          const offer = el.promotions.promotionalOffers
            .flatMap((g: any) => g.promotionalOffers)
            .find((o: any) => new Date(o.endDate).getTime() > now);

          const image =
            el.keyImages?.find((img: any) => img.type === 'OfferImageWide')?.url ??
            el.keyImages?.find((img: any) => img.type === 'Thumbnail')?.url ??
            null;

          const slug = el.productSlug || el.urlSlug || el.catalogNs?.mappings?.[0]?.pageSlug;
          const url  = slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/free-games';

          return {
            type:        'giveaway' as const,
            title:       el.title,
            description: el.description ?? '',
            source:      url,
            imageUrl:    image,
            publishedAt: offer?.startDate ?? null,
            platform:    'PC (Epic Games Store)',
            endDate:     offer?.endDate ?? undefined,
            instructions: 'Додати у бібліотеку через Epic Games Store.',
          };
        });
    } catch (err) {
      this.logger.warn(`Epic Games fetch failed: ${err.message}`);
      return [];
    }
  }
}
