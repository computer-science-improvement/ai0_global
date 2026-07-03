import { Module } from '@nestjs/common';
import { TopicDigestStrategy }   from './topic-digest.strategy';
import { TopicDigestRepository } from './topic-digest.repository';

@Module({
  providers: [TopicDigestStrategy, TopicDigestRepository],
  exports:   [TopicDigestStrategy],
})
export class TopicDigestStrategyModule {}
