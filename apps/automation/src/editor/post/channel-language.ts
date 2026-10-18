/**
 * The channel card's reader language (`editor_channels.language`): the language every reader-facing text of the
 * channel is written in. The prompts (writer, composer, platform writer, critic), the lint script check and the
 * Ukrainian lexicon gate all read it from here, so a new channel in another language is one card field.
 *
 * Values: an ISO 639-1 code (`uk`, `en`, `pl`, …) or `mixed` — Ukrainian prose with verbatim foreign text
 * (prompts, commands, code, quotes) kept as written. The instructions to the models stay Ukrainian whatever the
 * language; only the reader text follows the card.
 */

export const DEFAULT_CHANNEL_LANGUAGE = 'uk';

/** The languages the dashboard offers first (any other ISO 639-1 code is accepted too). */
export const CHANNEL_LANGUAGES = ['uk', 'mixed', 'en', 'pl', 'de', 'es', 'fr', 'it', 'pt'] as const;

/** Languages written in Cyrillic / Latin script: the lint checks the post is in that script. Others are not checked. */
const CYRILLIC = new Set(['uk', 'be', 'bg', 'kk', 'ky', 'mk', 'mn', 'ru', 'tg']);
const LATIN = new Set([
  'en', 'pl', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'cs', 'sk', 'ro', 'hu', 'sv', 'da', 'no', 'nb', 'fi', 'tr', 'lt',
  'lv', 'et', 'hr', 'sl', 'ca', 'id', 'ms', 'vi', 'sq', 'az', 'uz', 'ga', 'is', 'mt', 'eu', 'gl',
]);
const ALIASES: Record<string, string> = { ua: 'uk', ukr: 'uk', eng: 'en', pol: 'pl', ger: 'de', deu: 'de' };

const displayName = (code: string, locale: string): string | undefined => {
  try { return new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code) ?? undefined; } catch { return undefined; }
};

/**
 * A stored or typed value as a card language: `uk`, `mixed` or a known ISO 639-1 code (`en-US` → `en`, `ua` → `uk`);
 * null when it is not a language.
 */
export function normalizeChannelLanguage(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!v) return null;
  if (v === 'mixed') return 'mixed';
  const base = ALIASES[v] ?? ALIASES[v.split('-')[0]] ?? v.split('-')[0];
  if (!/^[a-z]{2}$/.test(base)) return null;
  return displayName(base, 'en') ? base : null;
}

/** The card's language for the prompts and checks; an empty or unknown value reads as Ukrainian (the column default). */
export function channelLanguage(card: { language?: string | null } | null | undefined): string {
  return normalizeChannelLanguage(card?.language) ?? DEFAULT_CHANNEL_LANGUAGE;
}

/** The language the post's prose is in: `mixed` is Ukrainian prose. */
export function proseLanguage(lang: string): string {
  return lang === 'mixed' ? 'uk' : lang;
}

/** Ukrainian prose (uk and mixed): the Ukrainian lexicon gate and the Ukrainian critic norms apply. */
export const isUkrainianProse = (lang: string): boolean => proseLanguage(lang) === 'uk';

/** The script the prose must be in, or null when the lint does not check it (mixed, other scripts). */
export function languageScript(lang: string): 'cyrillic' | 'latin' | null {
  if (lang === 'mixed') return null;
  if (CYRILLIC.has(lang)) return 'cyrillic';
  if (LATIN.has(lang)) return 'latin';
  return null;
}

/** «англійська (en)» for the prompts; `mixed` is described in full. */
export function languageNameUk(lang: string): string {
  if (lang === 'mixed') return 'українська з дослівними іншомовними вставками (mixed)';
  return `${displayName(lang, 'uk') ?? lang} (${lang})`;
}

/** "English" for the dashboard and API messages. */
export function languageLabel(lang: string): string {
  if (lang === 'mixed') return 'Ukrainian + verbatim foreign text';
  return displayName(lang, 'en') ?? lang;
}

const UK_RULE = 'Усі тексти для читачів — українською, живою мовою, без канцеляриту й AI-штампів.';

/**
 * The writer's line about the reader language (system prompts of the channel writer, the chat composer and the
 * platform writer). Ukrainian keeps the line every prompt had before the setting existed.
 */
export function readerLanguageRule(lang: string): string {
  if (lang === 'uk') return UK_RULE;
  if (lang === 'mixed') {
    return `${UK_RULE} Дослівний іншомовний текст (промпт, команда, код, цитата, назва) лишай мовою оригіналу — у блоці code чи в лапках; пояснення навколо нього — українською.`;
  }
  return `Мова каналу — ${languageNameUk(lang)}: усі тексти для читачів (заголовок, текст, підписи, опитування) пиши цією мовою, живо й природно для носія, без канцеляриту й AI-штампів. Інструкції тут українською — це не мова поста; українські джерела перекладай.`;
}

/**
 * The critic's line about the language axis; empty for Ukrainian (the rubric is Ukrainian by default).
 */
export function criticLanguageLines(lang: string): string[] {
  if (lang === 'uk') return [];
  if (lang === 'mixed') {
    return [`Мова поста: ${languageNameUk(lang)}. Оцінюй language лише за українською прозою; дослівні вставки (промпт, код, цитата) не правиш і не штрафуєш.`];
  }
  return [`Мова поста: ${languageNameUk(lang)}. Оцінюй language за нормами цієї мови (граматика, природність для носія); українські норми (русизми, у/в, і/й) не застосовуй. Пост не цією мовою → language ≤ 2. Нотатки — українською.`];
}

/** Letters of the text by script (URLs dropped); null when there are too few letters to judge. */
export function scriptShares(text: string): { cyrillic: number; latin: number } | null {
  const letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return null;
  const cyr = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
  const lat = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return { cyrillic: cyr / letters.length, latin: lat / letters.length };
}

/** Below this share of the expected script the post is in the wrong language (the uk check's 60 %). */
export const SCRIPT_MIN_SHARE = 0.6;
