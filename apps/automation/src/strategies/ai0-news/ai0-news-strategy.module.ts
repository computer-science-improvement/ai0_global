import { Module } from '@nestjs/common';
import { Ai0NewsStrategy } from './ai0-news.strategy';

@Module({
  providers: [Ai0NewsStrategy],
  exports:   [Ai0NewsStrategy],
})
export class Ai0NewsStrategyModule {}
