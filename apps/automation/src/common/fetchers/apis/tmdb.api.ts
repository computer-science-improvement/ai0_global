// TMDB trending: endpoint + pure response mapping. Shared by the legacy
// TmdbFetcher (movies strategy) and the editor fetch_api adapter.
import type { MovieItem } from '../../../workflows/movies/types';

export const TMDB_API = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

export type TmdbMedia = 'all' | 'movie' | 'tv';
export type TmdbWindow = 'day' | 'week';

export function tmdbTrendingUrl(media: TmdbMedia = 'all', window: TmdbWindow = 'week'): string {
  return `${TMDB_API}/trending/${media}/${window}`;
}

export const TMDB_GENRES: Record<number, string> = {
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

export interface TmdbMapOpts {
  /** Drop titles with fewer votes (legacy strategy: 50). */
  minVotes?: number;
  limit?:    number;
}

/** `results` of a trending response → items with at least `minVotes` votes and an overview. */
export function mapTmdbTrending(results: any[] | null | undefined, opts: TmdbMapOpts = {}): MovieItem[] {
  const minVotes = opts.minVotes ?? 50;
  return (results ?? [])
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
          .map((id) => TMDB_GENRES[id])
          .filter(Boolean) as string[],
        imageUrl: r.poster_path ? `${TMDB_IMAGE_BASE}${r.poster_path}` : null,
        backdropUrl: r.backdrop_path ? `${TMDB_IMAGE_BASE}${r.backdrop_path}` : null,
        source: `https://www.themoviedb.org/${mediaType}/${r.id}`,
        mediaType,
      };
    })
    .filter((item) => item.voteCount >= minVotes && item.overview.length > 0)
    .slice(0, opts.limit ?? 20);
}
