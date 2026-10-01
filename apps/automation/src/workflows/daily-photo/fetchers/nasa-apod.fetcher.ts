import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DailyPhotoItem } from '../types';
import { APOD_URL, mapApod } from '../../../common/fetchers/apis/nasa-apod.api';

@Injectable()
export class NasaApodFetcher {
  private readonly logger = new Logger(NasaApodFetcher.name);

  constructor(private readonly configService: ConfigService) {}

  async fetch(): Promise<DailyPhotoItem | null> {
    const apiKey = this.configService.get<string>('NASA_API_KEY') ?? 'DEMO_KEY';

    try {
      const res = await axios.get(APOD_URL, {
        params:  { api_key: apiKey },
        timeout: 15_000,
      });

      const item = mapApod(res.data);
      if (!item) {
        this.logger.log(`Skipping non-image APOD (media_type: ${res.data?.media_type})`);
        return null;
      }
      return item;
    } catch (err) {
      this.logger.error(`NASA APOD fetch failed: ${err.message}`);
      return null;
    }
  }
}
