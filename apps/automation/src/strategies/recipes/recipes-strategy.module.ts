import { Module } from '@nestjs/common';
import { RecipesStrategy }   from './recipes.strategy';
import { RecipesRepository } from './recipes.repository';

@Module({
  providers: [RecipesStrategy, RecipesRepository],
  exports:   [RecipesStrategy],
})
export class RecipesStrategyModule {}
