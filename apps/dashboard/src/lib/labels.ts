// apps/dashboard/src/lib/labels.ts
//
// One source of truth for every short status label rendered in the UI.
// Pair each label with a sentence (or two) explaining what it means.
// Components read these via `title=` on the chip / element so the
// browser shows a tooltip on hover. Cheap, accessible, no extra deps.

// ─── Poll tier ──────────────────────────────────────────────────────────
//
// How often the tracker fetches fresh stats from a channel. Set by
// TierClassifier based on subs growth + view velocity over recent
// snapshots.
export const POLL_TIER_HELP: Record<'hot' | 'warm' | 'cold', string> = {
  hot:  'Polled every few minutes. Channels that publish often or grow fast — fresh stats matter.',
  warm: 'Default. Polled on the regular cadence. Stable channels with normal cadence.',
  cold: 'Polled rarely. Dormant or low-velocity channels — saves API quota.',
};

// ─── Strategy enabled / paused ─────────────────────────────────────────
export const STRATEGY_STATUS_HELP: Record<'enabled' | 'paused', string> = {
  enabled: 'Cron is registered for this strategy. It will fire at its next scheduled minute.',
  paused:  'Cron is NOT registered. The strategy stays configured but won\'t fire until you enable it.',
};

// ─── Strategy run status ───────────────────────────────────────────────
export const RUN_STATUS_HELP: Record<'ok' | 'error' | 'skipped' | 'running', string> = {
  ok:      'Strategy ran to completion and published.',
  error:   'Strategy threw. Hover the row for the message; most-recent error is also stored.',
  skipped: 'Cron fired but the previous tick of the same strategy was still running. We skipped to avoid double-publishing.',
  running: 'Currently executing. AI generation can take 30–90s.',
};

// ─── Strategy role on a channel ────────────────────────────────────────
//
// A strategy binds to ONE channel directly (primary), but its content
// can fan out to other channels via forward routes (forward).
export const STRATEGY_ROLE_HELP: Record<'primary' | 'forward', string> = {
  primary: 'Strategy fires directly into this channel — the binding target.',
  forward: 'Strategy fires into a different channel that forward-routes its content here. Content is duplicated, not regenerated.',
};

// ─── Channel kind ──────────────────────────────────────────────────────
export const CHANNEL_KIND_HELP: Record<'public' | 'private', string> = {
  public:  'Public channel — addressed by @username. Tracker polls via the regular Telegram API.',
  private: 'Private channel — addressed by numeric -100… chat id. Tracker needs the bot to be a member; some signals (subscriber count) unavailable.',
};

// ─── Channel flags ─────────────────────────────────────────────────────
export const CHANNEL_FLAG_HELP = {
  mine:   'One of your own channels. Strategies publish here; can be edited.',
  closed: 'Channel was unreachable on the last poll — likely banned, private, or renamed. Polling backs off.',
} as const;

// ─── Bot status ────────────────────────────────────────────────────────
export const BOT_STATUS_HELP = {
  verified:   'getMe succeeded against the Telegram API — token works.',
  unverified: 'Never verified. Click Verify to run getMe and confirm the token is alive.',
  inactive:   'Bot is configured but marked inactive — no channels will publish through it.',
  error:      'Last verification attempt failed. Hover the chip for the redacted error message.',
} as const;

// ─── Forward role (UI side helper) ─────────────────────────────────────
export const FORWARD_ROLE_HELP: Record<'primary' | 'forward', string> = STRATEGY_ROLE_HELP;

// ─── Strategy types ────────────────────────────────────────────────────
//
// What each strategy DOES — short description + data source. Shown as
// hover-tooltips on the type chip, and inline as a hint in the add/edit
// modals. Keys must match the registered type slugs in
// `apps/automation/src/common/content-strategy/content-strategy.registry.ts`.

export interface StrategyTypeMeta {
  title:        string;
  source:       'db' | 'rss' | 'api' | 'multi';
  description:  string;
}

