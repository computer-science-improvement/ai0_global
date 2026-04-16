import { Skill } from '../ai/skills/skill.interface';

// ─── Strategy params (passed from config) ────────────────────────────────────

/**
 * Strategy-specific parameters defined in channels.json.
 * Each strategy type interprets its own params shape.
 */
export type StrategyParams = Record<string, unknown>;

// ─── Strategy interface ──────────────────────────────────────────────────────

/**
 * A content strategy is a reusable, parameterized content pipeline.
 *
 * Channels have NO logic — they are pure publish targets.
 * All content logic lives in strategies. A strategy receives `params`
 * from config, making the same strategy type reusable across channels
 * with different sources/settings.
 *
 * Example: an "rss" strategy accepts `{ feeds: [...], skills: [...] }`
 * and can power both a tech-news channel and a science-news channel.
 */
export interface ContentStrategy {
  /** Unique type name used in config (e.g. 'rss', 'on-this-day') */
  readonly type: string;

  /**
   * Return skills for the review step.
   * Params may reference skill names that the strategy resolves.
   */
  getSkills(params: StrategyParams): Skill[];

  /**
   * Fetch content from external source(s).
   * @param params    — strategy-specific config (feed URLs, API keys, etc.)
   * @param channelId — target channel (useful for dedup in multi-item strategies)
   */
  fetch(params: StrategyParams, channelId: string): Promise<StrategyFetchResult | null>;

  /**
   * Generate the post text from fetched data.
   * @param data   — the result from fetch()
   * @param params — same params for prompt selection, etc.
   */
  generate(
    data: StrategyFetchResult,
    params: StrategyParams,
  ): Promise<StrategyPost | 'SKIP_POST' | null>;

  /**
   * Optional: full pipeline control.
   * If implemented, the runner calls this instead of the standard
   * fetch → dedup → generate → review → publish pipeline.
   */
  execute?(channelId: string, params: StrategyParams): Promise<void>;
}

// ─── Data types ──────────────────────────────────────────────────────────────

export interface StrategyFetchResult {
  /** URL used for dedup */
  sourceUrl: string;
  /** Human-readable title for logging / dedup */
  title: string;
  /** Content type tag (e.g. 'history', 'news', 'quote') */
  contentType: string;
  /** Strategy-specific payload — passed back to generate() */
  data: unknown;
}

export interface StrategyPost {
  text: string;
  imageUrl?: string;
  sourceUrl: string;
  title: string;
  contentType: string;
}

// ─── Config shape ────────────────────────────────────────────────────────────

/** One strategy instance in channels.json → strategies[] */
export interface StrategyConfigEntry {
  /** Human-readable id for logging / cron name */
  id: string;
  /** Strategy type (must match a registered ContentStrategy.type) */
  type: string;
  /** Target channel id */
  channelId: string;
  /** Cron expression */
  schedule?: string;
  /** Delay between posts in minutes */
  postDelayMinutes?: number;
  /** Strategy-specific parameters */
  params?: StrategyParams;
}
