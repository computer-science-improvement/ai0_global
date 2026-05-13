import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackedChannelsRepository, TrackedChannel } from '../repositories/tracked-channels.repository';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingQueueService } from '../tracking-queue.service';
import { estimateRoi } from '../processors/roi-heuristic';
import { TrackedChannelDto } from './dto/tracked-channel.dto';
import { TrackedPostDto } from './dto/tracked-post.dto';
import { GraphDto } from './dto/graph.dto';
import { PollTier } from '../types';

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly config:   ConfigService,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly edges:    TrackedEdgesRepository,
    private readonly queue:    TrackingQueueService,
  ) {}

  async listChannels(filter: 'mine' | 'all' | 'external', q: string | undefined,
                     tier: PollTier | undefined, page: number, pageSize: number) {
    const isMine = filter === 'mine' ? true : filter === 'external' ? false : undefined;
    const offset = (page - 1) * pageSize;
    const res = await this.channels.list({ is_mine: isMine, tier, q, limit: pageSize, offset });
    return { items: res.items.map((c) => this.toDto(c)), total: res.total };
  }

  async getChannel(id: string): Promise<TrackedChannelDto> {
    const c = await this.channels.getById(id);
    if (!c) throw new NotFoundException(`Channel ${id} not found`);
    return this.toDto(c);
  }

  async addChannel(username: string): Promise<{ id: string; status: 'queued' | 'already_tracked' }> {
    const clean = username.replace(/^@/, '').toLowerCase();
    const existing = await this.channels.getByUsername(clean);
    if (existing) return { id: existing.id, status: 'already_tracked' };
    const id = await this.channels.upsertByUsername({ username: clean, pollTier: 'warm' });
    await this.queue.addPollMeta({ channelId: id });
    await this.queue.addPollPosts({ channelId: id });
    return { id, status: 'queued' };
  }

  async deleteChannel(id: string): Promise<void> { await this.channels.softDelete(id); }

  async listPosts(channelId: string, from: Date | null, to: Date | null, limit: number, offset: number):
    Promise<{ items: TrackedPostDto[]; total: number }> {
    const r = await this.posts.listByChannel(channelId, from, to, limit, offset);
    return {
      items: r.items.map((p) => ({
        id: p.id, channelId: p.channelId, tgMessageId: p.tgMessageId,
        text: p.text, hasMedia: p.hasMedia, postedAt: p.postedAt.toISOString(),
        views: p.views, forwards: p.forwards, reactionsTotal: p.reactionsTotal,
        commentsCount: p.commentsCount, adRefs: p.adRefs,
      })),
      total: r.total,
    };
  }

  async subsHistory(channelId: string, from: Date | null, to: Date | null) {
    const points = await this.channels.subsHistory(channelId, from, to);
    return { points: points.map((p) => ({ at: p.snapshotAt.toISOString(), subs: p.subsCount })) };
  }

  async topPosts(channelId: string, metric: 'views' | 'reactions' | 'forwards', limit: number) {
    const column = metric === 'reactions' ? 'reactions_total' : metric;
    const items = await this.posts.topByMetric(channelId, column as 'views' | 'reactions_total' | 'forwards', limit);
    return { items };
  }

  async graph(from: Date | null, to: Date | null, minWeight: number): Promise<GraphDto> {
    const edges = await this.edges.graph(from, to, minWeight);
    const nodeIds = new Set<string>();
    edges.forEach((e) => { nodeIds.add(e.source_channel_id); if (e.target_channel_id) nodeIds.add(e.target_channel_id); });

    const nodes = await Promise.all([...nodeIds].map(async (id) => {
      const c = await this.channels.getById(id);
      return c ? { id: c.id, username: c.username, title: c.title, subs: c.subsCount, isMine: c.isMine } : null;
    }));

    return {
      nodes: nodes.filter((n): n is NonNullable<typeof n> => n !== null),
      edges: edges.map((e) => ({
        source: e.source_channel_id,
        target: e.target_channel_id,
        target_username: e.target_username,
        count: e.ad_post_count,
        kind: e.target_kind,
        last_seen: e.last_seen_at.toISOString(),
      })),
    };
  }

  async roi(channelId: string) {
    const c = await this.channels.getById(channelId);
    if (!c) throw new NotFoundException(`Channel ${channelId} not found`);
    const stats = await this.posts.statsLast30Days(channelId);
    const daysHistory = Math.floor((Date.now() - c.addedAt.getTime()) / 86_400_000);
    return estimateRoi({
      avgViews: stats.avgViews, subs: c.subsCount ?? 0,
      engagementRate: stats.engagementRate, daysHistory, postsCount: stats.postsCount,
      viewToSubRate: parseFloat(this.config.get<string>('TRACKING_VIEW_TO_SUB_RATE') ?? '0.02'),
    });
  }

  async discovery() {
    const items = await this.channels.listDiscoveryCandidates();
    return {
      items: items.map((c) => ({
        id: c.id, username: c.username, isClosed: c.isClosed, addedAt: c.addedAt.toISOString(),
      })),
    };
  }

  private toDto(c: TrackedChannel): TrackedChannelDto {
    return {
      id: c.id, username: c.username, title: c.title, about: c.about,
      subsCount: c.subsCount, isMine: c.isMine, isClosed: c.isClosed,
      pollTier: c.pollTier, addedAt: c.addedAt.toISOString(),
      lastPolledAt: c.lastPolledAt ? c.lastPolledAt.toISOString() : null,
    };
  }
}
