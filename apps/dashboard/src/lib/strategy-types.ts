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

// ── Binding defaults ───────────────────────────────────────────────────────
// Schedule pre-filled in the new-strategy form when a type is picked. Cron is
// evaluated in Europe/Kyiv by the scheduler (SCHEDULER_TZ).
//   Digests: every 10 min, 19:00–20:50. A single 19:00 tick loses the day when
//   the channel's 20-min posting cooldown is active at that minute; the
//   date-keyed dedup sentinel makes every later tick a no-op once one lands.
//   Mirrors DIGEST_RETRY_SCHEDULE in automation's digest-format.util.ts.
export const DEFAULT_SCHEDULE_BY_TYPE: Record<string, string> = {
  'network-digest': '*/10 19-20 * * *',
  'topic-digest':   '*/10 19-20 * * *',
};

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
