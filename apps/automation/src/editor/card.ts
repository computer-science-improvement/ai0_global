import type { EditorRole } from './llm/llm.types';

export type ChannelMode = 'off' | 'shadow' | 'live';
export type LinkStyle   = 'inline' | 'footer' | 'button';
export type EmojiPolicy = 'none' | 'sparse' | 'free';

export interface CardSource {
  id:    string;
  kind:  'rss' | 'url' | 'library' | 'api';
  ref:   string;          // feed URL, page URL, library table name, or fetch_api source name
  note?: string;
}

/** Editorial card of one channel (row of editor_channels). */
export interface EditorCard {
  channelKey:      string;
  mode:            ChannelMode;
  title:           string | null;
  language:        string;
  timezone:        string;
  postsPerDayMin:  number;
  postsPerDayMax:  number;
  quietStartHour:  number;
  quietEndHour:    number;
  minGapMinutes:   number;
  planHour:        number;
  brief:           string;
  formats:         Record<string, number>;
  hashtags:        string[];
  hashtagMin:      number;
  hashtagMax:      number;
  footer:          string | null;
  linkStyle:       LinkStyle;
  emojiPolicy:     EmojiPolicy;
  skills:          string[];
  sources:         CardSource[];
  toolsAllow:      string[] | null;
  exploreRatio:    number;
  dailyBudgetUsd:  number | null;
  models:          Partial<Record<EditorRole, string>>;
  bannedTerms:     string[];
}

/** What each platform can render natively — shown to agents with the card. */
export const TELEGRAM_CAPABILITIES = {
  formats: {
    text:  'до 4096 символів; одне зображення можна показати як велике прев’ю над або під текстом',
    photo: 'фото + підпис до 1024 символів; підпис над або під фото; довший текст автоматично стає текстом з великим прев’ю',
    album: 'слайдер 2–10 фото; підпис (до 1024) лише під першим; кнопки НЕ підтримуються',
    poll:  'опитування: питання до 300, 2–10 варіантів до 100 символів; опційний вступний пост перед ним',
    quiz:  'вікторина: як poll + правильна відповідь (correct_index) і пояснення до 200 символів',
  },
  markup: '**жирний**, _курсив_, [текст](https://url), ||спойлер|| — більше нічого; HTML писати не можна',
  buttons: 'до 4 рядків по 1–3 URL-кнопки; cta стає кнопкою',
} as const;

export function cardSummary(c: EditorCard): Record<string, unknown> {
  return {
    channel:        c.channelKey,
    title:          c.title,
    mode:           c.mode,
    brief:          c.brief,
    language:       c.language,
    timezone:       c.timezone,
    posts_per_day:  [c.postsPerDayMin, c.postsPerDayMax],
    quiet_hours:    `${c.quietStartHour}:00–${c.quietEndHour}:00`,
    min_gap_minutes: c.minGapMinutes,
    formats:        c.formats,
    hashtags:       { vocabulary: c.hashtags, min: c.hashtagMin, max: c.hashtagMax },
    footer:         c.footer,
    link_style:     c.linkStyle,
    emoji_policy:   c.emojiPolicy,
    skills:         c.skills,
    sources:        c.sources,
    explore_ratio:  c.exploreRatio,
    banned_terms:   c.bannedTerms,
    capabilities:   TELEGRAM_CAPABILITIES,
  };
}
