// apps/automation/src/config/config-events.publisher.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { CONFIG_CHANGED_CHANNEL, ConfigChangedEvent, ConfigChangedKind } from './config-events.types';

@Injectable()
export class ConfigEventsPublisher {
  private readonly logger = new Logger(ConfigEventsPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async publish(kind: ConfigChangedKind, id?: string): Promise<void> {
    const event: ConfigChangedEvent = { kind, id, at: new Date().toISOString() };
    try {
      await this.redis.publish(CONFIG_CHANGED_CHANNEL, JSON.stringify(event));
    } catch (err: any) {
      this.logger.warn(`Failed to publish config:changed: ${err.message}`);
    }
  }
}
