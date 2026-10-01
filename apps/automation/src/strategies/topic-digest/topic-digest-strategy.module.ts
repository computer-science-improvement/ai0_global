import { Module } from '@nestjs/common';
import { TopicDigestStrategy }   from './topic-digest.strategy';
import { TopicDigestRepository } from './topic-digest.repository';
import { DigestSponsorsRepository } from '../../payments/digest-sponsors.repository';

@Module({
  providers: [TopicDigestStrategy, TopicDigestRepository, DigestSponsorsRepository],
  exports:   [TopicDigestStrategy],
})
export class TopicDigestStrategyModule {}
