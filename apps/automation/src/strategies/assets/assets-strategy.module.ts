import { Module } from '@nestjs/common';
import { AssetsStrategy }    from './assets.strategy';
import { AssetsRepository }  from './assets.repository';

@Module({
  providers: [AssetsStrategy, AssetsRepository],
  exports:   [AssetsStrategy],
})
export class AssetsStrategyModule {}
