import { Module } from '@nestjs/common';
import { NetworkDigestStrategy }   from './network-digest.strategy';
import { NetworkDigestRepository } from './network-digest.repository';
import { DigestSponsorsRepository } from '../../payments/digest-sponsors.repository';

@Module({
  providers: [NetworkDigestStrategy, NetworkDigestRepository, DigestSponsorsRepository],
  exports:   [NetworkDigestStrategy, NetworkDigestRepository],
})
export class NetworkDigestStrategyModule {}
