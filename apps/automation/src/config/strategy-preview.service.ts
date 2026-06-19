// apps/automation/src/config/strategy-preview.service.ts
//
// Returns "what would this strategy publish if it ran right now" — a small
// JSON sample of the content source feeding the binding. The intent is to
// give the operator a quick eyeball: is the data alive, is it sensibly
// shaped, is the next pick what I'd expect?
//
// Three preview kinds:
//   • db-row       — sampled row(s) from a content table (quotes/facts/etc).
//   • dedup-recent — last N items the dedup layer marked posted (for
//                    feed-driven strategies, this is "the recent past").
//   • live-fetch   — strategy fetches at runtime from an external API; no
//                    cached row exists in our DB.
//   • unsupported  — strategy type unknown.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { StrategyBindingsRepository, StrategyBindingRow } from './strategy-bindings.repository';
import { DestinationResolver } from '../common/content-strategy/destination-resolver.service';
import {
  buildRecipeCaptionParts, renderParts, type CaptionPart, type MetaCaptionOverrides,
} from '../strategies/recipe-carousel/recipe-caption-parts';
import type { RecipeRow } from '../strategies/recipes/recipes.repository';
import type { DestinationPlatform } from '../common/content-strategy/publish-destination';

export interface RecipePostPreview {
  parts:    CaptionPart[];
  rendered: Record<'facebook' | 'instagram' | 'threads' | 'telegram', string>;
}

export interface PreviewItem {
  title?:       string;
  text?:        string;
  imageUrl?:    string;
  imageAlt?:    string;
  source?:      string;
  url?:         string;
  publishedAt?: string;
}

export interface StrategyPreview {
  kind:     'db-row' | 'dedup-recent' | 'live-fetch' | 'unsupported';
  message?: string;
  items:    PreviewItem[];
}

