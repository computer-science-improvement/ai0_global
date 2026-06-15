import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { CrossPostService }        from '../../publishers/cross-post.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { CuratedPromptsRepository, CuratedPromptRow } from './curated-prompts.repository';
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import type { PublishDestination, DestinationPlatform } from '../../common/content-strategy/publish-destination';
import type { MetaPlatform } from '../../config/meta-accounts.repository';

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
  readonly supportedPlatforms: DestinationPlatform[] = ['telegram', 'instagram', 'facebook', 'threads'];

  constructor(
    private readonly registry:     ContentStrategyRegistry,
    private readonly publisher:    TelegramPublisher,
    private readonly repo:         CuratedPromptsRepository,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
    private readonly crossPost:    CrossPostService,
    private readonly dispatcher:   PublisherDispatcher,
  ) {}

  onModuleInit() { this.registry.register(this); }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(): Promise<StrategyFetchResult | null> { return null; }
  async generate(): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(channelId: string, params: StrategyParams, dest?: PublishDestination): Promise<void> {
    const p = (params ?? {}) as { provider?: string; mediaType?: string };
    const postedKey = dest?.postedKey ?? 'TELEGRAM';
    const row = await this.repo.getNext({ provider: p.provider, mediaType: p.mediaType }, postedKey);
    if (!row) { this.logger.debug('No unposted curated prompts'); return; }

    const { caption, replyText } = this.buildMessage(row);

    if (dest && dest.platform !== 'telegram') {
      if (!dest.token) {
        this.logger.error(`Meta publish skipped (${row.id}): token missing for ${dest.platform}`);
        return;
      }
      // Instagram publisher takes a public image only — skip video rows (set
      // params.mediaType = 'image' on an IG binding to avoid selecting them).
      if (row.media_type !== 'image') {
        this.logger.debug(`Skipping ${row.media_type} row ${row.id} for ${dest.platform}`);
        return;
      }
      try {
        const id = await this.dispatcher.publish(
          dest.platform as MetaPlatform,
          { text: caption, imageUrl: row.media_url, source: '', tags: row.category ? [row.category] : [] },
          { id: dest.targetId, token: dest.token },
        );
        await this.repo.markPosted(row.id, postedKey);
        this.logger.debug(`Published curated ${row.id} to ${dest.platform} (${id})`);
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
      await this.repo.markPosted(row.id, postedKey);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.media_url,
        title:        (row.title ?? row.prompt_text).slice(0, 200),
        strategyType: this.type,
        tags:         row.category ? [row.category] : [],
      });
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: {
          text: caption,
          tags: row.category ? [row.category] : [],
          // video rows cross-post as text; imageless Instagram is skipped.
          imageUrl: row.media_type === 'image' ? row.media_url : undefined,
        },
      });
      this.logger.debug(`Published curated prompt ${row.id} to ${channelId}`);
    } catch (err: any) {
      // Permanently-gone media (deleted GitHub asset) → mark ERROR so the row
      // is skipped forever instead of retried every tick. Transient failures
      // (network, Telegram 5xx, paused channel) are NOT marked → retried next
      // run. text-too-short from guardText is also permanent for this row.
      const status   = err?.response?.status;
      const tooShort = typeof err?.message === 'string' && err.message.includes('text too short');
      if (status === 404 || status === 410 || tooShort) {
        this.logger.warn(`Curated prompt ${row.id} unpostable (${status ?? err.message}) — marking ERROR`);
        try { await this.repo.markError(row.id); } catch { /* best-effort */ }
      } else {
        this.logger.error(`Publish failed (${row.id}): ${err.message}`);
        // no markPosted — retried next run
      }
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

    // Overflow: short caption + prompt in the reply. Always append a hint line
    // so the caption is meaningful AND safely above guardText's 20-char floor
    // even when title and category are both absent.
    const hint = '\u{1F4AC} Повний промпт — у відповіді нижче ⬇️';
    const caption = [title, tag, hint].filter(Boolean).join('\n\n');
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
