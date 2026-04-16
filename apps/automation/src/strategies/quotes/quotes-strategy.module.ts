import { Module } from '@nestjs/common';
import { QuotesStrategy }    from './quotes.strategy';
import { QuotesRepository }  from './quotes.repository';

@Module({
  providers: [QuotesStrategy, QuotesRepository],
  exports:   [QuotesStrategy],
})
export class QuotesStrategyModule {}
