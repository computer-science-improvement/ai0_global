import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule }      from './database/database.module';
import { ChannelConfigModule }  from './config/config.module';
import { LoggingModule }        from './common/logging/logging.module';
import { CommonModule }         from './common/common.module';
import { PublishersModule }     from './publishers/publishers.module';
import { SchedulerModule }      from './scheduler/scheduler.module';
import { OnThisDayStrategyModule }   from './strategies/on-this-day/on-this-day-strategy.module';
import { Ai0NewsStrategyModule }     from './strategies/ai0-news/ai0-news-strategy.module';
import { Ai0PromptsStrategyModule }  from './strategies/ai0-prompts/ai0-prompts-strategy.module';
import { GameChannelStrategyModule } from './strategies/game-channel/game-channel-strategy.module';
import { QuotesStrategyModule }      from './strategies/quotes/quotes-strategy.module';
import { RecipesStrategyModule }     from './strategies/recipes/recipes-strategy.module';
import { DailyPhotoStrategyModule }  from './strategies/daily-photo/daily-photo-strategy.module';
import { MoviesStrategyModule }      from './strategies/movies/movies-strategy.module';
import { SpaceStrategyModule }       from './strategies/space/space-strategy.module';
import { UaNewsStrategyModule }      from './strategies/ua-news/ua-news-strategy.module';
import { FactsStrategyModule }       from './strategies/facts/facts-strategy.module';
import { PdrQuizStrategyModule }              from './strategies/pdr-quiz/pdr-quiz-strategy.module';
import { MotivationBiographyStrategyModule }  from './strategies/motivation-biography/motivation-biography-strategy.module';
import { AssetsStrategyModule }              from './strategies/assets/assets-strategy.module';
import { StatsModule }          from './stats/stats.module';
import { DevController }        from './dev.controller';
import { TrackingModule }       from './tracking/tracking.module';
import { AuthModule }           from './auth/auth.module';
import { DiscoveryModule }      from './discovery/discovery.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ChannelConfigModule,
    LoggingModule,
    CommonModule,
    StatsModule,
    PublishersModule,
    SchedulerModule,
    OnThisDayStrategyModule,
    Ai0NewsStrategyModule,
    Ai0PromptsStrategyModule,
    GameChannelStrategyModule,
    QuotesStrategyModule,
    RecipesStrategyModule,
    DailyPhotoStrategyModule,
    MoviesStrategyModule,
    SpaceStrategyModule,
    UaNewsStrategyModule,
    FactsStrategyModule,
    PdrQuizStrategyModule,
    MotivationBiographyStrategyModule,
    AssetsStrategyModule,
    TrackingModule,
    AuthModule,
    DiscoveryModule,
  ],
  controllers: [DevController],
})
export class AppModule {}
