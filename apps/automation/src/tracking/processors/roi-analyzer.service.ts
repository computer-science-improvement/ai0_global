import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeAgent } from '../../common/ai/agents/claude.agent';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedRoiCacheRepository } from '../repositories/tracked-roi-cache.repository';
import { estimateRoi } from './roi-heuristic';

export interface RoiResponse {
  estimated_subs_per_ad: number;
  confidence:            'low' | 'medium' | 'high';
  narrative:             string;
  risks:                 string[];
  source:                'heuristic' | 'claude';
  computed_at:           string;
  inputs:                { avg_views: number; subs: number; engagement_rate: number };
}

const CACHE_TTL_MS = 7 * 86_400_000;

@Injectable()
export class RoiAnalyzerService {
  private readonly logger = new Logger(RoiAnalyzerService.name);

  constructor(
    private readonly config:   ConfigService,
    private readonly claude:   ClaudeAgent,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly cache:    TrackedRoiCacheRepository,
  ) {}

  async analyze(channelId: string, fresh: boolean): Promise<RoiResponse> {
    if (!fresh) {
      const cached = await this.cache.get(channelId);
      if (cached && Date.now() - cached.computedAt.getTime() < CACHE_TTL_MS) {
        return this.toResponse(cached);
      }
    }
    return this.compute(channelId);
  }

  private async compute(channelId: string): Promise<RoiResponse> {
    const channel = await this.channels.getById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const stats = await this.posts.statsLast30Days(channelId);
    const daysHistory = Math.floor((Date.now() - channel.addedAt.getTime()) / 86_400_000);
    const viewToSubRate = parseFloat(this.config.get<string>('TRACKING_VIEW_TO_SUB_RATE') ?? '0.02');

    const heuristic = estimateRoi({
      avgViews:       stats.avgViews,
      subs:           channel.subsCount ?? 0,
      engagementRate: stats.engagementRate,
      daysHistory,
      postsCount:     stats.postsCount,
      viewToSubRate,
    });

    // ClaudeAgent exposes a boolean getter `available` that is true when
    // ANTHROPIC_API_KEY is set and the Anthropic client was initialised.
    const claudeReady = this.claude.available;

    if (!claudeReady) {
      await this.persistHeuristic(channelId, heuristic);
      return this.heuristicResponse(heuristic);
    }

    try {
      const sample = (await this.posts.listByChannel(channelId, null, null, 10, 0)).items
        .map((p) => ({ text: (p.text ?? '').slice(0, 200), views: p.views, reactions: p.reactionsTotal }));

      const raw = await this.claude.chat([
        { role: 'system', content: this.systemPrompt() },
        { role: 'user', content: JSON.stringify({
            channel: { title: channel.title, username: channel.username,
                       subs: channel.subsCount, about: channel.about },
            stats:   { avg_views: stats.avgViews, engagement_rate: stats.engagementRate,
                       posts_count: stats.postsCount, days_history: daysHistory },
            sample_posts: sample,
          }, null, 2) },
      ], { model: 'claude-haiku-4-5', maxTokens: 600 });

      if (!raw) throw new Error('Claude returned null');
      const parsed = this.parseClaudeJson(raw);
      if (!parsed) throw new Error('Could not parse Claude output');

      const floor   = Math.floor(heuristic.estimated_subs_per_ad * 0.5);
      const ceiling = Math.ceil(heuristic.estimated_subs_per_ad * 2);
      const clipped = Math.min(ceiling, Math.max(floor, parsed.estimated_subs_per_ad));

      await this.cache.upsert({
        channelId,
        estimatedSubsPerAd: clipped,
        confidence:         parsed.confidence,
        narrative:          parsed.narrative,
        risks:              parsed.risks,
        inputs:             heuristic.inputs,
        source:             'claude',
      });
      return {
        estimated_subs_per_ad: clipped,
        confidence:            parsed.confidence,
        narrative:             parsed.narrative,
        risks:                 parsed.risks,
        source:                'claude',
        computed_at:           new Date().toISOString(),
        inputs:                heuristic.inputs,
      };
    } catch (err: any) {
      this.logger.warn(`Claude ROI failed for ${channelId}: ${err.message} — falling back to heuristic`);
      await this.persistHeuristic(channelId, heuristic);
      return this.heuristicResponse(heuristic);
    }
  }

  private async persistHeuristic(channelId: string, h: ReturnType<typeof estimateRoi>): Promise<void> {
    await this.cache.upsert({
      channelId,
      estimatedSubsPerAd: h.estimated_subs_per_ad,
      confidence:         h.confidence,
      inputs:             h.inputs,
      source:             'heuristic',
    });
  }

  private heuristicResponse(h: ReturnType<typeof estimateRoi>): RoiResponse {
    return {
      estimated_subs_per_ad: h.estimated_subs_per_ad,
      confidence:            h.confidence,
      narrative:             '',
      risks:                 [],
      source:                'heuristic',
      computed_at:           new Date().toISOString(),
      inputs:                h.inputs,
    };
  }

  private systemPrompt(): string {
    return [
      'You estimate whether a Telegram channel is a good ad placement.',
      'Output ONE JSON object, no prose, no code fences:',
      '{"estimated_subs_per_ad": int,',
      ' "confidence": "low"|"medium"|"high",',
      ' "narrative": "1-2 sentence summary in Ukrainian, cite real numbers",',
      ' "risks": ["short Ukrainian bullet 1", "short Ukrainian bullet 2"]}',
      '',
      'Guardrails: estimated_subs_per_ad ≈ avg_views × engagement-multiplier × view-to-sub-rate.',
      'Confidence "high" only if ≥ 30 days history AND ≥ 50 posts.',
      'Risks must be concrete (e.g. "падіння views на 30% за останній тиждень"), not generic.',
    ].join('\n');
  }

  private parseClaudeJson(raw: string):
    { estimated_subs_per_ad: number; confidence: 'low'|'medium'|'high'; narrative: string; risks: string[] } | null {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      const obj = JSON.parse(cleaned);
      if (typeof obj?.estimated_subs_per_ad !== 'number') return null;
      if (!['low','medium','high'].includes(obj.confidence)) return null;
      return {
        estimated_subs_per_ad: Math.max(0, Math.round(obj.estimated_subs_per_ad)),
        confidence:            obj.confidence,
        narrative:             String(obj.narrative ?? ''),
        risks:                 Array.isArray(obj.risks) ? obj.risks.slice(0, 5).map(String) : [],
      };
    } catch { return null; }
  }

  private toResponse(cached: any): RoiResponse {
    return {
      estimated_subs_per_ad: cached.estimatedSubsPerAd,
      confidence:            cached.confidence,
      narrative:             cached.narrative ?? '',
      risks:                 cached.risks ?? [],
      source:                cached.source,
      computed_at:           cached.computedAt.toISOString(),
      inputs:                cached.inputs ?? { avg_views: 0, subs: 0, engagement_rate: 0 },
    };
  }
}
