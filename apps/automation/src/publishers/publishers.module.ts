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

@Global()
@Module({
  providers: PUBLISHERS,
  exports:   PUBLISHERS,
})
export class PublishersModule {}
