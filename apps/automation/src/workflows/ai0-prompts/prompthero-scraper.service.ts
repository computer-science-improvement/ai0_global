import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

export interface PromptMeta {
  prompt:       string;
  modelName:    string;
  modelVersion: string;
  category:     string;
  params:       Array<{ label: string; emoji: string; value: string }>;
}

export interface PromptMessage {
  caption:   string;
  replyText: string | null; // null = caption mode, string = send as reply
  isError:   boolean;       // true = prompt too long, skip
}

// SVG path prefixes → parameter labels
const PARAM_BY_PATH: Array<{ prefix: string; label: string; emoji: string }> = [
  { prefix: 'M15 2H6',    label: 'Media Type', emoji: '🖼️' },
  { prefix: 'M19.5 7',    label: 'Size',        emoji: '📐' },
  { prefix: 'M4 16v',     label: 'Steps',       emoji: '👣' },
  { prefix: 'M10 8h4',    label: 'Sampler',     emoji: '🎛️' },
  { prefix: 'M14 9.536',  label: 'Seed',        emoji: '🌱' },
];

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveParam(pathD: string): { label: string; emoji: string } | null {
  for (const entry of PARAM_BY_PATH) {
    if (pathD.startsWith(entry.prefix)) {
      return { label: entry.label, emoji: entry.emoji };
    }
  }
  return null;
}

@Injectable()
export class PromptHeroScraperService {
  private readonly logger = new Logger(PromptHeroScraperService.name);

  /** Extract prompt metadata from a prompthero HTML page */
  extractMeta(html: string): PromptMeta | null {
    try {
      const $ = cheerio.load(html);
      const container = $('[data-slot="separator"] + div');

      if (!container.length) {
        this.logger.warn('Could not find separator container in page');
        return null;
      }

      // Prompt: all .font-semibold links joined together
      const promptTexts = container
        .find('.font-semibold a')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      const prompt = promptTexts.join('');

      // Model name & variant
      const rawModel   = container.find('> div:first-child a .truncate').first().text().trim();
      const rawVariant = container.find('> div:first-child a .truncate > span').first().text().trim();

      let modelName    = rawModel;
      let modelVersion = rawVariant;

      if (rawVariant && rawModel.toLowerCase().includes(rawVariant.toLowerCase())) {
        modelName = rawModel.replace(new RegExp(rawVariant, 'ig'), '').trim();
      }
      modelName    = modelName.replace(/\s*[\[\(]?\s*v?\s*\d+(\.\d+)*\s*[\]\)]?\s*$/i, '').trim();
      modelVersion = modelVersion.replace(/^v/i, '').trim();

      // Category
      const category = container.find('> div:last-child a .truncate').first().text().trim();

      // Generation parameters
      const params: PromptMeta['params'] = [];
      $('h2:contains("Generation parameters") + div')
        .find('span[data-slot="tooltip-trigger"]')
        .each((i, el) => {
          const value = $(el).text().trim();
          const pathD = $(el).find('path:first-child').attr('d') ?? '';
          const meta  = resolveParam(pathD);
          if (meta) {
            params.push({ ...meta, value });
          } else {
            params.push({ emoji: '⚙️', label: `Param_${i + 1}`, value });
          }
        });

      return { prompt, modelName, modelVersion, category, params };
    } catch (err) {
      this.logger.warn(`Scrape failed: ${err.message}`);
      return null;
    }
  }

  /** Build Telegram message caption from extracted metadata */
  buildMessage(meta: PromptMeta): PromptMessage {
    const sampler = meta.params.find((p) => p.label === 'Sampler')?.value ?? '';
    const size    = meta.params.find((p) => p.label === 'Size')?.value ?? '';
    const seed    = meta.params.find((p) => p.label === 'Seed')?.value ?? '';

    const model = `${meta.modelName}${meta.modelVersion ? ` ${meta.modelVersion}` : ''}`;

    const lines: string[] = [];
    lines.push('💬 Prompt:');
    lines.push('');
    lines.push(`<code>${escapeHtml(meta.prompt)}</code>`);
    lines.push('');
    if (model)   lines.push(`🤖 <i>${escapeHtml(model)}</i>`);
    if (size)    lines.push(`📐 <code>${escapeHtml(size)}</code>`);
    if (sampler) lines.push(`🎛️ <code>${escapeHtml(sampler)}</code>`);
    if (seed)    lines.push(`🌱 <code>${escapeHtml(seed)}</code>`);
    lines.push('');
    if (meta.category) {
      lines.push(`#${meta.category.trim().replace(/[\s\-\.]+/g, '_').toLowerCase()}`);
    }

    const caption = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    if (caption.length > 1024) {
      return { caption: '', replyText: null, isError: true };
    }

    return { caption, replyText: null, isError: false };
  }
}