export const STRATEGY_DESCRIPTIONS: Record<string, StrategyTypeMeta> = {
  'quotes': {
    title:       'Quotes',
    source:      'db',
    description: 'Inspirational quotes pulled from the `quotes` table. Posts one un-published quote per fire. Tracked per-channel so the same quote is never repeated on the same channel.',
  },
  'facts': {
    title:       'Facts (faktypro)',
    source:      'db',
    description: 'Curated interesting facts loaded from faktypro.com.ua into the `facts` table. Posts one un-published fact per fire; includes article image + URL.',
  },
  'birthday-strategy': {
    title:       'Birthdays',
    source:      'db',
    description: 'For each fire, picks notable people whose birthday is today from the `birthdays` table. Enriches with Wikipedia extract + image and publishes a short biography.',
  },
  'on-this-day': {
    title:       'On this day',
    source:      'api',
    description: 'Historical events for today\'s date fetched from the Byabbe API at runtime. No DB cache — fresh every fire.',
  },
  'daily-photo': {
    title:       'NASA APOD',
    source:      'api',
    description: 'Astronomy Picture of the Day fetched from NASA APOD at fire time. One photo per day, with explanation and copyright.',
  },
  'ai0-prompts': {
    title:       'AI prompts',
    source:      'db',
    description: 'Curated AI prompts scraped from PromptHero into the `prompts` table. Posts one un-published prompt per fire.',
  },
  'pdr-quiz': {
    title:       'PDR quiz',
    source:      'db',
    description: 'Ukrainian driving-license quiz questions from the `pdr_questions` table. Posts one question with multiple choices (Telegram poll) per fire.',
  },
  'assets': {
    title:       'Assets',
    source:      'db',
    description: 'Reads from the `assets` table filtered by `params.dataSource` (academy-openai / mcpservers / prompts-md). Posts one un-published asset per fire with a configurable poster image.',
  },
  'recipes': {
    title:       'Recipes',
    source:      'api',
    description: 'Random recipe fetched from MealDB at fire time. Translated + reformatted via Claude for the Ukrainian audience.',
  },
  'movies': {
    title:       'Movies',
    source:      'api',
    description: 'Trending movies / TV from TMDB API. Dedup tracked so the same release isn\'t re-posted to the same channel.',
  },
  'space-news': {
    title:       'Space news',
    source:      'api',
    description: 'Space industry news from the SpaceNews API. Dedup tracked per channel.',
  },
  'ua-news': {
    title:       'RSS news (Ukrainian)',
    source:      'rss',
    description: 'Generic RSS-driven Ukrainian-news strategy. `params.feedUrl` picks the source; `params.tags` decorate the published post. Same fetcher feeds multiple channels with different feeds.',
  },
  'ai0-news': {
    title:       'ai0 news (multi-source)',
    source:      'multi',
    description: 'Aggregates multiple RSS + HTTP sources defined in `/config/sources/ai0-news.json`. Filters, dedups, then publishes one digest item per fire to the bound channel.',
  },
  'game-channel': {
    title:       'Game channel',
    source:      'multi',
    description: 'Mixes giveaways (GamerPower), deals (Epic / Steam) and news per a fair-mix rotation. `params.sources` picks which sub-feeds are active. Dedup tracked per channel.',
  },
};

/** Helper — null when the type slug isn\'t in the map. */
export function describeStrategy(type: string): StrategyTypeMeta | null {
  return STRATEGY_DESCRIPTIONS[type] ?? null;
}

/** Compact source-kind label for chip rendering. */
export const SOURCE_KIND_LABEL: Record<StrategyTypeMeta['source'], string> = {
  db:    'DB table',
  rss:   'RSS feed',
  api:   'live API',
  multi: 'multi-source',
};

// ─── Channel labels ────────────────────────────────────────────────────
//
// Where the UI needs a friendly identifier for a channel — dropdown
// options, breadcrumbs, target-channel labels — these helpers return
// strings that are readable (never a UUID) and unambiguous (the chat id
// or @handle is included so two same-titled channels are distinguishable).

interface ChannelLike {
  id:           string;
  title?:       string | null;
  username?:    string | null;
  channelKey?:  string | null;
  tgChatId?:    string | null;
  kind?:        string | null;
}

/** "Best" display name. Title → @username → channelKey → tgChatId. */
export function channelDisplayName(c: ChannelLike): string {
  return (
    c.title?.trim()
    || (c.username ? `@${c.username}` : null)
    || c.channelKey
    || c.tgChatId
    || '(unnamed channel)'
  );
}

/**
 * Real Telegram identifier — the address publishers use to reach the
 * channel. For private channels that's the numeric chat id; for public
 * channels it's the @username (or channelKey when @username is missing).
 * Null when the channel has neither yet.
 */
export function channelTgId(c: ChannelLike): string | null {
  if (c.kind === 'private') return c.tgChatId ?? null;
  if (c.username)           return `@${c.username}`;
  return c.channelKey ?? null;
}

/**
 * Dropdown-style label: "Title — @username" or "Title — -100…", with the
 * tg id omitted when it would duplicate the title. Never returns the
 * UUID.
 */
export function channelOptionLabel(c: ChannelLike): string {
  const name = channelDisplayName(c);
  const tg   = channelTgId(c);
  if (!tg || tg === name) return name;
  return `${name} — ${tg}`;
}
