import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgent }    from './agents/claude.agent';
import { PostValidator }  from './validators/post.validator';
import { FORMAT_PROMPTS, UA_NEWS_SYSTEM_PROMPT } from './prompts/format.prompts';
import { Platform }       from '../types';

@Injectable()
export class FormatterService {
  private readonly logger = new Logger(FormatterService.name);

  constructor(
    private readonly claude:     ClaudeAgent,
    private readonly validator:  PostValidator,
  ) {}

  /**
   * Format raw article content as a platform post.
   * Returns:
   *   string      — valid formatted post
   *   'SKIP_POST' — model signalled content is not formattable (do not retry)
   *   null        — technical failure: API error, billing, agent inactive (retry later)
   */
  /**
   * Format a news item using the ua-news (n8n-origin) system prompt.
   * Passes structured TITLE / CONTENT / LINK to the model.
   */
  async formatNewsItem(title: string, content: string, link: string): Promise<string | null> {
    if (!this.claude.available) {
      this.logger.warn('Claude agent not available — skipping formatting');
      return null;
    }

    this.logger.debug(`Content length: ${content.length} chars`);

    const userMessage = `TITLE:\n${title}\n\nCONTENT:\n${content}\n\nLINK:\n${link}`;

    const text = await this.claude.chat([
      { role: 'system', content: UA_NEWS_SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ]);

    if (text?.trim() === 'SKIP_POST') {
      this.logger.warn('Model signalled SKIP_POST [ua-news]');
      return 'SKIP_POST';
    }

    if (!this.validator.check(text, 'ua-news / formatNewsItem')) {
      return null;
    }

    return text;
  }

  async formatRaw(content: string, platform: Platform): Promise<string | null> {
    if (!this.claude.available) {
      this.logger.warn('Claude agent not available — skipping formatting');
      return null;
    }

    const prompt = FORMAT_PROMPTS[platform] ?? FORMAT_PROMPTS.telegram;
    this.logger.debug(`Skills applied: [${prompt.appliedSkills.join(', ')}]`);
    this.logger.debug(`Content length: ${content.length} chars`);

    const text = await this.claude.chat([
      { role: 'system', content: prompt.system },
      { role: 'user',   content: `Content source: ${content}` },
    ]);

    // Model explicitly signalled unformattable content — propagate as sentinel
    if (text?.trim() === 'SKIP_POST') {
      this.logger.warn(`Model signalled SKIP_POST [${platform}]`);
      return 'SKIP_POST';
    }

    if (!this.validator.check(text, `${platform} / formatRaw`)) {
      return null;
    }

    return text;
  }
}
