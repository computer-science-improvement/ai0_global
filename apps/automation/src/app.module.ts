import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule }      from './database/database.module';
import { ChannelConfigModule }  from './config/config.module';
import { LoggingModule }        from './common/logging/logging.module';
import { CommonModule }         from './common/common.module';
import { LlmUsageModule }       from './common/ai/usage/llm-usage.module';
import { CryptoModule }         from './common/crypto/crypto.module';
import { RetentionModule }      from './common/retention/retention.module';
import { PublishersModule }     from './publishers/publishers.module';
import { StatsModule }          from './stats/stats.module';
import { DevController }        from './dev.controller';
import { TrackingModule }       from './tracking/tracking.module';
import { AuthModule }           from './auth/auth.module';
import { DiscoveryModule }      from './discovery/discovery.module';
import { ScheduledPostsModule } from './scheduled-posts/scheduled-posts.module';
import { SettingsModule }       from './settings/settings.module';
import { ActivityModule }       from './activity/activity.module';
import { AgentModule }          from './agent/agent.module';
import { PaymentsModule }       from './payments/payments.module';
import { EditorModule }         from './editor/editor.module';
import { SpendModule }          from './spend/spend.module';
import { DataModule }           from './data/data.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ChannelConfigModule,
    LoggingModule,
    CryptoModule,
    CommonModule,
    LlmUsageModule,
    RetentionModule,
    AgentModule,
    PaymentsModule,
    EditorModule,
    SpendModule,
    StatsModule,
    PublishersModule,
    TrackingModule,
    ScheduledPostsModule,
    SettingsModule,
    ActivityModule,
    AuthModule,
    DiscoveryModule,
    DataModule,
  ],
  controllers: [DevController],
})
export class AppModule {}
