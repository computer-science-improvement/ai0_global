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
   * Next recipe to post: not yet posted to Telegram, and not a "skip" sentinel
   * (empty title_uk). Oldest-first for deterministic ordering. A NULL title_uk
   * means "not translated yet" -> the strategy translates it; a non-empty
   * title_uk means "already translated" -> reuse it.
   */
  async getNext(): Promise<RecipeRow | null> {
    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT id, title, image_url, category, ingredients, instructions,
              title_uk, ingredients_uk, instructions_uk
       FROM recipes
       WHERE NOT (posted ? 'TELEGRAM')
         AND title_uk IS DISTINCT FROM ''
       ORDER BY created_at
       LIMIT 1`,
    );
    return rows[0] ?? null;
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

  /** Mark the row published to Telegram. */
  async markPosted(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE recipes
       SET posted = posted || jsonb_build_object('TELEGRAM', to_jsonb(now()))
       WHERE id = $1`,
      [id],
    );
  }
}
