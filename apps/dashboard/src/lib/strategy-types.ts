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
