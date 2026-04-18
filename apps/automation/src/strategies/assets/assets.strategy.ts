import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ClaudeAgent }             from '../../common/ai/agents/claude.agent';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { AssetsRepository }        from './assets.repository';
import {
  ACADEMY_SYSTEM_PROMPT,
  MCPSERVERS_SYSTEM_PROMPT,
  PROMPTS_MD_SYSTEM_PROMPT,
  buildAcademyUserMessage,
  buildMcpUserMessage,
  buildPromptsUserMessage,
  buildAcademyMessage,
  buildMcpMessage,
  buildPromptsMessage,
} from '../../common/ai/prompts/assets.prompts';

// ─── Params shape ─────────────────────────────────────────────────────────────

interface AssetsParams {
  /** data_source value in the assets table */
  dataSource: 'academy-openai' | 'mcpservers' | 'prompts-md';
  /** Static poster image URL */
  posterUrl: string;
  /** Hashtag to append to the post */
  tag: string;
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

@Injectable()
export class AssetsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(AssetsStrategy.name);

  readonly type = 'assets';

  constructor(
    private readonly registry:  ContentStrategyRegistry,
    private readonly claude:    ClaudeAgent,
    private readonly telegram:  TelegramPublisher,
    private readonly notifier:  TelegramNotifier,
    private readonly db:        AssetsRepository,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [];
  }

  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    return null;
  }

  async generate(
    _data: StrategyFetchResult,
    _params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null> {
    return null;
  }

  // ─── Main pipeline ──────────────────────────────────────────────────────────

  async execute(channelId: string, params: StrategyParams): Promise<void> {
    const { dataSource, posterUrl, tag } = params as unknown as AssetsParams;

    if (!dataSource) {
      this.logger.warn('Missing required param: dataSource');
      return;
    }

    // 1. Fetch next unposted asset
    const row = await this.db.getNext(dataSource, channelId);
    if (!row) {
      this.logger.debug(`No unposted assets for dataSource="${dataSource}"`);
      return;
    }

    this.logger.debug(`Processing asset: ${row.title} (${dataSource})`);

    // 2. Generate AI text
    const aiText = await this.generateText(dataSource, row);
    if (!aiText) {
      this.logger.warn(`AI generation returned null for asset id=${row.id}`);
      return;
    }

    // 3. Build Telegram message
    const text = this.buildMessage(dataSource, aiText, row, tag);
    if (!text) return;

    // 4. Publish (TelegramPublisher handles caption-length split automatically)
    try {
      const messageId = await this.telegram.publish(
        { text, imageUrl: posterUrl, source: row.link ?? row.id, tags: [], title: row.title },
        { id: channelId },
      );
      await this.db.markPosted(row.id, channelId);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.link ?? row.id,
        title:        row.title,
        strategyType: this.type,
        tags:         [dataSource],
      });
      this.logger.debug(`Published ${dataSource} asset to ${channelId}: ${row.title}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Publish failed for asset id=${row.id}: ${message}`);
      await this.notifier.notifyFailed(channelId, message, row.title);
    }
  }

  // ─── AI generation ──────────────────────────────────────────────────────────

  private async generateText(
    dataSource: AssetsParams['dataSource'],
    row: import('./assets.repository').AssetRow,
  ): Promise<string | null> {
    switch (dataSource) {
      case 'academy-openai':
        return this.claude.chat([
          { role: 'system', content: ACADEMY_SYSTEM_PROMPT },
          { role: 'user',   content: buildAcademyUserMessage(row) },
        ]);

      case 'mcpservers': {
        const toolsText = row.link ? await this.fetchMcpTools(row.link) : '';
        return this.claude.chat([
          { role: 'system', content: MCPSERVERS_SYSTEM_PROMPT },
          { role: 'user',   content: buildMcpUserMessage(row, toolsText) },
        ]);
      }

      case 'prompts-md':
        return this.claude.chat([
          { role: 'system', content: PROMPTS_MD_SYSTEM_PROMPT },
          { role: 'user',   content: buildPromptsUserMessage(row) },
        ]);

      default:
        this.logger.warn(`Unknown dataSource: ${dataSource}`);
        return null;
    }
  }

  // ─── Message builder ─────────────────────────────────────────────────────────

  private buildMessage(
    dataSource: AssetsParams['dataSource'],
    aiText: string,
    row: any,
    tag: string,
  ): string {
    switch (dataSource) {
      case 'academy-openai': return buildAcademyMessage(aiText, row, tag);
      case 'mcpservers':     return buildMcpMessage(aiText, row, tag);
      case 'prompts-md':     return buildPromptsMessage(aiText, row, tag);
      default:               return '';
    }
  }

  // ─── MCP page scraper ────────────────────────────────────────────────────────

  /**
   * Fetches the MCP server page and extracts the "Available Tools" h2 section.
   * Returns empty string if unavailable.
   */
  private async fetchMcpTools(url: string): Promise<string> {
    let html: string;
    try {
      const res = await axios.get<string>(url, {
        timeout: 15_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai0bot/1.0)' },
        responseType: 'text',
      });
      html = typeof res.data === 'string' ? res.data : '';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to fetch MCP page (${url}): ${msg}`);
      return '';
    }

    if (!html) return '';

    const $ = cheerio.load(html);
    let toolsText = '';

    $('h2').each((_, el) => {
      if ($(el).text().trim() === 'Available Tools') {
        const parts: string[] = [];
        let next = $(el).next();
        while (next.length && !next.is('h2')) {
          const t = next.text().trim();
          if (t) parts.push(t);
          next = next.next();
        }
        toolsText = parts.join('\n').trim();
        return false; // break
      }
    });

    return toolsText;
  }
}
