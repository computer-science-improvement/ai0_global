import { Global, Module } from '@nestjs/common';
import { PublicationsRepository }        from './publications.repository';
import { TelegramStatsClient }           from './telegram-stats.client';
import { StatsCollectorService }         from './stats-collector.service';
import { StatsService }                  from './stats.service';
import { StatsController }               from './stats.controller';
import { ApiKeyGuard }                   from './api-key.guard';
import { MetaFollowerHistoryRepository } from './meta-follower-history.repository';
import { MetaStatsCollectorService }     from './meta-stats-collector.service';

@Global()
@Module({
  providers: [
    PublicationsRepository,
    TelegramStatsClient,
    StatsCollectorService,
    StatsService,
    ApiKeyGuard,
    MetaFollowerHistoryRepository,
    MetaStatsCollectorService,
  ],
  controllers: [StatsController],
  exports: [PublicationsRepository, TelegramStatsClient, MetaFollowerHistoryRepository],
})
export class StatsModule {}
