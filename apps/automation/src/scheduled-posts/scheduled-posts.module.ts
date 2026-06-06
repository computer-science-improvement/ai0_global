import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ChannelConfigModule } from '../config/config.module';
import { PublishersModule } from '../publishers/publishers.module';
import { ScheduledPostsController } from './scheduled-posts.controller';
import { ScheduledPostsService } from './scheduled-posts.service';
import { ScheduledPostsRepository } from './scheduled-posts.repository';
import { ScheduledPostsWorker } from './scheduled-posts.worker';

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, ChannelConfigModule, PublishersModule],
  controllers: [ScheduledPostsController],
  providers: [ScheduledPostsRepository, ScheduledPostsService, ScheduledPostsWorker],
})
export class ScheduledPostsModule {}
