import type { EditorCard } from '../card';
import { activeStoriesBlock, coveringStory } from './story-context';
import type { StoryRegistry } from './story.repository';

/**
 * Spec 037 T2: the registry as the prompts and fetch_feed read it — the "Active stories (14 days)" block of the
 * planner and writer prompts and the feed items an active story covers. Errors stay out of the run (callers catch).
 */
export class StoryContextService {
  constructor(private readonly reg: Pick<StoryRegistry, 'activeStories'>) {}

  async activeBlock(card: Pick<EditorCard, 'channelKey' | 'timezone'>, role: 'planner' | 'executor', now: Date): Promise<string | null> {
    return activeStoriesBlock(await this.reg.activeStories(card.channelKey, now), { timezone: card.timezone, now, role });
  }

  async coveredBy(channelKey: string, items: Array<{ title?: string | null; snippet?: string | null }>, now: Date): Promise<Array<string | null>> {
    if (!items.length) return [];
    const stories = await this.reg.activeStories(channelKey, now);
    return items.map((it) => (stories.length ? coveringStory(it, stories) : null));
  }
}
