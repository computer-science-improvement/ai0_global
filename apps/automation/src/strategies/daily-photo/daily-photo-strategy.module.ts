import { Module } from '@nestjs/common';
import { DailyPhotoStrategy } from './daily-photo.strategy';
import { NasaApodFetcher }    from '../../workflows/daily-photo/fetchers/nasa-apod.fetcher';

@Module({
  providers: [DailyPhotoStrategy, NasaApodFetcher],
  exports:   [DailyPhotoStrategy],
})
export class DailyPhotoStrategyModule {}
