import { Module } from '@nestjs/common';
import { Ai0PromptsStrategy }      from './ai0-prompts.strategy';
import { PromptsRepository }       from './prompts.repository';
import { PromptHeroScraperService } from '../../workflows/ai0-prompts/prompthero-scraper.service';

@Module({
  providers: [Ai0PromptsStrategy, PromptsRepository, PromptHeroScraperService],
  exports:   [Ai0PromptsStrategy],
})
export class Ai0PromptsStrategyModule {}
