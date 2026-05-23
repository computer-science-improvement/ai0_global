import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackedChannelsRepository, TrackedChannel } from '../repositories/tracked-channels.repository';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingQueueService } from '../tracking-queue.service';
import { RoiAnalyzerService } from '../processors/roi-analyzer.service';
import { TrackedChannelDto, ChannelStrategyRef } from './dto/tracked-channel.dto';
import { TrackedPostDto } from './dto/tracked-post.dto';
import { GraphDto } from './dto/graph.dto';
import { PollTier } from '../types';
import { ConfigCacheService } from '../../config/config-cache.service';

function edgeColorTier(count: number): 'green' | 'orange' | 'red' {
  if (count >= 10) return 'red';
  if (count >= 2)  return 'orange';
  return 'green';
}

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly config:      ConfigService,
    private readonly channels:    TrackedChannelsRepository,
    private readonly posts:       TrackedPostsRepository,
    private readonly edges:       TrackedEdgesRepository,
    private readonly queue:       TrackingQueueService,
    private readonly roiAnalyzer: RoiAnalyzerService,
    private readonly configCache: ConfigCacheService,
  ) {}

  async listChannels(filter: 'mine' | 'all' | 'external', q: string | undefined,
                     tier: PollTier | undefined, page: number, pageSize: number) {
    const isMine = filter === 'mine' ? true : filter === 'external' ? false : undefined;
    const offset = (page - 1) * pageSize;
    const res = await this.channels.list({ is_mine: isMine, tier, q, limit: pageSize, offset });
    return {
      items: res.items.map((c) => this.toDto(c, this.strategiesForChannel(c.id))),
      total: res.total,
    };
  }

  async getChannel(id: string): Promise<TrackedChannelDto> {
    const c = await this.channels.getById(id);
    if (!c) throw new NotFoundException(`Channel ${id} not found`);
    return this.toDto(c, this.strategiesForChannel(c.id));
  }

  /**
   * Returns strategies that publish into the given channel — primary bindings
   * plus any strategy whose primary channel forwards into this one. Reads
   * from the in-memory config cache, so this is O(bindings + forwards) per
   * channel with no DB hit.
   */
  private strategiesForChannel(channelId: string): ChannelStrategyRef[] {
    const bindings = this.configCache.getBindings();
    const forwards = this.configCache.getForwardRoutes();

    // Source channels whose forwards point into us.
    const forwardSourceIds = new Set(
      forwards.filter(f => f.target_channel_id === channelId).map(f => f.source_channel_id),
    );

    const refs: ChannelStrategyRef[] = [];
    for (const b of bindings) {
      if (b.channel_id === channelId) {
        refs.push({ id: b.id, ext_id: b.ext_id, type: b.type, enabled: b.enabled, role: 'primary' });
      } else if (forwardSourceIds.has(b.channel_id)) {
        refs.push({ id: b.id, ext_id: b.ext_id, type: b.type, enabled: b.enabled, role: 'forward' });
      }
    }
    return refs;
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

  async graph(opts: { from: Date | null; to: Date | null; minWeight: number;
                      kinds?: string[]; includeMine?: boolean }): Promise<GraphDto> {
    const edges = await this.edges.graph(opts.from, opts.to, opts.minWeight);
    const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
    const includeMine = opts.includeMine ?? true;

    const nodeIds = new Set<string>();
    edges.forEach((e) => { nodeIds.add(e.source_channel_id); if (e.target_channel_id) nodeIds.add(e.target_channel_id); });

    const nodeRows = await Promise.all([...nodeIds].map((id) => this.channels.getById(id)));
    const nodeMap = new Map(nodeRows.filter((n) => n != null).map((n) => [n!.id, n!]));

    const filteredEdges = edges.filter((e) => {
      if (kinds && !kinds.has(e.target_kind)) return false;
      if (!includeMine) {
        const src = nodeMap.get(e.source_channel_id);
        if (src?.isMine) return false;
      }
      return true;
    });

    const finalNodeIds = new Set<string>();
    filteredEdges.forEach((e) => {
      finalNodeIds.add(e.source_channel_id);
      if (e.target_channel_id) finalNodeIds.add(e.target_channel_id);
    });

    const nodes = [...finalNodeIds].map((id) => {
      const c = nodeMap.get(id);
      return c ? { id: c.id, username: c.username, title: c.title,
                   subs: c.subsCount, isMine: c.isMine, category: c.category ?? null } : null;
    }).filter((n): n is NonNullable<typeof n> => n != null);

    return {
      nodes,
      edges: filteredEdges.map((e) => ({
        source:          e.source_channel_id,
        target:          e.target_channel_id,
        target_username: e.target_username,
        count:           e.ad_post_count,
        kind:            e.target_kind,
        colorTier:       edgeColorTier(e.ad_post_count),
        last_seen:       e.last_seen_at.toISOString(),
      })),
    };
  }

  async roi(channelId: string, fresh = false) {
    return this.roiAnalyzer.analyze(channelId, fresh);
  }

  async edgePosts(sourceChannelId: string, targetUsername: string) {
    const items = await this.posts.listByAdRefTarget(sourceChannelId, targetUsername.toLowerCase());
    return { items };
  }

  async discovery() {
    const items = await this.channels.listDiscoveryCandidates();
    return {
      items: items.map((c) => ({
        id: c.id, username: c.username, isClosed: c.isClosed, addedAt: c.addedAt.toISOString(),
      })),
    };
  }

  private toDto(c: TrackedChannel, strategies: ChannelStrategyRef[] = []): TrackedChannelDto {
    return {
      id: c.id, username: c.username, title: c.title, about: c.about,
      subsCount: c.subsCount, isMine: c.isMine, isClosed: c.isClosed,
      pollTier: c.pollTier, addedAt: c.addedAt.toISOString(),
      lastPolledAt: c.lastPolledAt ? c.lastPolledAt.toISOString() : null,
      strategies,
    };
  }
}
