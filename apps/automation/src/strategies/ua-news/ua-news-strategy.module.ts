import { Module } from '@nestjs/common';
import { UaNewsStrategy } from './ua-news.strategy';

@Module({
  providers: [UaNewsStrategy],
  exports:   [UaNewsStrategy],
})
export class UaNewsStrategyModule {}
