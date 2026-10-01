import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { REDIS } from './tracking.tokens';

/**
 * Cross-module alias for the Redis client DI token. Other modules
 * (e.g. ConfigModule) import this instead of reaching into tracking's
 * internal tokens file.
 */
export const REDIS_CLIENT = REDIS;

export const RedisProvider: Provider = {
  provide: REDIS,
  inject:  [ConfigService],
  useFactory: (config: ConfigService) => {
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    // Optional auth (compose adds --requirepass when REDIS_PASSWORD is set). A
    // password embedded in REDIS_URL still wins — ioredis prefers URL fields.
    const password = config.get<string>('REDIS_PASSWORD') || undefined;
    const client = new IORedis(url, { maxRetriesPerRequest: null, ...(password ? { password } : {}) });
    const logger = new Logger('Redis');
    client.on('connect', () => logger.log(`connected to ${url}`));
    client.on('error',   (e) => logger.warn(`error: ${e.message}`));
    return client;
  },
};
