import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ClaudeAgent }             from '../../common/ai/agents/claude.agent';
import { PostValidator }           from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegraphService, buildRecipeNodes, fmtNum } from '../../publishers/telegraph.service';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { CrossPostService }        from '../../publishers/cross-post.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { PublisherDispatcher }     from '../../publishers/publisher-dispatcher.service';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import type { PublishDestination, DestinationPlatform } from '../../common/content-strategy/publish-destination';
import type { MetaPlatform } from '../../config/meta-accounts.repository';
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
// Recipe translation uses Sonnet, not the default Haiku — Haiku produces poor
// Ukrainian (invented verb forms, wrong noun cases). Pinned snapshot for
// stability. Override via RECIPE_TRANSLATE_MODEL env if needed.
const TRANSLATE_MODEL = process.env.RECIPE_TRANSLATE_MODEL || 'claude-sonnet-4-5-20250929';
const USER_AGENT  =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

/** Escape the 3 chars that break Telegram HTML parse_mode. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

@Injectable()
export class RecipesStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(RecipesStrategy.name);
  readonly type = 'recipes';
  readonly supportedPlatforms: DestinationPlatform[] = ['telegram', 'instagram', 'facebook', 'threads'];

  constructor(
    private readonly claude:       ClaudeAgent,
    private readonly validator:    PostValidator,
    private readonly registry:     ContentStrategyRegistry,
    private readonly publisher:    TelegramPublisher,
    private readonly telegraph:    TelegraphService,
    private readonly repo:         RecipesRepository,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
    private readonly crossPost:    CrossPostService,
    private readonly dispatcher:   PublisherDispatcher,
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

  async execute(channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    const postedKey = dest?.postedKey ?? 'TELEGRAM';
    const row = await this.repo.getNext(postedKey);
    if (!row) { this.logger.debug('No unposted recipes'); return; }

    const uk = await this.resolveTranslation(row);
    if (!uk) return; // translation unavailable/failed (sentinel already handled)

    // Native Meta publish: same recipe pool, inline caption + dish photo, no
    // Telegraph / notifier / publications / cross-post (those are TG-only).
    if (dest && dest.platform !== 'telegram') {
      // DestinationResolver guarantees a token for meta platforms; guard anyway
      // so a misconfig logs an error instead of throwing on `token!`.
      if (!dest.token) {
        this.logger.error(`Meta publish skipped (${row.id}): token missing for ${dest.platform}`);
        return;
      }
      const nutri   = this.nutritionLine(row);
      const caption = this.buildCaption(uk.titleUk, row.category, uk.ingredientsUk, nutri);
      try {
        const id = await this.dispatcher.publish(
          dest.platform as MetaPlatform,
          { text: caption, imageUrl: row.image_url, source: '', tags: row.category ? [row.category] : [] },
          { id: dest.targetId, token: dest.token! },
        );
        await this.repo.markPosted(row.id, postedKey);
        this.logger.debug(`Published recipe ${row.id} to ${dest.platform} (${id})`);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`Meta publish failed (${row.id} → ${dest.platform}): ${msg}`);
        // Permanent media errors will never succeed for this image — mark it
        // done for this destination so the queue advances. Transient errors
        // stay unmarked and retry next tick.
        if (isPermanentMetaMediaError(msg)) {
          try { await this.repo.markPosted(row.id, postedKey); } catch { /* best-effort */ }
        }
        // Surface to the runner → scheduler records the run as an error.
        throw new Error(`Meta publish (${dest.platform}): ${msg}`);
      }
      return;
    }

    // Variant A: build a Telegraph page with the FULL recipe, then post the
    // photo with a short caption + link. The page always "fits" (Instant View),
    // so no overflow handling and no reply message. If Telegraph is
    // unavailable / fails, fall back to the inline caption + reply layout so a
    // post still goes out.
    const telegraphUrl = await this.ensureTelegraph(row, uk);
    const nutri        = this.nutritionLine(row);

    let caption: string;
    let replyText: string | undefined;
    if (telegraphUrl) {
      caption   = this.buildLinkCaption(uk.titleUk, row.category, telegraphUrl, nutri);
      replyText = undefined;
    } else {
      caption   = this.buildCaption(uk.titleUk, row.category, uk.ingredientsUk, nutri);
      replyText = this.buildReply(uk.instructionsUk) || undefined;
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = await this.downloadImage(row.image_url);
    } catch (err: any) {
      this.logger.warn(`Image download failed (${row.id}): ${err.message}`);
      return; // do not mark posted — retry next run (translation already cached)
    }

    try {
      const messageId = await this.publisher.publishPrompt(
        { imageBuffer, caption, replyText },
        { id: channelId },
      );
      await this.repo.markPosted(row.id, postedKey);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.image_url,
        title:        uk.titleUk.slice(0, 200),
        strategyType: this.type,
        tags:         row.category ? [row.category] : [],
      });
      // Cross-post a teaser (dish name + БЖВ + link to this TG post) to any
      // configured Meta targets. Never throws — Meta failures are isolated.
      // mirror (full caption + dish photo) enables Instagram targets (IG is
      // mirror-only and needs an image); teaser remains for FB/Threads.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text: caption, tags: row.category ? [row.category] : [], imageUrl: row.image_url },
        teaser: { lines: [uk.titleUk, this.nutritionLine(row)], imageUrl: row.image_url },
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
    ], {
      model: TRANSLATE_MODEL,
      // A full recipe (title + ingredients + instructions JSON) easily exceeds
      // the 1024 default; without headroom it truncates, the validator rejects
      // the broken JSON, and the row gets a permanent skip sentinel.
      maxTokens: Number(process.env.RECIPE_TRANSLATE_MAX_TOKENS) || 3000,
    });

    const fail = async (why: string) => {
      this.logger.warn(`Translation rejected (${row.id}): ${why} — writing skip sentinel`);
      await this.repo.saveTranslation(row.id, { titleUk: '', ingredientsUk: '', instructionsUk: '' });
      return null;
    };

    if (!raw || raw.trim() === 'SKIP_POST') return fail('empty or SKIP_POST');

    // Strip code fences BEFORE validating. The validator blacklists preamble
    // phrases ("here is a", …) meant for free-text posts; running it on the
    // raw response could wrongly sentinel a valid translation that Claude
    // wrapped in ```json … ```. We validate the stripped JSON text instead.
    const stripped = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    if (!this.validator.check(stripped, 'recipes')) return fail('validator rejected');

    let parsed: { title_uk?: string; ingredients_uk?: string; instructions_uk?: string };
    try {
      parsed = JSON.parse(stripped);
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

  /**
   * Return the Telegraph page URL for this recipe, creating + caching it on
   * first use. Returns null (→ inline fallback) when Telegraph is unconfigured
   * or page creation fails — never throws.
   */
  private async ensureTelegraph(
    row: RecipeRow,
    uk: { titleUk: string; ingredientsUk: string; instructionsUk: string },
  ): Promise<string | null> {
    if (row.telegraph_url) return row.telegraph_url;
    try {
      if (!(await this.telegraph.available())) return null;
      const nodes = buildRecipeNodes({
        title:          uk.titleUk,
        category:       row.category,
        ingredientsUk:  uk.ingredientsUk,
        instructionsUk: uk.instructionsUk,
        imageUrl:       row.image_url,
        nutrition: {
          kcal:         row.kcal,
          proteinG:     row.protein_g,
          fatG:         row.fat_g,
          carbsG:       row.carbs_g,
          servingSizeG: row.serving_size_g,
        },
      });
      const page = await this.telegraph.createPage({ title: uk.titleUk, nodes });
      await this.repo.saveTelegraph(row.id, page);
      return page.url;
    } catch (err: any) {
      this.logger.warn(`Telegraph page failed (${row.id}): ${err.message} — inline fallback`);
      return null;
    }
  }

  /** Compact per-serving macros line for captions. Empty when no data. */
  private nutritionLine(row: RecipeRow): string {
    const kcal = fmtNum(row.kcal, 0);
    const p = fmtNum(row.protein_g), f = fmtNum(row.fat_g), c = fmtNum(row.carbs_g);
    const parts: string[] = [];
    if (kcal) parts.push(`🔥 ${kcal} ккал`);
    if (p)    parts.push(`Б ${p}`);
    if (f)    parts.push(`Ж ${f}`);
    if (c)    parts.push(`В ${c}`);
    return parts.length ? `${parts.join(' · ')} (на порцію)` : '';
  }

  /** Short Variant-A caption: title + cuisine + macros + Instant-View link. */
  private buildLinkCaption(title: string, category: string | null, url: string, nutri: string): string {
    const parts = [`<b>${escapeHtml(title)}</b>`];
    if (category) parts.push(`🍽️ ${escapeHtml(category)}`);
    if (nutri)    parts.push(escapeHtml(nutri));
    parts.push(`📖 <a href="${escapeHtml(url)}">Повний рецепт</a>`);
    return parts.join('\n\n');
  }

  private buildCaption(title: string, category: string | null, ingredients: string, nutri: string): string {
    const header = `<b>${title}</b>`;
    const meta   = category ? `🍽️ ${category}` : '';
    const nut    = nutri || '';
    const ingHdr = '📝 Інгредієнти:';
    const fixed  = [header, meta, nut, `${ingHdr}\n`].filter(Boolean).join('\n\n');
    const budget = CAPTION_MAX - fixed.length;
    const lines  = this.fitLines(ingredients, budget);
    return [header, meta, nut, `${ingHdr}\n${lines}`].filter(Boolean).join('\n\n');
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
