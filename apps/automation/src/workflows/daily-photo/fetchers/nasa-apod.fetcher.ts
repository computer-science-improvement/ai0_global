import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DailyPhotoItem } from '../types';

const APOD_URL = 'https://api.nasa.gov/planetary/apod';

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

      const data = res.data;

      if (data.media_type !== 'image') {
        this.logger.log(`Skipping non-image APOD (media_type: ${data.media_type})`);
        return null;
      }

      return {
        title:       data.title,
        explanation: data.explanation,
        imageUrl:    data.url,
        hdUrl:       data.hdurl ?? null,
        date:        data.date,
        mediaType:   data.media_type,
        copyright:   data.copyright ?? null,
      };
    } catch (err) {
      this.logger.error(`NASA APOD fetch failed: ${err.message}`);
      return null;
    }
  }
}
