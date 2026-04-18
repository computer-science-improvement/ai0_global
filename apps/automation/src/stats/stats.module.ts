import { Global, Module } from '@nestjs/common';
import { PublicationsRepository }  from './publications.repository';
import { TelegramStatsClient }     from './telegram-stats.client';
import { StatsCollectorService }   from './stats-collector.service';
import { StatsService }            from './stats.service';
import { StatsController }         from './stats.controller';
import { ApiKeyGuard }             from './api-key.guard';

@Global()
@Module({
  providers: [
    PublicationsRepository,
    TelegramStatsClient,
    StatsCollectorService,
    StatsService,
    ApiKeyGuard,
  ],
  controllers: [StatsController],
  exports: [PublicationsRepository],
})
export class StatsModule {}
