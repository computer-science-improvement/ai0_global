import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { ChannelConfigService }    from '../../config/channel-config.service';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PostingThrottleService }  from '../../publishers/posting-throttle.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { CrossPostService } from '../../publishers/cross-post.service';
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
    private readonly publications:   PublicationsRepository,
    private readonly crossPost: CrossPostService,
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

    // markPosted BEFORE any Telegram publish — same reasoning as ai0-news / ua-news.
    // A process kill (deploy, OOM, crash) between sendPhoto/sendMessage/sendPoll
    // and the DB write would otherwise let the next cron re-publish the same quiz
    // on the next tick. Trade-off: if publish fails afterwards, the question is
    // marked as posted in DB but absent from Telegram (lost). Accepted to prevent
    // duplicates on @pdr_dev_channel — duplicates are far more user-visible than
    // a single skipped question out of thousands in the bank.
    await this.db.markPosted(q.id, channelId);

    try {
      const base = `https://api.telegram.org/bot${botToken}`;

      let lastMessageId: number | undefined;

      // 1. Image
      // Telegram's sendPhoto accepts either an HTTP(S) URL or a cached file_id.
      // If image_url is anything else (relative path, data: URL, empty after trim),
      // Telegram tries to decode it as a base64 file_id and fails with
      // "Wrong padding length". Validate first; skip image rather than crash.
      const imageUrl = q.image_url?.trim();
      const isValidImageUrl = imageUrl && /^https?:\/\/\S+\.\S+/i.test(imageUrl);

      if (q.image_url && !isValidImageUrl) {
        this.logger.warn(
          `Q${q.question_id}: image_url is not a valid HTTP URL ("${q.image_url.slice(0, 80)}"), skipping image`,
        );
      }

      if (isValidImageUrl) {
        try {
          const res = await axios.post(
            `${base}/sendPhoto`,
            { chat_id: chatId, photo: imageUrl },
            { timeout: 15_000 },
          );
          lastMessageId = res.data.result.message_id;
        } catch (imgErr: any) {
          // Don't fail the whole quiz post because of a bad image — just log
          // and continue with the text/poll.
          const tgDesc = imgErr.response?.data?.description ?? imgErr.message;
          this.logger.warn(`Q${q.question_id}: sendPhoto failed (${tgDesc}); proceeding without image`);
        }
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
      // db.markPosted already happened pre-publish (see above) — duplicate prevention
      await this.notifier.notifyPublished(channelId, pollMessageId);
      await this.publications.insert({
        channelId, messageId: pollMessageId,
        sourceUrl:    `pdr:${q.ticket_number}:q${q.question_num}`,
        title:        `PDR ticket ${q.ticket_number} q${q.question_num}`,
        strategyType: this.type,
        tags:         ['pdr-quiz'],
      });
      // Mirror only the question (+ optional image): the TG poll is interactive,
      // option buttons don't translate to Meta — answers are deliberately omitted.
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId: pollMessageId,
        mirror: { text: q.text, tags: [], imageUrl: q.image_url ?? undefined },
      });
      this.logger.log(`PDR quiz sent: ticket ${q.ticket_number} q${q.question_num} → ${channelId} [${expanded ? 'expanded' : 'normal'}]`);
    } catch (err: any) {
      const reason = this.describeError(err);
      this.logger.error(
        `PDR publish failed for ticket ${q.ticket_number} q${q.question_num}: ${reason}` +
        (err?.response?.data ? ` | tg: ${JSON.stringify(err.response.data)}` : '') +
        (err?.stack ? `\n${err.stack.split('\n').slice(0, 3).join('\n')}` : ''),
      );
      await this.notifier.notifyFailed(channelId, reason, `ticket ${q.ticket_number} q${q.question_num}`);
    }
  }

  /**
   * Extracts a meaningful description from any thrown value. Handles:
   * - Axios errors with Telegram description (HTTP 4xx/5xx from Bot API)
   * - Plain Error with message
   * - Validation libraries that throw arrays of errors
   * - Objects without message (POJOs, validation results)
   * - Anything else falling through — return a stringified preview.
   *
   * Critical: avoid returning empty strings / "[]" / "{}" which give zero
   * signal to the notification recipient. Always return something actionable.
   */
  private describeError(err: unknown): string {
    if (err == null) return 'unknown error (null/undefined)';
    if (typeof err === 'string') return err || 'unknown error (empty string)';

    const anyErr = err as any;

    // 1. Axios → Telegram Bot API errors. Examples:
    //    "Bad Request: chat not found", "Wrong padding length", "Too Many Requests"
    const tgDesc = anyErr.response?.data?.description;
    if (typeof tgDesc === 'string' && tgDesc.length > 0) {
      const code = anyErr.response.data.error_code;
      return code ? `tg ${code}: ${tgDesc}` : tgDesc;
    }

    // 2. Standard Error.message
    if (typeof anyErr.message === 'string' && anyErr.message.length > 0) {
      return anyErr.message;
    }

    // 3. Validation arrays (class-validator, joi, zod sometimes)
    if (Array.isArray(err)) {
      if (err.length === 0) return 'unknown error (empty array thrown)';
      const messages = err
        .map((e: any) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)))
        .filter(Boolean);
      return messages.join('; ').slice(0, 300) || 'validation error (no messages)';
    }

    // 4. Error code (network errors like ETIMEDOUT, ECONNREFUSED)
    if (typeof anyErr.code === 'string') return `code=${anyErr.code}`;

    // 5. Last-resort JSON dump — but reject empty {}
    const dumped = JSON.stringify(err);
    if (!dumped || dumped === '{}' || dumped === '[]') {
      return `non-serializable error (${typeof err}, keys: ${Object.keys(anyErr).join(',') || 'none'})`;
    }
    return dumped.slice(0, 300);
  }
}
