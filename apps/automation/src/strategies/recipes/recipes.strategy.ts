import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClaudeAgent }              from '../../common/ai/agents/claude.agent';
import { PostValidator }            from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry }  from '../../common/content-strategy/content-strategy.registry';
import { MealDbFetcher }            from '../../workflows/recipes/fetchers/mealdb.fetcher';
import { RecipeItem }               from '../../workflows/recipes/types';
import { RECIPE_PROMPT, buildRecipeUserMessage } from '../../common/ai/prompts/recipes.prompts';
import { RECIPES_CHANNEL_SKILL }    from '../../common/ai/skills/recipes-channel.skill';
import { Skill }                    from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';

@Injectable()
export class RecipesStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(RecipesStrategy.name);

  readonly type = 'recipes';

  constructor(
    private readonly claude:    ClaudeAgent,
    private readonly validator: PostValidator,
    private readonly registry:  ContentStrategyRegistry,
    private readonly mealdb:    MealDbFetcher,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [RECIPES_CHANNEL_SKILL];
  }

  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    const item = await this.mealdb.fetch();
    if (!item) {
      this.logger.warn('No recipe fetched from MealDB');
      return null;
    }

    return {
      sourceUrl:   item.source,
      title:       item.title,
      contentType: 'recipe',
      data:        item,
    };
  }

  async generate(
    fetchResult: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null> {
    const item = fetchResult.data as RecipeItem;

    if (!this.claude.available) {
      this.logger.warn('Claude not available');
      return null;
    }

    const raw = await this.claude.chat([
      { role: 'system', content: RECIPE_PROMPT.system },
      { role: 'user',   content: buildRecipeUserMessage(item) },
    ]);

    if (raw?.trim() === 'SKIP_POST') {
      this.logger.warn('Model signalled SKIP_POST');
      return 'SKIP_POST';
    }

    if (!this.validator.check(raw, 'recipes')) return null;

    let parsed: { description: string; ingredients: string[] };
    try {
      const cleaned = raw!.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      parsed = JSON.parse(cleaned);
      if (!parsed.description || !Array.isArray(parsed.ingredients)) {
        this.logger.warn('Invalid AI response structure');
        return null;
      }
    } catch (err) {
      this.logger.warn(`Failed to parse AI response: ${err}`);
      return null;
    }

    const MAX_CAPTION = 1024;
    const header    = `<b>${item.title}</b>`;
    const meta      = `🍽️ ${item.category} · ${item.area}`;
    const ingHeader = '📝 Інгредієнти:';
    const fixedPart = `${header}\n\n${parsed.description}\n\n${meta}\n\n${ingHeader}\n`;
    const remaining = MAX_CAPTION - fixedPart.length;

    const ingredientLines = this.fitIngredients(parsed.ingredients, remaining);

    const text = `${header}\n\n${parsed.description}\n\n${meta}\n\n${ingHeader}\n${ingredientLines}`;

    return {
      text,
      imageUrl:    item.imageUrl ?? undefined,
      sourceUrl:   fetchResult.sourceUrl,
      title:       fetchResult.title,
      contentType: 'recipe',
    };
  }

  private fitIngredients(ingredients: string[], budget: number): string {
    const lines: string[] = [];
    let used = 0;

    for (const ingredient of ingredients) {
      const line = ingredient;
      const addition = used === 0 ? line.length : line.length + 1; // +1 for '\n'

      if (used + addition > budget) break;

      lines.push(line);
      used += addition;
    }

    return lines.join('\n');
  }
}
