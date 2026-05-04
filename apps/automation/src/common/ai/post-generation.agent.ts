import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ClaudeAgent } from './agents/claude.agent';
import { cleanFinalText } from './post-generation.helpers';

export type PostMode = 'news' | 'simple';

export interface GenerateInput {
  /** Pipeline variant — news mode triggers HTTP fetch fallback for thin content. */
  mode:             PostMode;
  /** Skill name to apply, e.g. 'channel-ai0-news'. Must match a folder in apps/automation/.claude/skills/. */
  channelSkill:     string;
  /** Strategy-specific raw data: { title, content, source, tags? }. */
  rawData:          Record<string, unknown>;
  /** Force HTTP fetch fallback even if content looks long enough. */
  needsEnrichment?: boolean;
}

export interface GeneratedPost {
  /** Finished post text (no tag line, no source link). */
  text: string;
  /** Single tag word (RSS-provided in production), without '#'. Empty string if absent. */
  tag:  string;
}

/**
 * PostGenerationAgent — single API call per post.
 *
 * Flow:
 *   1. Optionally HTTP-fetch the source URL if rawData.content is thin.
 *   2. Compose a per-channel system prompt from .claude/skills/*.md.
 *   3. One ClaudeAgent.chat() call. Output is the post body.
 *   4. cleanFinalText defensive cleanup + length guard.
 *   5. Tag from rawData.tags[0] (RSS-provided in production).
 *
 * No subagents. No tool calls. No chain. Quality is enforced by the system prompt.
 */
@Injectable()
export class PostGenerationAgent implements OnModuleInit {
  private readonly logger = new Logger(PostGenerationAgent.name);

  /** Resolves to apps/automation/ at runtime — the folder containing .claude/. */
  private cwd!: string;

  /** Skip if even after URL fetch we have less than this many chars. */
  private readonly MIN_CONTENT_CHARS = 400;

  constructor(
    private readonly config: ConfigService,
    private readonly claude: ClaudeAgent,
  ) {}

  onModuleInit() {
    this.cwd = join(__dirname, '..', '..', '..');
  }

