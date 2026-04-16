import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { RecipeItem } from '../types';

const API = 'https://www.themealdb.com/api/json/v1/1/random.php';

@Injectable()
export class MealDbFetcher {
  private readonly logger = new Logger(MealDbFetcher.name);

  async fetch(): Promise<RecipeItem | null> {
    try {
      const res = await axios.get(API, { timeout: 10_000 });
      const meal = res.data?.meals?.[0];
      if (!meal) {
        this.logger.warn('No meal returned from TheMealDB');
        return null;
      }

      const ingredients = this.extractIngredients(meal);

      return {
        title:        meal.strMeal,
        category:     meal.strCategory,
        area:         meal.strArea,
        instructions: meal.strInstructions,
        ingredients,
        imageUrl:     meal.strMealThumb || null,
        source:       `https://www.themealdb.com/meal/${meal.idMeal}`,
        youtubeUrl:   meal.strYoutube || null,
      };
    } catch (err) {
      this.logger.warn(`TheMealDB fetch failed: ${err.message}`);
      return null;
    }
  }

  private extractIngredients(meal: Record<string, string>): string[] {
    const ingredients: string[] = [];

    for (let i = 1; i <= 20; i++) {
      const ingredient = (meal[`strIngredient${i}`] ?? '').trim();
      const measure    = (meal[`strMeasure${i}`] ?? '').trim();

      if (!ingredient) continue;

      const line = measure ? `${measure} ${ingredient}` : ingredient;
      ingredients.push(line);
    }

    return ingredients;
  }
}
