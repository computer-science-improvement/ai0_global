import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { REDIS } from './tracking.tokens';

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
