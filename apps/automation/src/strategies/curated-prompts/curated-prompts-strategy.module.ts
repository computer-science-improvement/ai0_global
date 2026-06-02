import { Module } from '@nestjs/common';
import { CuratedPromptsStrategy }   from './curated-prompts.strategy';
import { CuratedPromptsRepository } from './curated-prompts.repository';

@Module({
  providers: [CuratedPromptsStrategy, CuratedPromptsRepository],
  exports:   [CuratedPromptsStrategy],
})
export class CuratedPromptsStrategyModule {}
