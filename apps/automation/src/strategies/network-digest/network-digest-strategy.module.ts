import { Module } from '@nestjs/common';
import { NetworkDigestStrategy }   from './network-digest.strategy';
import { NetworkDigestRepository } from './network-digest.repository';

@Module({
  providers: [NetworkDigestStrategy, NetworkDigestRepository],
  exports:   [NetworkDigestStrategy, NetworkDigestRepository],
})
export class NetworkDigestStrategyModule {}
