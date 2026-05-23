import { Inject, Injectable, Logger } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import {
  CONFIG_CHANGED_CHANNEL,
  ConfigChangedEvent,
  ConfigChangedKind,
} from './config-events.types';

@Injectable()
export class ConfigEventsPublisher {
  private readonly logger = new Logger(ConfigEventsPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: IORedis) {}

  async publish(
    kind: ConfigChangedKind,
    options: { id?: string | null; reason?: string } = {},
  ): Promise<void> {
    const event: ConfigChangedEvent = {
      kind,
      id:     options.id ?? null,
      at:     new Date().toISOString(),
      reason: options.reason,
    };
    try {
      const subscribers = await this.redis.publish(
        CONFIG_CHANGED_CHANNEL,
        JSON.stringify(event),
      );
      this.logger.log(
        `published config:changed kind=${kind} id=${event.id ?? '-'} ` +
        `subs=${subscribers}${event.reason ? ` reason="${event.reason}"` : ''}`,
      );
    } catch (e: any) {
      this.logger.warn(
        `failed to publish config:changed kind=${kind}: ${e?.message ?? String(e)}`,
      );
    }
  }
}
