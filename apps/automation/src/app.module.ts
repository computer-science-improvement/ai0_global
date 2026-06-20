import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule }      from './database/database.module';
import { ChannelConfigModule }  from './config/config.module';
import { LoggingModule }        from './common/logging/logging.module';
import { CommonModule }         from './common/common.module';
import { CryptoModule }         from './common/crypto/crypto.module';
import { RetentionModule }      from './common/retention/retention.module';
import { AlertingModule }       from './common/alerting/alerting.module';
import { PublishersModule }     from './publishers/publishers.module';
import { SchedulerModule }      from './scheduler/scheduler.module';
import { OnThisDayStrategyModule }   from './strategies/on-this-day/on-this-day-strategy.module';
import { Ai0NewsStrategyModule }     from './strategies/ai0-news/ai0-news-strategy.module';
import { Ai0PromptsStrategyModule }  from './strategies/ai0-prompts/ai0-prompts-strategy.module';
import { CuratedPromptsStrategyModule } from './strategies/curated-prompts/curated-prompts-strategy.module';
import { GameChannelStrategyModule } from './strategies/game-channel/game-channel-strategy.module';
import { QuotesStrategyModule }      from './strategies/quotes/quotes-strategy.module';
import { RecipesStrategyModule }     from './strategies/recipes/recipes-strategy.module';
import { RecipeCarouselStrategyModule } from './strategies/recipe-carousel/recipe-carousel-strategy.module';
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
import { ScheduledPostsModule } from './scheduled-posts/scheduled-posts.module';
import { SettingsModule }       from './settings/settings.module';
import { ActivityModule }       from './activity/activity.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ChannelConfigModule,
    LoggingModule,
    CryptoModule,
    CommonModule,
    RetentionModule,
    AlertingModule,
    StatsModule,
    PublishersModule,
    SchedulerModule,
    OnThisDayStrategyModule,
    Ai0NewsStrategyModule,
    Ai0PromptsStrategyModule,
    CuratedPromptsStrategyModule,
    GameChannelStrategyModule,
    QuotesStrategyModule,
    RecipesStrategyModule,
    RecipeCarouselStrategyModule,
    DailyPhotoStrategyModule,
    MoviesStrategyModule,
    SpaceStrategyModule,
    UaNewsStrategyModule,
    FactsStrategyModule,
    PdrQuizStrategyModule,
    MotivationBiographyStrategyModule,
    AssetsStrategyModule,
    TrackingModule,
    ScheduledPostsModule,
    SettingsModule,
    ActivityModule,
    AuthModule,
    DiscoveryModule,
  ],
  controllers: [DevController],
})
export class AppModule {}
