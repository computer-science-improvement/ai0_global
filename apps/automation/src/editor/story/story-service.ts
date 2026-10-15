import type { EditorCard } from '../card';
import { activeStoriesBlock, coveringStory } from './story-context';
import { recapNeededBlock } from './story-event';
import type { StoryRegistry } from './story.repository';

/**
 * Spec 037 T2: the registry as the prompts and fetch_feed read it — the "Active stories (14 days)" block of the
 * planner and writer prompts and the feed items an active story covers. Errors stay out of the run (callers catch).
 */
export class StoryContextService {
  constructor(private readonly reg: Pick<StoryRegistry, 'activeStories'> & Partial<Pick<StoryRegistry, 'recapItems'>>) {}

  /** Spec 037 T3: the "recap needed" block (announced events without a post after them) goes first, then the active stories. */
  async activeBlock(card: Pick<EditorCard, 'channelKey' | 'timezone'>, role: 'planner' | 'executor', now: Date): Promise<string | null> {
    const [stories, recap] = await Promise.all([
      this.reg.activeStories(card.channelKey, now),
      this.reg.recapItems ? this.reg.recapItems(card.channelKey, now).catch(() => []) : Promise.resolve([]),
    ]);
    const blocks = [recapNeededBlock(recap, { timezone: card.timezone, role }), activeStoriesBlock(stories, { timezone: card.timezone, now, role })].filter(Boolean);
    return blocks.length ? blocks.join('\n\n') : null;
  }

  async coveredBy(channelKey: string, items: Array<{ title?: string | null; snippet?: string | null }>, now: Date): Promise<Array<string | null>> {
    if (!items.length) return [];
    const stories = await this.reg.activeStories(channelKey, now);
    return items.map((it) => (stories.length ? coveringStory(it, stories) : null));
  }
}
