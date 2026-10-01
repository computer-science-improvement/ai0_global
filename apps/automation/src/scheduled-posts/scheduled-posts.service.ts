import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduledPostsRepository } from './scheduled-posts.repository';
import { validateComposedPost } from './post-validation';
import type { ComposedPost, ScheduledPost } from './scheduled-posts.types';
import { ConfigCacheService } from '../config/config-cache.service';
import { ComposedSenderService } from '../publishers/composed-sender.service';
import { SecretsService } from '../common/crypto/secrets.service';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { PublicationsRepository } from '../stats/publications.repository';

@Injectable()
export class ScheduledPostsService {
  private readonly logger = new Logger(ScheduledPostsService.name);
  constructor(
    private readonly repo:        ScheduledPostsRepository,
    private readonly configCache: ConfigCacheService,
    private readonly config:      ConfigService,
    private readonly sender:      ComposedSenderService,
    private readonly secrets:     SecretsService,
    private readonly notifier:    TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  private validate(p: ComposedPost): void {
    const { errors } = validateComposedPost(p);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    if (!this.configCache.getChannelById(p.channelId)) throw new BadRequestException('unknown channel');
    if (p.sender === 'bot' && p.botId && !this.configCache.getBotById(p.botId)) throw new BadRequestException('unknown bot');
  }

  async create(p: ComposedPost): Promise<ScheduledPost> { this.validate(p); return this.repo.create(p); }
  list(status?: string) { return this.repo.list(status); }
  async get(id: string) { const r = await this.repo.getById(id); if (!r) throw new NotFoundException(); return r; }
  async update(id: string, p: ComposedPost) { this.validate(p); const r = await this.repo.update(id, p); if (!r) throw new BadRequestException('post not found or not editable (must be pending)'); return r; }
  async cancel(id: string) { if (!(await this.repo.cancel(id))) throw new BadRequestException('post not found or not pending'); return { ok: true }; }

  /** Called by the worker: claim + publish every due post this tick. */
  async publishDue(): Promise<void> {
    const now = new Date();
    // Rows stuck in 'sending' (a prior crash/hang) may or may not have been
    // delivered: mark them 'unknown' and alert — never re-send them.
    const stale = await this.repo.markStaleUnknown();
    for (const p of stale) {
      this.logger.warn(`scheduled post ${p.id} stuck in 'sending' → unknown`);
      await this.notifier.notifyAlert(
        `⚠️ Scheduled post ${p.id} (due ${p.scheduledAt}) was stuck in 'sending' — marked unknown, ` +
        `NOT re-sent. Check the channel; re-schedule it manually if it is missing.`,
      ).catch((e: any) => this.logger.warn(`alert for ${p.id} failed: ${e?.message ?? e}`));
    }
    // claim loop — claimDue returns one at a time (skip-locked), null when drained.
    for (let post = await this.repo.claimDue(now); post; post = await this.repo.claimDue(now)) {
      await this.publishOne(post);
    }
  }

  private async publishOne(post: ScheduledPost): Promise<void> {
    try {
      const ch = this.configCache.getChannelById(post.channelId);
      if (!ch) throw new Error('channel no longer exists');
      if (ch.publish_paused) throw new Error('channel is paused (publish_paused)');

      const chatId = ch.tg_chat_id ?? ch.channel_key;
      if (!chatId) throw new Error('channel has no chat id / key');

      let botToken: string | null = null;
      if (post.sender === 'bot') {
        const bot = post.botId ? this.configCache.getBotById(post.botId) : null;
        if (!bot) throw new Error('bot not found');
        botToken = this.secrets.resolveToken(
          { enc: bot.token_enc, env: bot.token_env }, (k) => this.config.get<string>(k),
        ) ?? null;
        if (!botToken) throw new Error(`bot token env ${bot.token_env} is empty`);
      }

      const messageId = await this.sender.send({
        chatId: String(chatId), botToken, sender: post.sender, text: post.text,
        mediaType: post.mediaType, mediaUrl: post.mediaUrl, placement: post.mediaPlacement,
        buttons: post.buttons,
      });
      await this.repo.markSent(post.id, messageId);
      this.logger.log(`scheduled post ${post.id} sent → msg ${messageId}`);
      // Index it like every strategy publication (stats collector, digests).
      // published_posts.channel_id holds the channel_key. Never throws.
      await this.publications.insert({
        channelId:    ch.channel_key ?? String(chatId),
        messageId,
        sourceUrl:    null,
        title:        postTitle(post.text),
        strategyType: 'scheduled-post',
        tags:         null,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await this.repo.markFailed(post.id, msg);
      this.logger.warn(`scheduled post ${post.id} failed: ${msg}`);
    }
  }
}

/** First line of the post as plain text (tags stripped), for published_posts.title. */
function postTitle(text: string): string | null {
  const first = (text ?? '').split('\n').map((l) => l.replace(/<[^>]*>/g, '').trim()).find(Boolean);
  return first ? first.slice(0, 200) : null;
}
