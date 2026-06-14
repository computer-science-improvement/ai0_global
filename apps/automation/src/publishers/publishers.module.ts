import { Module, Global } from '@nestjs/common';
import { TelegramPublisher } from './telegram.publisher';
import { InstagramPublisher } from './instagram.publisher';
import { ThreadsPublisher } from './threads.publisher';
import { FacebookPublisher } from './facebook.publisher';
import { TelegramNotifier } from './telegram-notifier.service';
import { PostingThrottleService } from './posting-throttle.service';
import { AdminBotService } from './admin-bot.service';
import { TelegraphService } from './telegraph.service';
import { ComposedSenderService } from './composed-sender.service';
import { PublisherDispatcher } from './publisher-dispatcher.service';
import { CrossPostService } from './cross-post.service';
import { SlideHostingService } from './hosting/slide-hosting.service';
import { SupabaseSlideHostingService } from './hosting/supabase-slide-hosting.service';

const PUBLISHERS = [
  TelegramPublisher,
  InstagramPublisher,
  ThreadsPublisher,
  FacebookPublisher,
  TelegramNotifier,
  PostingThrottleService,
  AdminBotService,
  TelegraphService,
  ComposedSenderService,
  PublisherDispatcher,
  CrossPostService,
];

const SLIDE_HOSTING = { provide: SlideHostingService, useClass: SupabaseSlideHostingService };

@Global()
@Module({
  providers: [...PUBLISHERS, SLIDE_HOSTING],
  exports:   [...PUBLISHERS, SlideHostingService],
})
export class PublishersModule {}
