import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface RecipeRow {
  id:              string;
  title:           string;
  image_url:       string;
  category:        string | null;
  ingredients:     string | null;
  instructions:    string | null;
  title_uk:        string | null;
  ingredients_uk:  string | null;
  instructions_uk: string | null;
  telegraph_url:   string | null;
  telegraph_path:  string | null;
  kcal:            string | null;  // pg NUMERIC → string
  protein_g:       string | null;
  fat_g:           string | null;
  carbs_g:         string | null;
  serving_size_g:  string | null;
}

export interface RecipeTranslation {
  titleUk:        string;
  ingredientsUk:  string;
  instructionsUk: string;
}

@Injectable()
export class RecipesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Next recipe to post: not yet posted to Telegram, not a "skip" sentinel
   * (empty title_uk), and HAS per-serving nutrition (kcal IS NOT NULL) so every
   * post carries the БЖВ block. ~91% of recipes have nutrition, so this is
   * plenty of inventory. Oldest-first for deterministic ordering. A NULL
   * title_uk means "not translated yet" -> the strategy translates it; a
   * non-empty title_uk means "already translated" -> reuse it.
   */
  async getNext(postedKey = 'TELEGRAM'): Promise<RecipeRow | null> {
    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT id, title, image_url, category, ingredients, instructions,
              title_uk, ingredients_uk, instructions_uk,
              telegraph_url, telegraph_path,
              kcal, protein_g, fat_g, carbs_g, serving_size_g
       FROM recipes
       WHERE NOT (posted ? $1)
         AND title_uk IS DISTINCT FROM ''
         AND kcal IS NOT NULL
       ORDER BY created_at
       LIMIT 1`,
      [postedKey],
    );
    return rows[0] ?? null;
  }

  /**
   * Next recipe for a carousel destination: already published to Telegram (so it
   * is translated), NOT yet posted to this Meta destination, not a skip sentinel,
   * and carries nutrition. Oldest-first. The Telegram strategy owns translation;
   * the carousel never calls Claude.
   */
  async getNextForCarousel(postedKey: string): Promise<RecipeRow | null> {
    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT id, title, image_url, category, ingredients, instructions,
              title_uk, ingredients_uk, instructions_uk,
              telegraph_url, telegraph_path,
              kcal, protein_g, fat_g, carbs_g, serving_size_g
       FROM recipes
       WHERE (posted ? 'TELEGRAM')
         AND NOT (posted ? $1)
         AND title_uk IS DISTINCT FROM ''
         AND kcal IS NOT NULL
       ORDER BY created_at
       LIMIT 1`,
      [postedKey],
    );
    return rows[0] ?? null;
  }

  async countEligible(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM recipes
       WHERE NOT (posted ? 'TELEGRAM')
         AND title_uk IS DISTINCT FROM ''
         AND kcal IS NOT NULL`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Cache a translation (or the empty-string skip sentinel) on the row. */
  async saveTranslation(id: string, t: RecipeTranslation): Promise<void> {
    await this.pool.query(
      `UPDATE recipes
       SET title_uk = $2, ingredients_uk = $3, instructions_uk = $4, translated_at = now()
       WHERE id = $1`,
      [id, t.titleUk, t.ingredientsUk, t.instructionsUk],
    );
  }

  /** Cache the Telegraph page so it's only created once per recipe. */
  async saveTelegraph(id: string, page: { url: string; path: string }): Promise<void> {
    await this.pool.query(
      `UPDATE recipes SET telegraph_url = $2, telegraph_path = $3 WHERE id = $1`,
      [id, page.url, page.path],
    );
  }

  /** Mark the row published to the given destination (default: Telegram). */
  async markPosted(id: string, postedKey = 'TELEGRAM'): Promise<void> {
    await this.pool.query(
      `UPDATE recipes
       SET posted = posted || jsonb_build_object($2::text, to_jsonb(now()))
       WHERE id = $1`,
      [id, postedKey],
    );
  }
}
