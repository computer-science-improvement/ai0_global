import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContentStrategyRegistry }          from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }                from '../../publishers/telegram.publisher';
import { TelegramNotifier }                 from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }           from '../../stats/publications.repository';
import { CrossPostService } from '../../publishers/cross-post.service';
import { ClaudeAgent }                      from '../../common/ai/agents/claude.agent';
import { ReviewAgent }                      from '../../common/ai/agents/review.agent';
import { PostValidator }                    from '../../common/ai/validators/post.validator';
import { WikipediaService }                 from '../../integrations/wikipedia/wikipedia.service';
import { MotivationBiographyRepository }   from './motivation-biography.repository';
import { BIRTHDAY_STORY_CHANNEL_SKILL }    from '../../common/ai/skills/birthday-story-channel.skill';
import {
  BIRTHDAY_STORY_PROMPT,
  buildBirthdayUserMessage,
} from '../../common/ai/prompts/birthday-story.prompts';
import {
  ContentStrategy,
  StrategyFetchResult,
  StrategyPost,
  StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { Skill } from '../../common/ai/skills/skill.interface';

@Injectable()
export class MotivationBiographyStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(MotivationBiographyStrategy.name);

  readonly type = 'birthday-strategy';

  constructor(
    private readonly registry:  ContentStrategyRegistry,
    private readonly db:        MotivationBiographyRepository,
    private readonly wikipedia: WikipediaService,
    private readonly claude:    ClaudeAgent,
    private readonly reviewer:  ReviewAgent,
    private readonly validator: PostValidator,
    private readonly telegram:  TelegramPublisher,
    private readonly notifier:  TelegramNotifier,
    private readonly publications: PublicationsRepository,
    private readonly crossPost: CrossPostService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] { return []; }

  async fetch(_p: StrategyParams, _c: string): Promise<StrategyFetchResult | null> { return null; }

  async generate(_d: StrategyFetchResult, _p: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const person = await this.db.getToday(channelId);

    if (!person) {
      this.logger.debug('No unposted birthdays for today');
      return;
    }

    const wiki = await this.wikipedia.getSummary(person.name);

    if (!wiki || !wiki.extract) {
      this.logger.warn(`No Wikipedia data for "${person.name}" — skipping`);
      await this.db.markPosted(person.id, channelId);
      return;
    }

    const userMessage = buildBirthdayUserMessage({
      name:        person.name,
      month:       person.month,
      day:         person.day,
      year:        person.year,
      description: wiki.description,
      extract:     wiki.extract,
    });

    const draft = await this.claude.chat([
      { role: 'system', content: BIRTHDAY_STORY_PROMPT.system },
      { role: 'user',   content: userMessage },
    ]);

    if (!draft || draft.trim() === 'SKIP_POST') {
      this.logger.warn(`Claude returned no content for "${person.name}"`);
      return;
    }

    const reviewed = await this.reviewer.review(draft, [BIRTHDAY_STORY_CHANNEL_SKILL]);
    const channelHandle = channelId.startsWith('@') ? channelId.slice(1) : channelId;
    const text = `${reviewed}\n\n#біографія\n\n<a href="https://t.me/${channelHandle}">Мотивація</a>`;

    try {
      const messageId = await this.telegram.publish(
        {
          text,
          imageUrl: wiki.imageUrl ?? undefined,
          source:   wiki.pageUrl,
          title:    person.name,
          tags:     [],
        },
        { id: channelId },
      );
      await this.db.markPosted(person.id, channelId);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    wiki.pageUrl,
        title:        person.name,
        strategyType: this.type,
      });
      await this.crossPost.afterPublish({
        channelKey: channelId,
        messageId,
        mirror: { text, tags: [], imageUrl: wiki.imageUrl ?? undefined },
      });
      this.logger.log(`Biography published: "${person.name}" → ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Publish failed: ${err.message}`);
    }
  }
}
