import { Module } from '@nestjs/common';
import { RecipesStrategy } from './recipes.strategy';
import { MealDbFetcher }   from '../../workflows/recipes/fetchers/mealdb.fetcher';

@Module({
  providers: [RecipesStrategy, MealDbFetcher],
  exports:   [RecipesStrategy],
})
export class RecipesStrategyModule {}
