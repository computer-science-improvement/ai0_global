export interface RoiInput {
  avgViews:        number;
  subs:            number;
  engagementRate:  number;
  daysHistory:     number;
  postsCount:      number;
  viewToSubRate:   number;
}

export interface RoiResult {
  estimated_subs_per_ad: number;
  confidence:            'low' | 'medium' | 'high';
  basis:                 string;
  inputs:                { avg_views: number; subs: number; engagement_rate: number };
}

function engagementMultiplier(rate: number): number {
  if (rate < 0.01) return 0.5;
  if (rate > 0.05) return 1.5;
  return 1.0;
}

function confidenceLevel(daysHistory: number, postsCount: number): 'low' | 'medium' | 'high' {
  if (daysHistory >= 30 && postsCount >= 50) return 'high';
  if (daysHistory >= 14 && postsCount >= 20) return 'medium';
  return 'low';
}

export function estimateRoi(input: RoiInput): RoiResult {
  const mult     = engagementMultiplier(input.engagementRate);
  const estimate = Math.round(input.avgViews * input.viewToSubRate * mult);

  return {
    estimated_subs_per_ad: estimate,
    confidence:            confidenceLevel(input.daysHistory, input.postsCount),
    basis:                 `avg_views × view_to_sub_rate × engagement_multiplier (${mult})`,
    inputs: {
      avg_views:       input.avgViews,
      subs:            input.subs,
      engagement_rate: Number(input.engagementRate.toFixed(4)),
    },
  };
}
