import { Injectable } from '@nestjs/common';
import { RecipesRepository } from '../../strategies/recipes/recipes.repository';
import { QuotesRepository } from '../../strategies/quotes/quotes.repository';
import { FactsRepository } from '../../strategies/facts/facts.repository';
import { CuratedPromptsRepository } from '../../strategies/curated-prompts/curated-prompts.repository';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { PdrQuizRepository } from '../../strategies/pdr-quiz/pdr-quiz.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';

/** Default low-content alert threshold (posts) when a binding has no override. */
export const LOW_CONTENT_DEFAULT = 100;

type Counter = (channelKey: string | null, params: Record<string, unknown>) => Promise<number | null>;

/**
 * Computes the remaining unpublished content ("runway") for finite-pool
 * strategies. RSA/live strategies aren't registered → remainingFor returns
 * null. Each counter mirrors its repository's getNext eligibility predicate.
 * The channel key is the same value the runner passes to execute() (the
 * channel_key, used as the `posted` JSONB key).
 */
@Injectable()
export class ContentRunwayService {
  private readonly counters: Record<string, Counter>;

  constructor(
    private readonly recipes: RecipesRepository,
    private readonly quotes: QuotesRepository,
    private readonly facts: FactsRepository,
    private readonly curated: CuratedPromptsRepository,
    private readonly ai0Prompts: PromptsRepository,
    private readonly pdr: PdrQuizRepository,
    private readonly birthdays: MotivationBiographyRepository,
    private readonly assets: AssetsRepository,
  ) {
    // Wrap channel-keyed counters so a missing key yields null (can't count).
    const needKey =
      (fn: (key: string, params: Record<string, unknown>) => Promise<number>): Counter =>
      (key, params) => (key ? fn(key, params) : Promise.resolve(null));

    this.counters = {
      recipes:                () => this.recipes.countEligible(),
      'curated-prompts':      (_key, p) => this.curated.countEligible({ provider: p.provider as string | undefined, mediaType: p.mediaType as string | undefined }),
      'ai0-prompts':          (_key, p) => this.ai0Prompts.countEligible((p.category as string) ?? ''),
      quotes:                 needKey((key, p) => this.quotes.countEligible(key, p.category as string | undefined)),
      facts:                  needKey((key) => this.facts.countEligible(key)),
      'pdr-quiz':             needKey((key) => this.pdr.countEligible(key)),
      'motivation-biography': needKey((key) => this.birthdays.countEligible(key)),
      assets:                 needKey((key, p) => this.assets.countEligible((p.dataSource as string) ?? '', key)),
    };
  }

  /** Remaining unpublished posts, or null for non-finite-pool types / errors. */
  async remainingFor(type: string, channelKey: string | null, params: Record<string, unknown>): Promise<number | null> {
    const counter = this.counters[type];
    if (!counter) return null;
    try {
      return await counter(channelKey, params ?? {});
    } catch {
      return null; // a count failure must never break the strategies list
    }
  }

  /** Effective threshold: the binding override, else the default. */
  effectiveThreshold(stored: number | null | undefined): number {
    return stored ?? LOW_CONTENT_DEFAULT;
  }
}
