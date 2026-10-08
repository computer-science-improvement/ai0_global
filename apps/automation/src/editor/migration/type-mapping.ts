import type { Platform } from '../agents/agent.types';
import { implementedFormats } from '../platform/capabilities';
import type { SeriesSource, SeriesSourceCatalog } from '../network/series';

/**
 * Strategy type → series format and source (spec 023 FR-011). Deterministic. The generic format is the
 * Telegram one; a Meta / TikTok destination gets the platform's native format. The brief is agent
 * instruction (Ukrainian, like every series brief); warnings and reasons are English (the owner reads them).
 */

export type GenericFormat = 'text' | 'photo' | 'quiz' | 'carousel';

export interface TypeRule {
  format:   GenericFormat;
  /** The series source, from the binding's params; null = no source (the agent picks). */
  source:   (params: Record<string, unknown>) => { source: SeriesSource | null; warnings: string[] };
  mode?:    'suggested' | 'required';
  /** Digest strategies poll until they post once a day: their cron is a retry loop. */
  retryLoop?: boolean;
  brief:    (params: Record<string, unknown>) => string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const lib = (table: string, extra: Partial<Extract<SeriesSource, { kind: 'library' }>> = {}): SeriesSource => ({ kind: 'library', table, ...extra });

/** Adapter names of game-channel's `sources` param. */
const GAME_SOURCES: Record<string, string> = { gamerpower: 'gamerpower_giveaways', epic: 'epic_free_games', steam: 'steam_deals' };

function feedSource(params: Record<string, unknown>, type: string): { source: SeriesSource | null; warnings: string[] } {
  const url = str(params.feedUrl);
  if (url) return { source: { kind: 'feed', ref: url }, warnings: [] };
  return { source: null, warnings: [`${type} reads its own source list (config/sources); add its feeds to the channel card's sources, then give the series a feed source`] };
}

export const TYPE_RULES: Record<string, TypeRule> = {
  'quotes': {
    format: 'text', source: (p) => ({ source: lib('quotes', str(p.category) ? { category: str(p.category) } : {}), warnings: [] }),
    brief: () => 'Цитата з бібліотеки з коротким контекстом автора (мігровано зі стратегії quotes).',
  },
  'facts': {
    format: 'photo', source: () => ({ source: lib('facts'), warnings: [] }),
    brief: () => 'Цікавий факт із бібліотеки з ілюстрацією (мігровано зі стратегії facts).',
  },
  'pdr-quiz': {
    format: 'quiz', mode: 'required', source: () => ({ source: lib('pdr_questions'), warnings: [] }),
    brief: () => 'Вікторина з питання ПДР із бібліотеки: питання, варіанти, правильна відповідь і пояснення (мігровано зі стратегії pdr-quiz).',
  },
  'recipes': {
    format: 'photo', source: () => ({ source: lib('recipes'), warnings: [] }),
    brief: () => 'Рецепт із бібліотеки: фото страви, коротко й апетитно, інгредієнти й кроки (мігровано зі стратегії recipes).',
  },
  'recipe-carousel': {
    format: 'carousel', source: () => ({ source: lib('recipes'), warnings: [] }),
    brief: () => 'Рецепт із бібліотеки каруселлю: обкладинка, інгредієнти, кроки (мігровано зі стратегії recipe-carousel).',
  },
  'ai0-prompts': {
    format: 'photo', source: (p) => promptSource(p),
    brief: () => 'Промпт із бібліотеки з прикладом результату (мігровано зі стратегії ai0-prompts).',
  },
  'curated-prompts': {
    format: 'photo', source: (p) => promptSource(p),
    brief: () => 'Добірний промпт із бібліотеки з прикладом результату (мігровано зі стратегії curated-prompts).',
  },
  'assets': {
    format: 'text', source: (p) => ({ source: lib('assets', str(p.dataSource) ? { category: str(p.dataSource) } : {}), warnings: [] }),
    brief: (p) => `Корисний ресурс із бібліотеки${str(p.dataSource) ? ` (${str(p.dataSource)})` : ''}${str(p.tag) ? `, тег ${str(p.tag)}` : ''} (мігровано зі стратегії assets).`,
  },
  'birthday-strategy': {
    format: 'photo', source: () => ({ source: lib('birthdays', { today_only: true }), warnings: [] }),
    brief: () => 'Історія людини, що народилася цього дня, з бібліотеки днів народження (мігровано зі стратегії birthday-strategy).',
  },
  'on-this-day': {
    format: 'photo', source: () => ({ source: lib('on_this_day', { today_only: true }), warnings: [] }),
    brief: () => 'Подія, що сталася цього дня в історії, з бібліотеки (мігровано зі стратегії on-this-day).',
  },
  'ai0-news': {
    format: 'photo', source: (p) => feedSource(p, 'ai0-news'),
    brief: () => 'Свіжа новина зі стрічок каналу: суть, чому це важливо, посилання на джерело (мігровано зі стратегії ai0-news).',
  },
  'ua-news': {
    format: 'photo', source: (p) => feedSource(p, 'ua-news'),
    brief: (p) => `Свіжа новина зі стрічки${str(p.sourceName) ? ` ${str(p.sourceName)}` : ''}: суть, чому це важливо, посилання на джерело (мігровано зі стратегії ua-news).${str(p.feedUrl) ? ` Стрічка: ${str(p.feedUrl)}` : ''}`,
  },
  'game-channel': {
    format: 'photo',
    source: (p) => {
      const wanted = Array.isArray(p.sources) ? (p.sources as unknown[]).map(String) : [];
      const apis = [...new Set(wanted.map((s) => GAME_SOURCES[s]).filter(Boolean))];
      if (apis.length === 1) return { source: { kind: 'api', source: apis[0], params: {} }, warnings: [] };
      return {
        source: { kind: 'api', source: apis[0] ?? 'gamerpower_giveaways', params: {} },
        warnings: [`game-channel reads ${apis.length ? apis.join(', ') : 'several sources'}; the series names one (suggested, the agent may use the others)`],
      };
    },
    brief: () => 'Ігрова новина або роздача (безкоштовні ігри, знижки) з посиланням (мігровано зі стратегії game-channel).',
  },
  'space-news': {
    format: 'photo', source: () => ({ source: { kind: 'api', source: 'spaceflight_news', params: {} }, warnings: [] }),
    brief: () => 'Новина про космос зі Spaceflight News: суть і чому це важливо (мігровано зі стратегії space-news).',
  },
  'daily-photo': {
    format: 'photo', source: () => ({ source: { kind: 'api', source: 'nasa_apod', params: {} }, warnings: [] }),
    brief: () => 'Астрономічне фото дня NASA з поясненням (мігровано зі стратегії daily-photo).',
  },
  'movies': {
    format: 'photo', source: () => ({ source: { kind: 'api', source: 'tmdb_trending', params: {} }, warnings: [] }),
    brief: () => 'Фільм або серіал із трендів TMDB: про що він і для кого (мігровано зі стратегії movies).',
  },
  'network-digest': {
    format: 'text', retryLoop: true, source: () => ({ source: { kind: 'network_highlights', scope: 'network' }, warnings: [] }),
    brief: () => 'Дайджест дня: найкращі пости мережі за добу з посиланнями (мігровано зі стратегії network-digest).',
  },
  'topic-digest': {
    format: 'text', retryLoop: true,
    source: () => ({ source: { kind: 'network_highlights', scope: 'network' }, warnings: [] }),
    brief: (p) => `Тематичний дайджест дня з постів мережі${Array.isArray(p.strategyTypes) && p.strategyTypes.length ? ` (${(p.strategyTypes as unknown[]).map(String).join(', ')})` : ''} з посиланнями (мігровано зі стратегії topic-digest).`,
  },
};

/**
 * Spec 034 FR-014: the resource tone skill (editor-skills/tone-*.md, ported from the legacy channel-* skill the
 * strategy wrote with) that a migration attaches to the agent. Types without a channel skill have none.
 */
export const TONE_SKILL_BY_TYPE: Readonly<Record<string, string>> = {
  'ai0-news':          'tone-ai0-news',
  'ua-news':           'tone-ua-news',
  'space-news':        'tone-space',
  'daily-photo':       'tone-daily-photo',
  'game-channel':      'tone-gaming',
  'movies':            'tone-movies',
  'on-this-day':       'tone-on-this-day',
  'recipes':           'tone-recipes',
  'recipe-carousel':   'tone-recipes',
  'birthday-strategy': 'tone-birthday-story',
};

/** The tone skills of the mapped bindings (deduplicated, in binding order). */
export function toneSkillsFor(types: string[]): string[] {
  return [...new Set(types.map((t) => TONE_SKILL_BY_TYPE[t]).filter((n): n is string => !!n))];
}

function promptSource(p: Record<string, unknown>): { source: SeriesSource | null; warnings: string[] } {
  const category = str(p.provider) ?? str(p.mediaType);
  return { source: lib('prompts', category ? { category } : {}), warnings: [] };
}

/** The native format of a generic one on a platform; null when the platform has none. */
const NATIVE: Record<Exclude<Platform, 'telegram' | 'youtube'>, Partial<Record<GenericFormat, string>>> = {
  instagram: { photo: 'ig_photo', carousel: 'ig_carousel' },
  facebook:  { text: 'fb_text', photo: 'fb_photo', carousel: 'fb_album' },
  threads:   { text: 'th_text', photo: 'th_image', carousel: 'th_carousel' },
  tiktok:    { photo: 'tt_photo', carousel: 'tt_photo' },
};

export function nativeFormat(platform: Platform, f: GenericFormat): string | null {
  if (platform === 'telegram') return f;
  if (platform === 'youtube') return null;
  const n = NATIVE[platform][f] ?? null;
  return n && implementedFormats(platform).includes(n) ? n : null;
}

export type TypeMapping =
  | { ok: true; format: string; source: SeriesSource | null; mode: 'suggested' | 'required'; retryLoop: boolean; brief: string; warnings: string[] }
  | { ok: false; reason: string };

/**
 * A binding's type on its destination → format, source and brief. `formats` are the formats the destination
 * may use (the card's for Telegram); `catalog` the datasets and card feeds a source may name.
 */
export function mapType(type: string, params: Record<string, unknown>, platform: Platform, formats: string[], catalog: SeriesSourceCatalog | null): TypeMapping {
  const rule = TYPE_RULES[type];
  if (!rule) return { ok: false, reason: `strategy type "${type}" has no agent equivalent` };
  const format = nativeFormat(platform, rule.format);
  if (!format) return { ok: false, reason: `${platform} has no ${rule.format} format` };
  if (!formats.includes(format)) {
    return { ok: false, reason: platform === 'telegram' ? `format ${format} is off on the channel card (enable it, then migrate again)` : `format ${format} is not available on ${platform}` };
  }
  const { source: src, warnings } = rule.source(params ?? {});
  let source = src;
  let mode = rule.mode ?? 'suggested';
  const out = [...warnings];
  if (source?.kind === 'library' && catalog && !catalog.tables.includes(source.table)) {
    if (mode === 'required') return { ok: false, reason: `dataset ${source.table} is not in the library (load it, then migrate again)` };
    out.push(`dataset ${source.table} is not in the library; the series has no source`);
    source = null;
  }
  if (source?.kind === 'feed' && catalog && !catalog.feeds.includes(source.ref)) {
    out.push(`feed ${source.ref} is not on the channel card; add it to the card's sources, then give the series a feed source`);
    source = null;
  }
  if (!source) mode = 'suggested';
  return { ok: true, format, source, mode, retryLoop: !!rule.retryLoop, brief: rule.brief(params ?? {}).slice(0, 600), warnings: out };
}
