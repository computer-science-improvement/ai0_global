import { Module } from '@nestjs/common';
import { ContentRunwayService } from './content-runway.service';
import { RecipesRepository } from '../../strategies/recipes/recipes.repository';
import { QuotesRepository } from '../../strategies/quotes/quotes.repository';
import { FactsRepository } from '../../strategies/facts/facts.repository';
import { CuratedPromptsRepository } from '../../strategies/curated-prompts/curated-prompts.repository';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { PdrQuizRepository } from '../../strategies/pdr-quiz/pdr-quiz.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';

@Module({
  providers: [
    ContentRunwayService,
    RecipesRepository, QuotesRepository, FactsRepository, CuratedPromptsRepository,
    PromptsRepository, PdrQuizRepository, MotivationBiographyRepository, AssetsRepository,
  ],
  exports: [ContentRunwayService],
})
export class ContentRunwayModule {}
