import { Module } from '@nestjs/common';
import { RecipeCarouselStrategy } from './recipe-carousel.strategy';
import { RecipesStrategyModule } from '../recipes/recipes-strategy.module';

@Module({
  imports:   [RecipesStrategyModule],   // provides RecipesRepository (exported)
  providers: [RecipeCarouselStrategy],
})
export class RecipeCarouselStrategyModule {}