  async generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null> {
    const start = Date.now();
    const raw = input.rawData as { title?: string; content?: string; source?: string; tags?: string[] };

    // Step 0: ensure we have content; HTTP fetch fallback for thin RSS items.
    let content = raw.content ?? '';
    if (input.needsEnrichment || content.length < this.MIN_CONTENT_CHARS) {
      const fetched = raw.source ? await this.maybeFetchUrl(raw.source) : null;
      if (fetched && fetched.length > content.length) content = fetched;
    }
    if (content.length < this.MIN_CONTENT_CHARS) {
      this.logger.warn(`[generate] content too thin (${content.length} chars) — skipping`);
      return null;
    }

    // Step 1: single API call.
    const system = await this.buildSystemPrompt(input.channelSkill);
    const user   = this.buildUserMessage({ ...raw, content });

    const result = await this.claude.chat(
      [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      {
        model:     this.config.get<string>('POST_GEN_MODEL') ?? 'claude-sonnet-4-6',
        maxTokens: 1500,
      },
    );

    if (!result) {
      this.logger.warn(`[generate] Claude returned null`);
      return null;
    }

    if (result.trim() === 'SKIP_POST') {
      this.logger.debug(`[generate] SKIP_POST signal`);
      return 'SKIP_POST';
    }

    // Step 2: defensive cleanup + length guard.
    const cleaned = cleanFinalText(result);
    if (cleaned.replace(/<[^>]+>/g, '').trim().length < 80) {
      this.logger.warn(`[generate] post too short after clean (${cleaned.length} chars) — treating as failure`);
      return null;
    }

    // Step 3: tag from RSS.
    const tag = raw.tags?.[0] ?? '';

    this.logger.debug(`[generate] success ${cleaned.length} chars in ${Date.now() - start}ms`);
    return { text: cleaned, tag };
  }

  /**
   * Composes a per-channel system prompt by reading and concatenating four
   * .claude/skills/<name>/SKILL.md files. Strips YAML frontmatter from each.
   */
  private async buildSystemPrompt(channelSkill: string): Promise<string> {
    const [channelMd, voiceMd, antiSlopMd, grammarMd] = await Promise.all([
      this.readSkill(channelSkill),
      this.readSkill('human-voice'),
      this.readSkill('anti-slop'),
      this.readSkill('grammar-ua'),
    ]);

    return [
      `# ROLE`,
      `You write a single Ukrainian-language Telegram post body. Output ONLY the post text — no preamble, no JSON, no markdown headers, no review notes, no "Фінальний текст" markers, nothing else.`,
      ``,
      `# CHANNEL RULES`,
      channelMd,
      ``,
      `# HUMAN VOICE`,
      voiceMd,
      ``,
      `# ANTI-SLOP`,
      antiSlopMd,
      ``,
      `# GRAMMAR & ORTHOGRAPHY (Ukrainian)`,
      grammarMd,
      ``,
      `# OUTPUT FORMAT`,
      `- Telegram HTML only: <b>, <i>, <a href="...">, <code>, <u>.`,
      `- Max 850 characters total (Telegram caption limit minus our hashtag/source line). Birthday-story channel: 600–1100.`,
      `- No source links in the body — NestJS appends one separately.`,
      `- No hashtags in the body — NestJS appends one separately.`,
      `- No markdown bold (**), no markdown headers (##/###), no horizontal rules (---).`,
      ``,
      `# SKIP SIGNAL`,
      `If the source is unusable (paywall stub, broken HTML, obvious spam, empty content), output the literal three-letter string SKIP_POST and nothing else.`,
    ].join('\n');
  }

  private async readSkill(name: string): Promise<string> {
    const path = join(this.cwd, '.claude', 'skills', name, 'SKILL.md');
    try {
      const raw = await readFile(path, 'utf8');
      return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    } catch (err: any) {
      this.logger.warn(`[readSkill] failed to read ${path}: ${err.message}`);
      return '';
    }
  }

  private buildUserMessage(raw: { title?: string; content?: string; source?: string; tags?: string[] }): string {
    return [
      raw.source ? `Source URL: ${raw.source}` : '',
      raw.tags?.length ? `Source tags: ${raw.tags.join(', ')}` : '',
      raw.title ? `Original title: ${raw.title}` : '',
      ``,
      `Content:`,
      raw.content ?? '',
    ].filter((s) => s !== '').join('\n');
  }

  /**
   * Plain HTTP fallback for thin RSS content — fetches the source URL and
   * extracts <article>/<main>/<body> text. No AI involved.
   */
  private async maybeFetchUrl(url: string): Promise<string | null> {
    if (!url) return null;
    try {
      const res = await axios.get<string>(url, {
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai0-global/1.0)' },
        responseType: 'text',
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const $ = cheerio.load(res.data);
      const text = ($('article').text() || $('main').text() || $('body').text()).replace(/\s+/g, ' ').trim();
      return text.length > 200 ? text.slice(0, 8000) : null;
    } catch (err: any) {
      this.logger.debug(`[maybeFetchUrl] ${url}: ${err.message}`);
      return null;
    }
  }

  /**
   * Tag-generation utility. Not called from generate() in production
   * because RSS items always carry tags. Provided for one-off use.
   */
  async maybeGenerateTag(post: string, channelSkill: string): Promise<string> {
    const skillContent = await this.readSkill(channelSkill);
    const sectionMatch = skillContent.match(/Allowed tag(?:\s+vocabulary)?:?\s*\n([\s\S]+?)(?:\n\n|\n#|\n##|\n\*\*|$)/i);
    const allowed = sectionMatch?.[1]?.trim() ?? '';

    const result = await this.claude.chat(
      [
        {
          role:    'system',
          content: `Pick exactly ONE topical tag for this Ukrainian Telegram post. Output a single lowercase Latin word, no '#', no quotes, no punctuation.${allowed ? `\n\nAllowed list:\n${allowed}` : ''} If nothing fits or post is empty, output: none`,
        },
        { role: 'user', content: post },
      ],
      { model: 'claude-haiku-4-5-20251001', maxTokens: 16 },
    );

    if (!result) return '';
    const word = result.toLowerCase().trim().replace(/^[`'"#\s]+|[`'"\s]+$/g, '').match(/[a-z0-9_]+/)?.[0] ?? '';
    if (!word || word === 'none' || word.length > 24) return '';
    return word;
  }
}
