import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { ChannelConfigService }    from '../../config/channel-config.service';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PostingThrottleService }  from '../../publishers/posting-throttle.service';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { PdrQuizRepository } from './pdr-quiz.repository';

// Telegram sendPoll limits
const MAX_QUESTION = 300;
const MAX_OPTION   = 100;
const MAX_EXPL     = 200;

const LABELS = ['А', 'Б', 'В', 'Г', 'Д', 'Е'];

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function needsExpanded(questionText: string, answers: Array<{ text: string }>): boolean {
  if (questionText.length > MAX_QUESTION) return true;
  return answers.some((a) => a.text.length > MAX_OPTION);
}

@Injectable()
export class PdrQuizStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(PdrQuizStrategy.name);

  readonly type = 'pdr-quiz';

  constructor(
    private readonly registry:       ContentStrategyRegistry,
    private readonly db:             PdrQuizRepository,
    private readonly channelConfig:  ChannelConfigService,
    private readonly notifier:       TelegramNotifier,
    private readonly throttle:       PostingThrottleService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] { return []; }

  async fetch(_p: StrategyParams, _c: string): Promise<StrategyFetchResult | null> { return null; }

  async generate(_d: StrategyFetchResult, _p: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const q = await this.db.getNext(channelId);

    if (!q) {
      this.logger.debug('No unposted PDR questions available');
      return;
    }

    const { chatId, botToken } = this.channelConfig.resolveChannel(channelId);

    const answers = Array.isArray(q.answers) ? q.answers : [];
    const options = answers.map((a) => ({ text: truncate(a.text, MAX_OPTION) }));

    // correct_answer_num matches answer.num (0-based), find position in options array
    const correctIdx = answers.findIndex((a) => a.num === q.correct_answer_num);
    if (correctIdx === -1) {
      this.logger.warn(`Q${q.question_id}: correct_answer_num ${q.correct_answer_num} not found in answers, skipping`);
      await this.db.markPosted(q.id, channelId);
      return;
    }

    const question = truncate(q.text, MAX_QUESTION);

    const explanation = q.explanation
      ? truncate(q.explanation, MAX_EXPL)
      : undefined;

    try {
      const base = `https://api.telegram.org/bot${botToken}`;

      let lastMessageId: number | undefined;

      // 1. Image
      if (q.image_url) {
        const res = await axios.post(
          `${base}/sendPhoto`,
          { chat_id: chatId, photo: q.image_url },
          { timeout: 15_000 },
        );
        lastMessageId = res.data.result.message_id;
      }

      // 2. Decide between normal and expanded mode
      const expanded = needsExpanded(question, answers);

      let pollOptions: Array<{ text: string }>;
      let pollQuestion: string;

      if (expanded) {
        // Build text message: full question + labeled answers
        const answerLines = answers
          .map((a, i) => `<b>${LABELS[i]})</b> <i>${a.text}</i>`)
          .join('\n\n');

        const lines: string[] = [
          `<b>${q.text}</b>`,
          '',
          '──────────────',
          '',
          answerLines,
        ];

        const textRes = await axios.post(
          `${base}/sendMessage`,
          {
            chat_id:    chatId,
            text:       lines.join('\n'),
            parse_mode: 'HTML',
            ...(lastMessageId && { reply_parameters: { message_id: lastMessageId } }),
          },
          { timeout: 15_000 },
        );
        lastMessageId = textRes.data.result.message_id;

        // Poll uses only labels
        pollOptions  = answers.map((_, i) => ({ text: LABELS[i] }));
        pollQuestion = truncate(q.text, MAX_QUESTION);
      } else {
        pollOptions  = options;
        pollQuestion = question;
      }

      // 3. Poll (reply to image or text message)
      const pollRes = await axios.post(
        `${base}/sendPoll`,
        {
          chat_id:             chatId,
          question:            pollQuestion,
          options:             pollOptions,
          type:                'quiz',
          correct_option_ids:  [correctIdx],
          explanation,
          is_anonymous:        true,
          ...(lastMessageId && { reply_parameters: { message_id: lastMessageId } }),
        },
        { timeout: 15_000 },
      );

      const pollMessageId = String(pollRes.data.result.message_id);
      this.throttle.recordPublish(channelId);
      await this.db.markPosted(q.id, channelId);
      await this.notifier.notifyPublished(channelId, pollMessageId);
      this.logger.log(`PDR quiz sent: ticket ${q.ticket_number} q${q.question_num} → ${channelId} [${expanded ? 'expanded' : 'normal'}]`);
    } catch (err: any) {
      this.logger.error(`sendPoll failed: ${err.response?.data?.description ?? err.message}`);
      await this.notifier.notifyFailed(channelId, err.response?.data?.description ?? err.message, `ticket ${q.ticket_number} q${q.question_num}`);
    }
  }
}
