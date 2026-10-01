import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MovieItem } from '../types';
import { mapTmdbTrending, tmdbTrendingUrl } from '../../../common/fetchers/apis/tmdb.api';

@Injectable()
export class TmdbFetcher {
  private readonly logger = new Logger(TmdbFetcher.name);

  constructor(private readonly configService: ConfigService) {}

  async fetchTrending(): Promise<MovieItem[]> {
    const apiKey = this.configService.get<string>('TMDB_API_KEY');
    if (!apiKey) {
      this.logger.warn('TMDB_API_KEY not set — skipping fetch');
      return [];
    }

    try {
      const res = await axios.get(
        tmdbTrendingUrl('all', 'week'),
        {
          params: { api_key: apiKey, language: 'en-US' },
          timeout: 15_000,
        },
      );

      return mapTmdbTrending(res.data?.results, { minVotes: 50, limit: 20 });
    } catch (err) {
      this.logger.warn(`TMDB fetch failed: ${err.message}`);
      return [];
    }
  }
}
