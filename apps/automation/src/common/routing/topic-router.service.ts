import { Injectable, Logger } from '@nestjs/common';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import { ChannelConfigService, ForwardRoute } from '../../config/channel-config.service';
import { AiLoggerService } from '../ai/ai-logger.service';

/**
 * Classifies a finished post against the source channel's declared
 * forwardRoutes and returns the single target channelId for forwarding, or
 * null if no route matches (including when no routes are declared).
 *
 * Fails open: any error or unparseable agent output returns null, so routing
 * problems never break the already-successful publish.
 */
@Injectable()
export class TopicRouterService {
  private readonly logger = new Logger(TopicRouterService.name);
  private readonly cwd = join(__dirname, '..', '..', '..');

  constructor(
    private readonly channelConfig: ChannelConfigService,
    private readonly aiLogger: AiLoggerService,
  ) {}

  async route(postText: string, sourceChannelId: string): Promise<string | null> {
    const routes = this.channelConfig.getForwardRoutes(sourceChannelId);
    if (routes.length === 0) return null;

    const prompt = this.buildPrompt(postText, routes);
    const start  = Date.now();
    let raw: string | null = null;

    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd:                             this.cwd,
          settingSources:                  ['project'],
          agent:                           'topic-router',
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
      this.logger.warn(`topic-router failed for ${sourceChannelId}: ${err.message}`);
      return null;
    }

    await this.aiLogger.log({
      agent:  'topic-router',
      model:  'agent-sdk',
      status: raw ? 'success' : 'error',
      input:  [{ role: 'user', content: prompt }],
      output: raw,
      error:  raw ? null : 'no result message',
      durationMs: Date.now() - start,
    });

    const topicKey = this.parseTopic(raw, routes);
    if (!topicKey) {
      this.logger.debug(`[${sourceChannelId}] topic-router → none`);
      return null;
    }

    const match = routes.find(r => r.topic === topicKey);
    if (!match) {
      this.logger.warn(`topic-router returned unknown topic "${topicKey}" for ${sourceChannelId}`);
      return null;
    }
    this.logger.debug(`[${sourceChannelId}] topic-router → ${topicKey} → ${match.channelId}`);
    return match.channelId;
  }

  private parseTopic(raw: string | null, routes: ForwardRoute[]): string | null {
    if (!raw) return null;
    const word = raw.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!word || word === 'none') return null;
    return routes.some(r => r.topic === word) ? word : null;
  }

  private buildPrompt(post: string, routes: ForwardRoute[]): string {
    const publicRoutes = routes.map(r => ({ topic: r.topic, description: r.description }));
    return [
      'post:',
      '```',
      post,
      '```',
      '',
      'routes:',
      '```json',
      JSON.stringify(publicRoutes, null, 2),
      '```',
    ].join('\n');
  }
}
