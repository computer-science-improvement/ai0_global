// apps/automation/src/discovery/recommendations/recommendations.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { CandidateChannelsRepository } from '../repositories/candidate-channels.repository';
import { ChannelThemesRepository } from '../repositories/channel-themes.repository';
import {
  RecommendInput,
  RecommendOutput,
  RecommendationItem,
} from './recommendations.types';

/** Set-based Jaccard similarity. Inputs deduplicated; case-sensitive. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

export function scoreCandidate(
  target: { themes?: string[] },
  candidate: { themes?: string[] },
): number {
  return jaccardSimilarity(target.themes ?? [], candidate.themes ?? []);
}

@Injectable()
export class RecommendationsService {
  constructor(
    private readonly candidates: CandidateChannelsRepository,
    private readonly themes: ChannelThemesRepository,
  ) {}

  async recommend(input: RecommendInput): Promise<RecommendOutput> {
    const targetThemes = await this.themes.getThemes(input.targetChannelId);
    if (targetThemes === null) {
      throw new NotFoundException(`Target channel ${input.targetChannelId} not found`);
    }
    if (targetThemes.length === 0) {
      return {
        recommendations: [],
        targetThemes: [],
        warning: 'Set themes on the target channel first',
      };
    }

    const excludeOwnedUsernames =
      input.excludeAlreadyTracked === false
        ? []
        : await this.themes.listMyUsernames();

    const rows = await this.candidates.candidatesForBudgetAndThemes({
      targetThemes,
      budget: input.budget,
      excludeOwnedUsernames,
      limit: 500,
    });

    const targetSet = new Set(targetThemes);
    const scored: RecommendationItem[] = rows.map(r => {
      const matched = r.themes.filter(t => targetSet.has(t));
      const score = scoreCandidate({ themes: targetThemes }, { themes: r.themes });
      return {
        id: r.id,
        slug: r.slug,
        link: r.link,
        title: r.title,
        description: r.description,
        themes: r.themes,
        matchedThemes: matched,
        score,
        estimatedSubsPerAd: r.estimated_subs_per_ad ?? null,
        roiConfidence: r.roi_confidence ?? null,
        priceMin: r.price_min!,
        priceMax: r.price_max,
        sexRatio: r.sex_ratio,
        avatarUrl: r.avatar_url,
        language: r.language,
        source: r.source,
      };
    });

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ra = a.estimatedSubsPerAd ?? -1;
      const rb = b.estimatedSubsPerAd ?? -1;
      if (ra !== rb) return rb - ra;
      return a.priceMin - b.priceMin;
    });

    const limit = input.limit ?? 20;
    return {
      recommendations: scored.slice(0, limit),
      targetThemes,
    };
  }
}
