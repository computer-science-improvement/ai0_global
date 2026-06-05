// apps/automation/src/publishers/telegraph.service.ts
//
// Creates Telegraph (telegra.ph) pages so long content (e.g. full recipes)
// always "fits" — the channel post carries only a short caption + the page
// URL, which Telegram renders with Instant View.
//
// Session management mirrors bots: the active `telegraph_accounts` row names
// an env var (`token_env`) holding the real access token. The secret never
// lives in the DB.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TelegraphAccountsRepository } from '../config/telegraph-accounts.repository';

/** Telegraph DOM node — a string (text) or an element. */
export type TelegraphNode =
  | string
  | { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] };

export interface TelegraphPage {
  url:  string;
  path: string;
}

export interface NutritionInput {
  kcal:         number | string | null;
  proteinG:     number | string | null;
  fatG:         number | string | null;
  carbsG:       number | string | null;
  servingSizeG: number | string | null;
}

export interface RecipeArticleInput {
  title:           string;
  category:        string | null;
  ingredientsUk:   string;
  instructionsUk:  string;
  imageUrl:        string | null;
  nutrition?:      NutritionInput | null;
}

/** Round a numeric-ish value for display; null when absent / non-numeric. */
export function fmtNum(v: number | string | null | undefined, decimals = 1): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = decimals <= 0 ? Math.round(n) : Math.round(n * 10 ** decimals) / 10 ** decimals;
  return String(r);
}

/** Returns true when at least one macro / kcal value is present. */
export function hasNutrition(n: NutritionInput | null | undefined): boolean {
  if (!n) return false;
  return [n.kcal, n.proteinG, n.fatG, n.carbsG].some(v => fmtNum(v) !== null);
}

const TITLE_MAX = 256; // Telegraph hard limit on page title.

/**
 * Split a free-text block (Claude returns ingredients / instructions as
 * newline-separated text) into clean list items. Drops blank lines and any
 * leading ordinal / bullet markers — Telegraph's <ol>/<ul> render their own.
 */
export function splitListItems(block: string | null | undefined, opts?: { stripOrdinal?: boolean }): string[] {
  if (!block) return [];
  return block
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      // Bullets: "• ", "- ", "* "
      let s = l.replace(/^[•\-*]\s+/, '');
      if (opts?.stripOrdinal) {
        // Ordinals: "1. ", "1) ", "1 - "
        s = s.replace(/^\d+\s*[.)\-]\s*/, '');
      }
      return s.trim();
    })
    .filter(Boolean);
}

/**
 * Build the Telegraph content array for a recipe. Pure — no I/O — so it's
 * unit-testable. Image is best-effort (external URL); the recipe text is the
 * payload that must always be present.
 */
export function buildRecipeNodes(input: RecipeArticleInput): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];

  if (input.imageUrl) {
    nodes.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: input.imageUrl } }] });
  }
  if (input.category) {
    nodes.push({ tag: 'p', children: [{ tag: 'b', children: [`🍽️ ${input.category}`] }] });
  }

  if (hasNutrition(input.nutrition)) {
    const n = input.nutrition!;
    const serving = fmtNum(n.servingSizeG, 0);
    nodes.push({ tag: 'h3', children: [serving ? `Харчова цінність (на порцію ~${serving} г)` : 'Харчова цінність (на порцію)'] });
    const items: TelegraphNode[] = [];
    const kcal = fmtNum(n.kcal, 0);
    const p = fmtNum(n.proteinG), f = fmtNum(n.fatG), c = fmtNum(n.carbsG);
    if (kcal) items.push({ tag: 'li', children: [`🔥 Калорійність: ${kcal} ккал`] });
    if (p)    items.push({ tag: 'li', children: [`🥩 Білки: ${p} г`] });
    if (f)    items.push({ tag: 'li', children: [`🧈 Жири: ${f} г`] });
    if (c)    items.push({ tag: 'li', children: [`🍞 Вуглеводи: ${c} г`] });
    nodes.push({ tag: 'ul', children: items });
  }

  const ingredients = splitListItems(input.ingredientsUk);
  if (ingredients.length) {
    nodes.push({ tag: 'h3', children: ['Інгредієнти'] });
    nodes.push({ tag: 'ul', children: ingredients.map(i => ({ tag: 'li', children: [i] })) });
  }

  const steps = splitListItems(input.instructionsUk, { stripOrdinal: true });
  if (steps.length) {
    nodes.push({ tag: 'h3', children: ['Приготування'] });
    nodes.push({ tag: 'ol', children: steps.map(s => ({ tag: 'li', children: [s] })) });
  }

  return nodes;
}

@Injectable()
export class TelegraphService {
  private readonly logger = new Logger(TelegraphService.name);
  private static readonly BASE = 'https://api.telegra.ph';

  constructor(
    private readonly env:      ConfigService,
    private readonly accounts: TelegraphAccountsRepository,
  ) {}

  /** Resolve the active account's access token (env-var indirection). */
  private async resolveToken(): Promise<{ token: string; authorName: string | null; authorUrl: string | null } | null> {
    const acc = await this.accounts.findActive();
    if (!acc) { this.logger.warn('No active Telegraph account configured'); return null; }
    const token = this.env.get<string>(acc.token_env);
    if (!token) { this.logger.warn(`Telegraph token env "${acc.token_env}" not set`); return null; }
    return { token, authorName: acc.author_name, authorUrl: acc.author_url };
  }

  /** True when an active account with a populated token env var exists. */
  async available(): Promise<boolean> {
    return (await this.resolveToken()) !== null;
  }

  /**
   * Create a Telegraph page. Returns { url, path } or throws. Caller is
   * responsible for caching the URL so the page is only created once.
   */
  async createPage(args: { title: string; nodes: TelegraphNode[] }): Promise<TelegraphPage> {
    const resolved = await this.resolveToken();
    if (!resolved) throw new Error('No active Telegraph account / token');

    const title = (args.title || 'Recipe').slice(0, TITLE_MAX);
    const params = new URLSearchParams();
    params.set('access_token', resolved.token);
    params.set('title', title);
    if (resolved.authorName) params.set('author_name', resolved.authorName);
    if (resolved.authorUrl)  params.set('author_url', resolved.authorUrl);
    params.set('content', JSON.stringify(args.nodes));
    params.set('return_content', 'false');

    const res = await axios.post(`${TelegraphService.BASE}/createPage`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    });
    const body = res.data;
    if (!body?.ok || !body.result?.url) {
      throw new Error(`Telegraph createPage rejected: ${body?.error ?? 'unknown'}`);
    }
    return { url: body.result.url, path: body.result.path };
  }
}
