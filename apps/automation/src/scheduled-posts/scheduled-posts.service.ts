import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduledPostsRepository } from './scheduled-posts.repository';
import { validateComposedPost } from './post-validation';
import type { ComposedPost, ScheduledPost } from './scheduled-posts.types';
import { ConfigCacheService } from '../config/config-cache.service';
import { ComposedSenderService } from '../publishers/composed-sender.service';

@Injectable()
export class ScheduledPostsService {
  private readonly logger = new Logger(ScheduledPostsService.name);
  constructor(
    private readonly repo:        ScheduledPostsRepository,
    private readonly configCache: ConfigCacheService,
    private readonly config:      ConfigService,
    private readonly sender:      ComposedSenderService,
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
        botToken = this.config.get<string>(bot.token_env) ?? null;
        if (!botToken) throw new Error(`bot token env ${bot.token_env} is empty`);
      }

      const messageId = await this.sender.send({
        chatId: String(chatId), botToken, sender: post.sender, text: post.text,
        mediaType: post.mediaType, mediaUrl: post.mediaUrl, placement: post.mediaPlacement,
        buttons: post.buttons,
      });
      await this.repo.markSent(post.id, messageId);
      this.logger.log(`scheduled post ${post.id} sent → msg ${messageId}`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await this.repo.markFailed(post.id, msg);
      this.logger.warn(`scheduled post ${post.id} failed: ${msg}`);
    }
  }
}
