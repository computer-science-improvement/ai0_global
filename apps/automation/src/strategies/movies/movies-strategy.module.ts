import { Module } from '@nestjs/common';
import { MoviesStrategy } from './movies.strategy';
import { TmdbFetcher }    from '../../workflows/movies/fetchers/tmdb.fetcher';

@Module({
  providers: [MoviesStrategy, TmdbFetcher],
  exports:   [MoviesStrategy],
})
export class MoviesStrategyModule {}
