import type { StrategyTypeInfo } from '../api/strategies';

/** Strategy types whose supportedPlatforms include `platform`. `null` → none
 *  (no destination chosen yet → the Type list is empty/disabled). */
export function strategyTypesForPlatform(
  types: StrategyTypeInfo[] | undefined,
  platform: string | null,
): StrategyTypeInfo[] {
  if (!types || !platform) return [];
  return types.filter(t => t.supportedPlatforms.includes(platform));
}

// ── Type select grouping ───────────────────────────────────────────────────
// Taxonomy for the Type <select> optgroups. Unmapped types fall into 'other'.
//   rss    — pulled from news feeds (RSS/feed aggregators)
//   source — republished from a dataset as-is (no AI transform)
//   ai     — content generated / transformed with AI
//   other  — everything else
export type StrategyCategory = 'rss' | 'source' | 'ai' | 'other';

const STRATEGY_CATEGORY: Record<string, StrategyCategory> = {
  // RSS / news feeds
  'ai0-news': 'rss', 'ua-news': 'rss', 'space-news': 'rss',
  // Source — republished as-is from a dataset
  'quotes': 'source', 'facts': 'source', 'pdr-quiz': 'source',
  'curated-prompts': 'source', 'ai0-prompts': 'source',
  // AI — generated / transformed with AI
  'recipes': 'ai', 'on-this-day': 'ai', 'daily-photo': 'ai', 'movies': 'ai',
  'birthday-strategy': 'ai', 'assets': 'ai', 'game-channel': 'ai',
  // Other
  'recipe-carousel': 'other',
};

const CATEGORY_ORDER: ReadonlyArray<{ key: StrategyCategory; label: string }> = [
  { key: 'rss',    label: 'RSS' },
  { key: 'source', label: 'Source' },
  { key: 'ai',     label: 'AI' },
  { key: 'other',  label: 'Other' },
];

export function categoryOf(type: string): StrategyCategory {
  return STRATEGY_CATEGORY[type] ?? 'other';
}

export interface StrategyTypeGroup { key: StrategyCategory; label: string; types: StrategyTypeInfo[]; }

/** Group platform-filtered types into ordered, non-empty category groups for the select. */
export function groupStrategyTypes(types: StrategyTypeInfo[]): StrategyTypeGroup[] {
  return CATEGORY_ORDER
    .map(c => ({ ...c, types: types.filter(t => categoryOf(t.type) === c.key) }))
    .filter(g => g.types.length > 0);
}
