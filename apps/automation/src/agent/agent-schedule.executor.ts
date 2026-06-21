import { Injectable } from '@nestjs/common';
import { ScheduledPostsRepository } from '../scheduled-posts/scheduled-posts.repository';
import type { ComposedPost } from '../scheduled-posts/scheduled-posts.types';

@Injectable()
export class AgentScheduleExecutor {
  constructor(private readonly posts: ScheduledPostsRepository) {}

  /** Insert a minimal text sponsored/ВП post into the existing scheduled queue. */
  async schedule(input: { channelId: string; text: string; scheduledAt: string }): Promise<string> {
    const post: ComposedPost = {
      channelId:      input.channelId,
      sender:         'bot',
      botId:          null,
      text:           input.text,
      mediaType:      'none',
      mediaUrl:       null,
      mediaPlacement: 'below',
      buttons:        [],
      scheduledAt:    input.scheduledAt,
    };
    const created = await this.posts.create(post);
    return created.id;
  }
}
