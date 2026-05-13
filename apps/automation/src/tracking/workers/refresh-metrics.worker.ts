import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { Pool } from 'pg';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { DB_POOL } from '../../database/database.tokens';
import { TRACKING_QUEUES, RefreshMetricsJob } from '../types';

@Injectable()
export class RefreshMetricsWorker implements OnModuleInit {
  private readonly logger = new Logger(RefreshMetricsWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly posts:    TrackedPostsRepository,
    private readonly channels: TrackedChannelsRepository,
    private readonly mtproto:  TrackingMtprotoClient,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<RefreshMetricsJob>(
      TRACKING_QUEUES.REFRESH_METRICS,
      (job) => this.handle(job),
      3,
    );
  }

  private async handle(job: Job<RefreshMetricsJob>): Promise<void> {
    const r = await this.pool.query<any>(`SELECT * FROM tracked_posts WHERE id = $1`, [job.data.postId]);
    const post = r.rows[0];
    if (!post) return;

    const channel = await this.channels.getById(post.channel_id);
    if (!channel) return;
    const target = channel.tgChatId ?? channel.username;
    if (!target) return;

    const msgs = await this.mtproto.getHistory(target, parseInt(post.tg_message_id, 10) - 1, 1);
    const m = msgs.find((x) => x.id === parseInt(post.tg_message_id, 10));
    if (!m) return;

    await this.posts.upsert({
      channelId:      post.channel_id,
      tgMessageId:    post.tg_message_id,
      postedAt:       post.posted_at,
      views:          m.views,
      forwards:       m.forwards,
      reactionsTotal: m.reactionsTotal,
      reactions:      m.reactions,
      commentsCount:  m.replies,
    });

    await this.pool.query(
      `INSERT INTO tracked_post_metrics_history
         (post_id, snapshot_at, views, forwards, reactions, comments)
       VALUES ($1, now(), $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [post.id, m.views ?? 0, m.forwards ?? 0, m.reactionsTotal ?? 0, m.replies ?? 0],
    );
  }
}
