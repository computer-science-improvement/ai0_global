import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { MovieItem } from '../types';

const GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-Fi',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

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
        'https://api.themoviedb.org/3/trending/all/week',
        {
          params: { api_key: apiKey, language: 'en-US' },
          timeout: 15_000,
        },
      );

      const results: any[] = res.data?.results ?? [];

      const items: MovieItem[] = results
        .map((r): MovieItem => {
          const mediaType = r.media_type === 'tv' ? 'tv' : 'movie';
          const title = mediaType === 'tv' ? r.name : r.title;
          const originalTitle = mediaType === 'tv' ? r.original_name : r.original_title;
          const releaseDate = mediaType === 'tv' ? r.first_air_date : r.release_date;
          const genreIds: number[] = r.genre_ids ?? [];

          return {
            title: title ?? '',
            originalTitle: originalTitle ?? '',
            overview: r.overview ?? '',
            releaseDate: releaseDate ?? '',
            voteAverage: r.vote_average ?? 0,
            voteCount: r.vote_count ?? 0,
            genreNames: genreIds
              .map((id) => GENRE_MAP[id])
              .filter(Boolean) as string[],
            imageUrl: r.poster_path ? `${IMAGE_BASE}${r.poster_path}` : null,
            backdropUrl: r.backdrop_path ? `${IMAGE_BASE}${r.backdrop_path}` : null,
            source: `https://www.themoviedb.org/${mediaType}/${r.id}`,
            mediaType,
          };
        })
        .filter((item) => item.voteCount >= 50 && item.overview.length > 0);

      return items.slice(0, 20);
    } catch (err) {
      this.logger.warn(`TMDB fetch failed: ${err.message}`);
      return [];
    }
  }
}
