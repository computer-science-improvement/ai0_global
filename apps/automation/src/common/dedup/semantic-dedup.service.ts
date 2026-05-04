import { Injectable, Logger, Optional } from '@nestjs/common';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import { PublicationsRepository } from '../../stats/publications.repository';
import { ChannelConfigService } from '../../config/channel-config.service';
import { AiLoggerService } from '../ai/ai-logger.service';

export type NoveltyVerdict = 'NEW' | 'DUPLICATE' | 'UPDATE';

export interface IncomingItem {
  title:   string;
  content: string;
}

/**
 * Semantic dedup: before we spend tokens generating a post, ask a cheap Haiku
 * agent whether the incoming item is topically new relative to what this
 * channel already published in the configured time window. Multiple strategies
 * may publish to the same channel, so this catches cross-strategy repeats
 * that the exact-URL dedup can't see.
 *
 * Returns NEW → proceed with generation.
 * Returns DUPLICATE or UPDATE → caller should mark the item as posted (to
 * avoid retrying it) and move on without publishing.
 *
 * If the repository isn't wired (stats module disabled) or the window is 0,
 * this service short-circuits to NEW.
 */
@Injectable()
export class SemanticDedupService {
  private readonly logger = new Logger(SemanticDedupService.name);
  private readonly cwd = join(__dirname, '..', '..', '..');

  constructor(
    @Optional() private readonly publications: PublicationsRepository,
    private readonly channelConfig: ChannelConfigService,
    private readonly aiLogger: AiLoggerService,
  ) {}

  async check(channelId: string, incoming: IncomingItem): Promise<NoveltyVerdict> {
    const hours = this.channelConfig.getSemanticDedupHours(channelId);
    if (hours <= 0 || !this.publications) return 'NEW';

    const recent = await this.publications.listRecentHours(channelId, hours);
    if (recent.length === 0) return 'NEW';

    const prompt = this.buildPrompt(incoming, recent);
    const start  = Date.now();

    let verdict: NoveltyVerdict = 'NEW';
    let raw: string | null = null;

    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd:                             this.cwd,
          settingSources:                  ['project'],
          agent:                           'topic-novelty-checker',
          permissionMode:                  'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns:                        2,
        },
      })) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          raw = msg.result?.trim() ?? null;
        }
      }
    } catch (err: any) {
      this.logger.warn(`novelty check failed for ${channelId}: ${err.message} — defaulting to NEW`);
      return 'NEW';
    }

    verdict = this.parseVerdict(raw);

    await this.aiLogger.log({
      agent:  'topic-novelty-checker',
      model:  'agent-sdk',
      status: raw ? 'success' : 'error',
      input:  [{ role: 'user', content: prompt }],
      output: raw,
      error:  raw ? null : 'no result message',
      durationMs: Date.now() - start,
    });

    this.logger.debug(`[${channelId}] novelty=${verdict} (${recent.length} recent, ${hours}h)`);
    return verdict;
  }

  private parseVerdict(raw: string | null): NoveltyVerdict {
    if (!raw) return 'NEW'; // fail-open: don't block publishing on parse error
    const upper = raw.toUpperCase();
    if (upper.includes('DUPLICATE')) return 'DUPLICATE';
    if (upper.includes('UPDATE'))    return 'UPDATE';
    return 'NEW';
  }

  private buildPrompt(
    incoming: IncomingItem,
    recent: { title: string | null; tags: string[] | null; postedAt: Date }[],
  ): string {
    const recentJson = recent.map(r => ({
      title:    r.title ?? '',
      tags:     r.tags ?? [],
      postedAt: r.postedAt.toISOString(),
    }));

    return [
      'incoming:',
      '```json',
      JSON.stringify({
        title:   incoming.title,
        preview: incoming.content.slice(0, 300),
      }, null, 2),
      '```',
      '',
      'recent:',
      '```json',
      JSON.stringify(recentJson, null, 2),
      '```',
    ].join('\n');
  }
}
