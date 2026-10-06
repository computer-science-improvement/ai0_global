import { Injectable, Logger } from '@nestjs/common';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import { lockedAgentOptions } from '../ai/locked-agent-options';
import { ChannelConfigService, ForwardRoute } from '../../config/channel-config.service';
import { AiLoggerService } from '../ai/ai-logger.service';
import { agentSdkAllowed, runTrackedQuery } from '../ai/usage/agent-sdk-usage';
import { FEATURES } from '../ai/usage/features';

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

    // A blocking spend cap (spec 029) refuses routing; like any failure it returns null.
    if (!(await agentSdkAllowed(FEATURES.routingTopic, (m) => this.logger.warn(m)))) return null;

    const prompt = this.buildPrompt(postText, routes);
    const start  = Date.now();
    let raw: string | null;

    try {
      // One llm_usage row per routing call (cost and tokens from the result message).
      raw = await runTrackedQuery(() => query({
        prompt,
        // No tools, no project settings, no permission bypass — see
        // locked-agent-options.ts (the input here is untrusted).
        options: lockedAgentOptions(this.cwd, 'topic-router', 2),
      }), { feature: FEATURES.routingTopic });
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
