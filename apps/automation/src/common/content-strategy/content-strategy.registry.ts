import { Injectable, Logger } from '@nestjs/common';
import { ContentStrategy } from './content-strategy.interface';
import type { DestinationPlatform } from './publish-destination';

/**
 * Registry for content strategies.
 * Strategies register themselves on module init; the scheduler
 * looks them up by type when wiring cron jobs.
 */
@Injectable()
export class ContentStrategyRegistry {
  private readonly logger = new Logger(ContentStrategyRegistry.name);
  private readonly strategies = new Map<string, ContentStrategy>();

  register(strategy: ContentStrategy): void {
    if (this.strategies.has(strategy.type)) {
      throw new Error(`Duplicate content strategy type: "${strategy.type}"`);
    }
    this.strategies.set(strategy.type, strategy);
    this.logger.log(`Registered strategy: ${strategy.type}`);
  }

  get(type: string): ContentStrategy | undefined {
    return this.strategies.get(type);
  }

  all(): ContentStrategy[] {
    return Array.from(this.strategies.values());
  }

  types(): string[] {
    return Array.from(this.strategies.keys());
  }

  /** Platforms a strategy type can target; defaults to ['telegram']. */
  supportedPlatforms(type: string): DestinationPlatform[] {
    return this.strategies.get(type)?.supportedPlatforms ?? ['telegram'];
  }
}
