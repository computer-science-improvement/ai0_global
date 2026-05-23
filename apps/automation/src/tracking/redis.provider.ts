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
    const client = new IORedis(url, { maxRetriesPerRequest: null });
    const logger = new Logger('Redis');
    client.on('connect', () => logger.log(`connected to ${url}`));
    client.on('error',   (e) => logger.warn(`error: ${e.message}`));
    return client;
  },
};
