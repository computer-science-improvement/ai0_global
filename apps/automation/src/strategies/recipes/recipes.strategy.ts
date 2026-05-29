import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ClaudeAgent }             from '../../common/ai/agents/claude.agent';
import { PostValidator }           from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { RECIPES_CHANNEL_SKILL }   from '../../common/ai/skills/recipes-channel.skill';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  RECIPE_TRANSLATE_PROMPT, buildRecipeTranslateUserMessage,
} from '../../common/ai/prompts/recipe-translate.prompts';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { RecipesRepository, RecipeRow } from './recipes.repository';

const CAPTION_MAX = 1024;
const REPLY_MAX   = 4096;
const USER_AGENT  =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

@Injectable()
export class RecipesStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(RecipesStrategy.name);
  readonly type = 'recipes';

  constructor(
    private readonly claude:       ClaudeAgent,
    private readonly validator:    PostValidator,
    private readonly registry:     ContentStrategyRegistry,
    private readonly publisher:    TelegramPublisher,
    private readonly repo:         RecipesRepository,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [RECIPES_CHANNEL_SKILL];
  }

  // Unused: this strategy drives itself via execute().
  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    return null;
  }
  async generate(_data: StrategyFetchResult, _params: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> {
    return null;
  }

  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const row = await this.repo.getNext();
    if (!row) { this.logger.debug('No unposted recipes'); return; }

    const uk = await this.resolveTranslation(row);
    if (!uk) return; // translation unavailable/failed (sentinel already handled)

    const caption   = this.buildCaption(uk.titleUk, row.category, uk.ingredientsUk);
    const replyText = this.buildReply(uk.instructionsUk);

    let imageBuffer: Buffer;
    try {
      imageBuffer = await this.downloadImage(row.image_url);
    } catch (err: any) {
      this.logger.warn(`Image download failed (${row.id}): ${err.message}`);
      return; // do not mark posted — retry next run (translation already cached)
    }

    try {
      const messageId = await this.publisher.publishPrompt(
        { imageBuffer, caption, replyText: replyText || undefined },
        { id: channelId },
      );
      await this.repo.markPosted(row.id);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.image_url,
        title:        uk.titleUk.slice(0, 200),
        strategyType: this.type,
        tags:         row.category ? [row.category] : [],
      });
      this.logger.debug(`Published recipe ${row.id} to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Publish failed (${row.id}): ${err.message}`);
    }
  }

  /**
   * Return the Ukrainian fields for a row, translating + caching on first use.
   * Returns null when we must abort this run:
   *   - Claude unavailable -> retry later (no sentinel written).
   *   - bad translation (SKIP_POST / invalid JSON / missing fields / validator
   *     reject) -> write the empty-title sentinel so the row is skipped forever
   *     (caps translation cost to one attempt per row).
   */
  private async resolveTranslation(
    row: RecipeRow,
  ): Promise<{ titleUk: string; ingredientsUk: string; instructionsUk: string } | null> {
    if (row.title_uk !== null && row.title_uk !== '') {
      return {
        titleUk:        row.title_uk,
        ingredientsUk:  row.ingredients_uk ?? '',
        instructionsUk: row.instructions_uk ?? '',
      };
    }

    if (!this.claude.available) { this.logger.warn('Claude not available'); return null; }

    const raw = await this.claude.chat([
      { role: 'system', content: RECIPE_TRANSLATE_PROMPT.system },
      { role: 'user',   content: buildRecipeTranslateUserMessage(row) },
    ]);

    const fail = async (why: string) => {
      this.logger.warn(`Translation rejected (${row.id}): ${why} — writing skip sentinel`);
      await this.repo.saveTranslation(row.id, { titleUk: '', ingredientsUk: '', instructionsUk: '' });
      return null;
    };

    if (!raw || raw.trim() === 'SKIP_POST') return fail('empty or SKIP_POST');
    if (!this.validator.check(raw, 'recipes')) return fail('validator rejected');

    let parsed: { title_uk?: string; ingredients_uk?: string; instructions_uk?: string };
    try {
      parsed = JSON.parse(raw.replace(/```json\s*/g, '').replace(/```\s*/g, ''));
    } catch {
      return fail('invalid JSON');
    }
    if (!parsed.title_uk || !parsed.ingredients_uk || !parsed.instructions_uk) {
      return fail('missing fields');
    }

    const uk = {
      titleUk:        parsed.title_uk,
      ingredientsUk:  parsed.ingredients_uk,
      instructionsUk: parsed.instructions_uk,
    };
    await this.repo.saveTranslation(row.id, uk);
    return uk;
  }

  private buildCaption(title: string, category: string | null, ingredients: string): string {
    const header = `<b>${title}</b>`;
    const meta   = category ? `🍽️ ${category}` : '';
    const ingHdr = '📝 Інгредієнти:';
    const fixed  = [header, meta, `${ingHdr}\n`].filter(Boolean).join('\n\n');
    const budget = CAPTION_MAX - fixed.length;
    const lines  = this.fitLines(ingredients, budget);
    return [header, meta, `${ingHdr}\n${lines}`].filter(Boolean).join('\n\n');
  }

  private buildReply(instructions: string): string {
    const head = '👨‍🍳 Приготування:\n';
    const full = head + (instructions ?? '');
    if (full.length <= REPLY_MAX) return full;
    const sliced = full.slice(0, REPLY_MAX - 1);
    const nl = sliced.lastIndexOf('\n');
    return (nl > head.length ? sliced.slice(0, nl) : sliced) + '…';
  }

  /** Keep whole '\n'-separated lines that fit within budget. */
  private fitLines(block: string, budget: number): string {
    const out: string[] = [];
    let used = 0;
    for (const line of (block ?? '').split('\n')) {
      const add = used === 0 ? line.length : line.length + 1;
      if (used + add > budget) break;
      out.push(line);
      used += add;
    }
    return out.join('\n');
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15_000,
    });
    return Buffer.from(res.data);
  }
}
