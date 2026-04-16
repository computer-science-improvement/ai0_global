import { Module } from '@nestjs/common';
import { FactsStrategy }    from './facts.strategy';
import { FactsRepository }  from './facts.repository';

@Module({
  providers: [FactsStrategy, FactsRepository],
  exports:   [FactsStrategy],
})
export class FactsStrategyModule {}
