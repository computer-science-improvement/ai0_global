import { Module } from '@nestjs/common';
import { OnThisDayStrategy } from './on-this-day.strategy';
import { ByabbeFetcher }     from '../../workflows/on-this-day/fetchers/byabbe.fetcher';

@Module({
  providers: [OnThisDayStrategy, ByabbeFetcher],
  exports:   [OnThisDayStrategy],
})
export class OnThisDayStrategyModule {}
