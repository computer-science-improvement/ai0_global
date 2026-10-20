/**
 * Feature taxonomy of the LLM usage ledger (spec 029 FR-004). Every row of
 * llm_usage carries one of these in `feature`; budgets match them by prefix.
 */

/**
 * Roles of the editor harness that make LLM calls (`editor.<role>`), plus `preview`: the executor run of an
 * owner's on-demand dry-run slot preview (spec 034 FR-012).
 */
export const EDITOR_FEATURE_ROLES = [
  'planner', 'executor', 'reviewer', 'checker', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder', 'onboarder', 'steering', 'launch', 'chat', 'preview',
] as const;

export const FEATURES = {
  unattributed:        'unattributed',
  recipesTranslate:    'strategy.recipes.translate',
  topicDigestRewrite:  'strategy.topic_digest.rewrite',
  reviewPost:          'review.post',
  dmTriage:            'dm.triage',
  dmClassify:          'dm.classify',
  trackingRoi:         'tracking.roi',
  dedupNovelty:        'dedup.novelty',
  routingTopic:        'routing.topic',
  logsAnalyze:         'logs.analyze',
  textSummarize:       'text.summarize',
  textFormat:          'text.format',
} as const;

export type FixedFeature = typeof FEATURES[keyof typeof FEATURES];

export const editorFeature   = (role: string): string => `editor.${role}`;
/**
 * Owner chat turns (spec 040 FR-001): `editor.chat.<role>`. Their own budget pool (llm_budgets `editor.chat`), outside the
 * agents' production cap (`editor.`), so a long conversation never stops scheduled posts. Bare `editor.chat` is the legacy id.
 */
export const CHAT_FEATURE_PREFIX = 'editor.chat';
export const chatFeature     = (role: string): string => `${CHAT_FEATURE_PREFIX}.${role}`;
export const isChatFeature   = (f: string | null | undefined): boolean =>
  !!f && (f === CHAT_FEATURE_PREFIX || f.startsWith(`${CHAT_FEATURE_PREFIX}.`));
/** A strategy binding's generation (`ext_id` = the binding id). */
export const strategyFeature = (extId: string): string => `strategy.${extId}.generate`;
export const toolFeature     = (name: string): string => `tool.${name}`;

/** resource_ref values: `telegram:<channel_key>`, `meta:<id>`, `tiktok:<id>`, `strategy:<id>`. */
export const telegramResource = (channelKey: string): string => `telegram:${channelKey}`;
export const strategyResource = (extId: string): string => `strategy:${extId}`;

const FIXED = new Set<string>(Object.values(FEATURES));
const SEGMENT = /^[a-z0-9_@-]+$/i;

/** True for a feature this registry knows (fixed ids and the parametrised families). */
export function isKnownFeature(f: string): boolean {
  if (FIXED.has(f)) return true;
  const parts = f.split('.');
  if (parts[0] === 'editor' && parts[1] === 'chat' && parts.length === 3) return (EDITOR_FEATURE_ROLES as readonly string[]).includes(parts[2]);
  if (parts[0] === 'editor') return parts.length === 2 && (EDITOR_FEATURE_ROLES as readonly string[]).includes(parts[1]);
  if (parts[0] === 'tool') return parts.length === 2 && SEGMENT.test(parts[1]);
  if (parts[0] === 'strategy') return parts.length === 3 && SEGMENT.test(parts[1]) && parts[2] === 'generate';
  return false;
}