@Injectable()
export class StrategyPreviewService {
  private readonly logger = new Logger(StrategyPreviewService.name);

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly bindings: StrategyBindingsRepository,
    private readonly destinations: DestinationResolver,
  ) {}

  /**
   * Caption "parts" + per-platform rendered captions for a recipe-carousel
   * binding — the source of the Post-Preview editor. Uses the latest translated
   * recipe as the sample, the binding's `params.metaCaption` overrides, and the
   * group's resolved Telegram link. Returns null for a non-recipe binding.
   */
  async recipePostPreview(bindingId: string): Promise<RecipePostPreview | null> {
    const binding = await this.bindings.findById(bindingId);
    if (!binding || binding.type !== 'recipe-carousel') return null;

    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT title_uk, category, kcal, protein_g, fat_g, carbs_g FROM recipes
        WHERE title_uk IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    );
    const row = (rows[0] ?? { title_uk: 'Назва рецепта', category: 'категорія' }) as RecipeRow;

    // Resolve the group's Telegram link the same way publishing does (meta
    // bindings only; null otherwise — the preview just omits the link part).
    let telegramLink: string | null = null;
    if (binding.meta_account_id) {
      telegramLink = await this.destinations.resolveGroupTelegramLink({
        platform: binding.platform as DestinationPlatform, targetId: '',
        metaAccountId: binding.meta_account_id, postedKey: '', throttleKey: '',
      }).catch(() => null);
    }

    const overrides = (binding.params?.metaCaption ?? undefined) as MetaCaptionOverrides | undefined;
    const parts = buildRecipeCaptionParts(row, { overrides, telegramLink });
    return {
      parts,
      rendered: {
        facebook:  renderParts(parts, 'facebook'),
        instagram: renderParts(parts, 'instagram'),
        threads:   renderParts(parts, 'threads'),
        telegram:  renderParts(parts, 'telegram'),
      },
    };
  }

  async previewById(strategyId: string): Promise<StrategyPreview | null> {
    const binding = await this.bindings.findById(strategyId);
    if (!binding) return null;
    return this.previewFor(binding);
  }

  async previewFor(binding: StrategyBindingRow): Promise<StrategyPreview> {
    try {
      switch (binding.type) {
        case 'quotes':            return await this.fromQuotes();
        case 'facts':             return await this.fromFacts();
        case 'birthday-strategy': return await this.fromBirthdays();
        case 'on-this-day':       return await this.fromOnThisDay();
        case 'ai0-prompts':       return await this.fromPrompts();
        case 'assets':            return await this.fromAssets(binding.params);
        case 'pdr-quiz':          return await this.fromPdrQuestions();
        case 'recipes':           return await this.fromRecipes();

        // Feed-driven strategies — show the recent dedup history for the
        // primary channel (in tracked_channels terms — but posted_news uses
        // channel_key strings, not UUIDs, so we resolve via the binding's
        // params or by looking the channel up).
        case 'ua-news':
        case 'ai0-news':
        case 'game-channel':
        case 'movies':
        case 'space-news':
          if (!binding.channel_id) return { kind: 'unsupported', items: [], message: 'No channel_id on this binding.' };
          return await this.fromPostedNews(binding.channel_id);

        // Pure API fetches with no persistent table.
        case 'daily-photo':
          return {
            kind: 'live-fetch', items: [],
            message: 'NASA APOD fetched at runtime — no preview cached. Today\'s entry is whatever apod.nasa.gov serves at fire time.',
          };

        default:
          return {
            kind: 'unsupported', items: [],
            message: `No preview implementation for type "${binding.type}".`,
          };
      }
    } catch (err: any) {
      this.logger.warn(`preview for ${binding.ext_id} failed: ${err.message}`);
      return {
        kind: 'unsupported', items: [],
        message: `Preview unavailable: ${err.message}`,
      };
    }
  }

  // ── Per-table queries ───────────────────────────────────────────────────

  private async fromQuotes(): Promise<StrategyPreview> {
    const { rows } = await this.pool.query<{
      text: string; author: string | null; category: string | null; url: string | null;
    }>(
      `SELECT text, author, category, url FROM quotes ORDER BY created_at DESC LIMIT 3`,
    );
    return {
      kind:  'db-row',
      items: rows.map(r => ({
        title:  r.author ?? 'Unknown',
        text:   r.text,
        source: r.category ?? undefined,
        url:    r.url ?? undefined,
      })),
      message: rows.length === 0 ? 'No quotes in DB yet.' : undefined,
    };
  }

  private async fromFacts(): Promise<StrategyPreview> {
    const { rows } = await this.pool.query<{
      article_title: string; article_url: string | null;
      image_url:     string | null; content: string; category: string | null;
    }>(
      `SELECT article_title, article_url, image_url, content, category
       FROM facts ORDER BY created_at DESC LIMIT 3`,
    );
    return {
      kind:  'db-row',
      items: rows.map(r => ({
        title:    r.article_title,
        text:     r.content,
        imageUrl: r.image_url ?? undefined,
        source:   r.category ?? undefined,
        url:      r.article_url ?? undefined,
      })),
      message: rows.length === 0 ? 'No facts in DB yet — run the loader.' : undefined,
    };
  }

  private async fromBirthdays(): Promise<StrategyPreview> {
    // Today's birthdays first; fall back to most recent rows.
    const { rows } = await this.pool.query<{
      name: string; month: number; day: number; year: number | null;
    }>(
      `SELECT name, month, day, year FROM birthdays
       WHERE month = EXTRACT(MONTH FROM now())::int
         AND day   = EXTRACT(DAY   FROM now())::int
       ORDER BY year NULLS LAST
       LIMIT 5`,
    );
    if (rows.length > 0) {
      return {
        kind:  'db-row',
        items: rows.map(r => ({
          title:  r.name,
          source: r.year ? `b. ${r.year}` : `${r.day}.${String(r.month).padStart(2, '0')}`,
        })),
        message: `Today's birthdays (${rows.length}).`,
      };
    }
    const { rows: fallback } = await this.pool.query<{ name: string; month: number; day: number; year: number | null }>(
      `SELECT name, month, day, year FROM birthdays ORDER BY created_at DESC LIMIT 3`,
    );
    return {
      kind:  'db-row',
      items: fallback.map(r => ({
        title:  r.name,
        source: `${r.day}.${String(r.month).padStart(2, '0')}${r.year ? ` · ${r.year}` : ''}`,
      })),
      message: fallback.length === 0
        ? 'No birthdays loaded yet.'
        : 'No birthdays for today — showing recent loaded entries.',
    };
  }

  private async fromOnThisDay(): Promise<StrategyPreview> {
    const { rows } = await this.pool.query<{ day: number; month: number; year: number | null; title: string | null; description: string | null }>(
      `SELECT day, month, year, title, description FROM on_this_day
       WHERE day = EXTRACT(DAY FROM now())::int
         AND month = EXTRACT(MONTH FROM now())::int
       ORDER BY year NULLS LAST
       LIMIT 5`,
    );
    if (rows.length === 0) {
      return {
        kind: 'live-fetch', items: [],
        message: 'on-this-day uses Byabbe API at runtime; nothing cached for today.',
      };
    }
    return {
      kind: 'db-row',
      items: rows.map(r => ({
        title:  r.title ?? `${r.day}.${String(r.month).padStart(2, '0')}`,
        text:   r.description ?? undefined,
        source: r.year ? String(r.year) : undefined,
      })),
    };
  }

  private async fromPrompts(): Promise<StrategyPreview> {
    const { rows } = await this.pool.query<{
      id: string; prompt_source: string; category: string | null; page_url: string | null;
    }>(
      `SELECT id, prompt_source, category, page_url FROM prompts
       WHERE status = 'ok' OR status IS NULL
       ORDER BY scraped_at DESC NULLS LAST LIMIT 3`,
    );
    return {
      kind:  'db-row',
      items: rows.map(r => ({
        title:  r.id,
        text:   r.prompt_source.slice(0, 240),
        source: r.category ?? undefined,
        url:    r.page_url ?? undefined,
      })),
      message: rows.length === 0 ? 'No prompts in DB.' : undefined,
    };
  }

  private async fromAssets(params: Record<string, unknown>): Promise<StrategyPreview> {
    const dataSource = typeof params.dataSource === 'string' ? params.dataSource : null;
    const { rows } = dataSource
      ? await this.pool.query<{
          title: string; description: string; link: string | null; category: string | null;
        }>(
          `SELECT title, description, link, category FROM assets
           WHERE data_source = $1
           ORDER BY created_at DESC LIMIT 3`,
          [dataSource],
        )
      : await this.pool.query<{
          title: string; description: string; link: string | null; category: string | null;
        }>(
          `SELECT title, description, link, category FROM assets
           ORDER BY created_at DESC LIMIT 3`,
        );
    return {
      kind:  'db-row',
      items: rows.map(r => ({
        title:  r.title,
        text:   r.description?.slice(0, 240),
        source: r.category ?? dataSource ?? undefined,
        url:    r.link ?? undefined,
      })),
      message: rows.length === 0
        ? `No assets in DB for data_source="${dataSource ?? '*'}".`
        : (dataSource ? `data_source = ${dataSource}` : undefined),
    };
  }

  private async fromPdrQuestions(): Promise<StrategyPreview> {
    const { rows } = await this.pool.query<{
      question_id: number; ticket_number: number; text: string; image_url: string | null;
    }>(
      `SELECT question_id, ticket_number, text, image_url FROM pdr_questions
       ORDER BY ticket_number, question_num LIMIT 3`,
    );
    return {
      kind:  'db-row',
      items: rows.map(r => ({
        title:    `Ticket ${r.ticket_number} · Q${r.question_id}`,
        text:     r.text,
        imageUrl: r.image_url ?? undefined,
      })),
      message: rows.length === 0 ? 'No PDR questions loaded.' : undefined,
    };
  }

  private async fromRecipes(): Promise<StrategyPreview> {
    const { rows } = await this.pool.query<{
      title: string; url: string | null; image_url: string | null; category: string | null;
    }>(
      `SELECT title, url, image_url, category FROM recipes
       ORDER BY created_at DESC LIMIT 3`,
    );
    return {
      kind:  'db-row',
      items: rows.map(r => ({
        title:    r.title,
        imageUrl: r.image_url ?? undefined,
        source:   r.category ?? undefined,
        url:      r.url ?? undefined,
      })),
      message: rows.length === 0 ? 'No recipes cached — runs MealDB live.' : undefined,
    };
  }

  private async fromPostedNews(channelId: string): Promise<StrategyPreview> {
    // posted_news.channel_id is a free-form text key (channel_key like
    // "@motivation_local" or a numeric -100… id) — NOT the tracked_channels
    // UUID. We need to resolve via tracked_channels first.
    const { rows: chRows } = await this.pool.query<{ channel_key: string | null; tg_chat_id: string | null }>(
      `SELECT channel_key, tg_chat_id::text AS tg_chat_id
       FROM tracked_channels WHERE id = $1`,
      [channelId],
    );
    const ch = chRows[0];
    if (!ch) return { kind: 'unsupported', items: [], message: 'Channel not found.' };

    const keys = [ch.channel_key, ch.tg_chat_id].filter((k): k is string => !!k);
    if (keys.length === 0) {
      return { kind: 'dedup-recent', items: [], message: 'Channel has no resolved key.' };
    }

    const { rows } = await this.pool.query<{
      title: string | null; source_url: string; content_type: string | null; created_at: Date;
    }>(
      `SELECT title, source_url, content_type, created_at
       FROM posted_news
       WHERE channel_id = ANY($1::text[])
       ORDER BY created_at DESC LIMIT 5`,
      [keys],
    );
    return {
      kind:  'dedup-recent',
      items: rows.map(r => ({
        title:       r.title ?? r.source_url,
        url:         r.source_url,
        source:      r.content_type ?? undefined,
        publishedAt: r.created_at.toISOString(),
      })),
      message: rows.length === 0
        ? 'No items published yet on this channel.'
        : 'Last 5 items the dedup layer marked posted on this channel.',
    };
  }
}
