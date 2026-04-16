import { Module, Global } from '@nestjs/common';
import { TelegramPublisher } from './telegram.publisher';
import { InstagramPublisher } from './instagram.publisher';
import { ThreadsPublisher } from './threads.publisher';
import { FacebookPublisher } from './facebook.publisher';
import { TelegramNotifier } from './telegram-notifier.service';
import { PostingThrottleService } from './posting-throttle.service';

const PUBLISHERS = [
  TelegramPublisher,
  InstagramPublisher,
  ThreadsPublisher,
  FacebookPublisher,
  TelegramNotifier,
  PostingThrottleService,
];

@Global()
@Module({
  providers: PUBLISHERS,
  exports:   PUBLISHERS,
})
export class PublishersModule {}
