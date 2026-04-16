import { Module } from '@nestjs/common';
import { SpaceStrategy }    from './space.strategy';
import { SpaceNewsFetcher } from '../../workflows/space/fetchers/space-news.fetcher';

@Module({
  providers: [SpaceStrategy, SpaceNewsFetcher],
  exports:   [SpaceStrategy],
})
export class SpaceStrategyModule {}
