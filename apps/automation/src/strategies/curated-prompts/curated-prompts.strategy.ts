import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { CuratedPromptsRepository, CuratedPromptRow } from './curated-prompts.repository';

const CAPTION_MAX = 1024;
const REPLY_MAX   = 4096;
const USER_AGENT  =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hashtag(category: string | null): string {
  if (!category) return '';
  return '#' + category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

@Injectable()
export class CuratedPromptsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(CuratedPromptsStrategy.name);
  readonly type = 'curated-prompts';

  constructor(
    private readonly registry:     ContentStrategyRegistry,
    private readonly publisher:    TelegramPublisher,
    private readonly repo:         CuratedPromptsRepository,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() { this.registry.register(this); }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(): Promise<StrategyFetchResult | null> { return null; }
  async generate(): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(channelId: string, params: StrategyParams): Promise<void> {
    const p = (params ?? {}) as { provider?: string; mediaType?: string };
    const row = await this.repo.getNext({ provider: p.provider, mediaType: p.mediaType });
    if (!row) { this.logger.debug('No unposted curated prompts'); return; }

    const { caption, replyText } = this.buildMessage(row);

    try {
      let messageId: string;
      if (row.media_type === 'video') {
        messageId = await this.publisher.publishVideo(
          { videoUrl: row.media_url, caption, replyText }, { id: channelId },
        );
      } else {
        const imageBuffer = await this.downloadImage(row.media_url);
        messageId = await this.publisher.publishPrompt(
          { imageBuffer, caption, replyText: replyText || undefined }, { id: channelId },
        );
      }
      await this.repo.markPosted(row.id);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.media_url,
        title:        (row.title ?? row.prompt_text).slice(0, 200),
        strategyType: this.type,
        tags:         row.category ? [row.category] : [],
      });
      this.logger.debug(`Published curated prompt ${row.id} to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Publish failed (${row.id}): ${err.message}`);
      // no markPosted — retried next run
    }
  }

  /** Caption mirrors the ai0-prompts format; long prompt overflows to reply. */
  private buildMessage(row: CuratedPromptRow): { caption: string; replyText?: string } {
    const title = row.title ? `<b>${escapeHtml(row.title)}</b>` : '';
    const tag   = hashtag(row.category);
    const src   = row.source ? `\u{1F464} ${escapeHtml(row.source)}` : '';
    const promptBlock = `\u{1F4AC} Prompt:\n<code>${escapeHtml(row.prompt_text)}</code>`;

    const full = [title, promptBlock, [src, tag].filter(Boolean).join('\n')]
      .filter(Boolean).join('\n\n');

    if (full.length <= CAPTION_MAX) return { caption: full };

    // Overflow: short caption + prompt in the reply.
    const caption = [title, tag].filter(Boolean).join('\n\n') || '\u{1F4AC} Prompt';
    let reply = [promptBlock, src].filter(Boolean).join('\n\n');
    if (reply.length > REPLY_MAX) reply = reply.slice(0, REPLY_MAX - 1) + '…';
    return { caption, replyText: reply };
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
