import { z } from 'zod';
import type { EditorCard } from '../../card';
import { NEWS_TOPIC_RE } from '../audience-asks';
import { isNewsCard } from '../../live/news-watch-config';
import { applyStyleOverlay, ownerStyleOverlay, rowOwnerRules } from '../../rules/owner-style-overlay';

/**
 * Spec 037 FR-008 (T8): the resource style sheet — `format_prefs.style` of a resource. Every field is optional; the
 * effective style (`effectiveStyle`) fills the owner's defaults of 2026-10-15:
 *   • address «ви» on every resource;
 *   • the glossary bans transliterations and translated brands (АПІ, КЛІ, Разом AI, спотифай) with the right form;
 *   • content_kind from what the resource looks like (`resourceKind`): games by the title / topic (Біржа Ігор), news
 *     by the spec 034 news detection (content_kind news, a news topic, or a card with RSS feeds whose title / brief
 *     says news: AI Шукає Новини, AI Технології);
 *   • hashtags off on news and games resources (so all three DEV channels), the card's vocabulary elsewhere — and on
 *     any resource whose card already has a hashtag vocabulary (an owner's earlier choice is never switched off);
 *     spec 041 FR-003: a card with an empty vocabulary has no hashtags either (there is nothing to take them from).
 * `names`, `headline`, `numbers`, `units` and `audience` have no default: a check that needs one stays silent.
 * The style is the owner's: agents cannot change it (OWNER_ONLY_ON in resource-profile.ts).
 */

export const ADDRESS_FORMS = ['ty', 'vy', 'impersonal'] as const;
export type AddressForm = typeof ADDRESS_FORMS[number];
export const NAME_POLICIES = ['uk_translit', 'original'] as const;
export const AUDIENCE_LEVELS = ['beginner', 'general', 'expert'] as const;
/** What the resource publishes, for the freshness rules of T5 (evergreen, explainer, education are exempt). */
export const STYLE_KINDS = ['news', 'games', 'evergreen', 'explainer', 'education'] as const;
export type StyleKind = typeof STYLE_KINDS[number];

const term = z.string().trim().min(1).max(60);
const use = z.string().trim().min(1).max(80);

/**
 * `prefer`: a wrong form → the form to write instead (`{"АПІ": "API"}`), or the same as a list
 * (`[{"instead_of": "АПІ", "use": "API"}]`); the wrong form is banned with the hint. `ban`: forms banned without a
 * hint. A form is matched word-bounded on the banned-terms normalisation (case, apostrophes); `*` = the rest of a
 * word (`спотифа*` also catches «спотифаю»).
 */
export const GlossarySchema = z.object({
  prefer: z.union([
    z.record(term, use).refine((r) => Object.keys(r).length <= 100, { message: 'at most 100 preferred forms' }),
    z.array(z.object({ instead_of: term, use }).strict()).max(100),
  ]).optional(),
  ban: z.array(term).max(100).optional(),
}).strict();
export type Glossary = z.infer<typeof GlossarySchema>;

export const StyleSchema = z.object({
  /** How the post addresses the reader: «ти», «ви» or neither. */
  address:  z.enum(ADDRESS_FORMS).optional(),
  glossary: GlossarySchema.optional(),
  /** People's names: Ukrainian transliteration («Мустафа Сулейман») or the original script («Mustafa Suleyman»). */
  names:    z.enum(NAME_POLICIES).optional(),
  /** The bold lead (headline) limit; T6 `lead_too_long` reads it. */
  headline: z.object({ max_chars: z.number().int().min(40).max(400) }).strict().optional(),
  /** The decimal separator of the resource; T6 `decimal_mixed` reads it. */
  numbers:  z.object({ decimal: z.enum(['comma', 'dot']) }).strict().optional(),
  /** `words`: «3 млрд параметрів», not «3B» (model names like d1-3B stay). */
  units:    z.enum(['words', 'latin']).optional(),
  /** `off`: no hashtags at all; `vocabulary`: the card's hashtag vocabulary (hashtag_not_in_vocabulary). */
  hashtags: z.enum(['off', 'vocabulary']).optional(),
  /** Who reads the resource; T9 sets the jargon budget from it. */
  audience: z.object({ level: z.enum(AUDIENCE_LEVELS) }).strict().optional(),
  /** What the resource publishes (T5 `stale_source`: news 36 h, games 72 h; evergreen / explainer / education exempt). */
  content_kind:    z.enum(STYLE_KINDS).optional(),
  /** T5: a source older than this many hours is stale (overrides the content_kind default). */
  freshness_hours: z.number().int().min(1).max(24 * 60).optional(),
}).strict();
export type ResourceStyle = z.infer<typeof StyleSchema>;

/** Owner decision 2026-10-15: the default glossary of every resource (wrong form → right form). */
export const DEFAULT_GLOSSARY: Glossary = {
  prefer: { 'АПІ': 'API', 'КЛІ': 'CLI', 'Разом AI': 'Together AI', 'спотифа*': 'Spotify' },
};
export const DEFAULT_ADDRESS: AddressForm = 'vy';

/** Style fields the effective style fills when the owner has not set them. */
export const STYLE_DEFAULTED = ['address', 'glossary', 'hashtags', 'content_kind'] as const;

/**
 * The style the checks, the prompts and the platform lint use: the stored one plus the owner's defaults. `kind` is
 * what the resource looks like (`resourceKind`); hashtags are off by default on news and games resources.
 */
export function effectiveStyle(stored: ResourceStyle | null | undefined, o: { kind?: StyleKind | null; vocabulary?: readonly string[] | null }): ResourceStyle {
  const s = stored ?? {};
  const kind = s.content_kind ?? o.kind ?? undefined;
  return {
    ...s,
    address: s.address ?? DEFAULT_ADDRESS,
    glossary: s.glossary ?? DEFAULT_GLOSSARY,
    hashtags: s.hashtags ?? (!o.vocabulary?.length && (kind === 'news' || kind === 'games' || Array.isArray(o.vocabulary)) ? 'off' : 'vocabulary'),
    ...(kind ? { content_kind: kind } : {}),
  };
}

/** A stored `format_prefs.style` (anything invalid counts as not set). */
export function parseStoredStyle(raw: unknown): ResourceStyle {
  const p = StyleSchema.safeParse(raw ?? {});
  return p.success ? p.data : {};
}

/**
 * Is the resource a news resource for the style defaults? An explicit content_kind decides; otherwise a topic that
 * names news (spec 034 FR-005) or a Telegram card with RSS feeds whose title / brief / formats say news (spec 034
 * FR-011, `isNewsCard`).
 */
export function isNewsResource(o: {
  contentKind?: string | null; topic?: string | null;
  card?: Pick<EditorCard, 'brief' | 'title' | 'formats' | 'sources'> | null;
}): boolean {
  if (o.contentKind) return o.contentKind === 'news';
  if (o.topic && NEWS_TOPIC_RE.test(o.topic)) return true;
  return !!o.card && isNewsCard(o.card, o.topic);
}

/** A games resource by its title or profile topic («Біржа Ігор», «ігрові новини», «gaming»); the brief is not read. */
export const GAMES_RE = /(?<![\p{L}])(?:ігор(?![\p{L}])|ігри|ігров|геймін|gaming|game)/iu;

/**
 * The default content kind of a resource: education when the spec 034 content_kind says so, games by the title /
 * topic, news by `isNewsResource`; nothing else is inferred. The three DEV channels: news, news, games.
 */
export function resourceKind(o: Parameters<typeof isNewsResource>[0]): StyleKind | null {
  if (o.contentKind === 'education') return 'education';
  if (GAMES_RE.test(`${o.card?.title ?? ''} ${o.topic ?? ''}`)) return 'games';
  return isNewsResource(o) ? 'news' : null;
}

/**
 * The effective style of an editor_channels row read with the profile join (CARD_SELECT: `format_prefs_json`,
 * `profile_topic`, `owner_rules`). A row read without the join gets no style, so the style checks stay silent.
 */
export function styleOfRow(r: any): { style?: ResourceStyle } {
  if (!('format_prefs_json' in r) && !('profile_topic' in r)) return {};
  const fp = (r.format_prefs_json && typeof r.format_prefs_json === 'object' ? r.format_prefs_json : {}) as Record<string, unknown>;
  const kind = resourceKind({
    contentKind: typeof fp.content_kind === 'string' ? fp.content_kind : null,
    topic: r.profile_topic ?? null,
    card: { brief: r.brief ?? '', title: r.title ?? null, formats: r.formats ?? {}, sources: r.sources ?? [] },
  });
  const style = effectiveStyle(parseStoredStyle(fp.style), { kind, vocabulary: Array.isArray(r.hashtags) ? r.hashtags : null });
  // Spec 041 FR-003: the owner's rules beat the stored style (CARD_SELECT joins them in as `owner_rules`).
  return { style: applyStyleOverlay(style, ownerStyleOverlay(rowOwnerRules(r.owner_rules))) };
}

export interface GlossaryEntry { term: string; use?: string }

/** Every banned form of a glossary: the `prefer` keys (with the right form) and the plain bans. */
export function glossaryEntries(g: Glossary | null | undefined): GlossaryEntry[] {
  if (!g) return [];
  const prefer = Array.isArray(g.prefer)
    ? g.prefer.map((p) => ({ term: p.instead_of, use: p.use }))
    : Object.entries(g.prefer ?? {}).map(([t, u]) => ({ term: t, use: u }));
  const out: GlossaryEntry[] = [...prefer];
  for (const b of g.ban ?? []) if (!out.some((e) => e.term === b)) out.push({ term: b });
  return out;
}

// ── the compact style block of the writer and critic prompts ────────────────

/** The style block stays this short (Ukrainian, like the rest of the prompts). */
export const STYLE_BLOCK_LIMIT = 600;

const ADDRESS_UK: Record<AddressForm, string> = {
  vy: 'на «ви» (читай, пишіть, ваш); не мішай із «ти», цитати не рахуються',
  ty: 'на «ти» (читай, пиши, твій); не мішай із «ви», цитати не рахуються',
  impersonal: 'безособово (можна, варто), без «ти» і «ви»',
};
const LEVEL_UK = { beginner: 'початківці — пояснюй терміни простими словами', general: 'широка аудиторія', expert: 'фахівці' } as const;

/** The style as prompt lines (no heading); empty when nothing is set. */
export function styleLines(s: ResourceStyle | null | undefined): string[] {
  if (!s) return [];
  const lines: string[] = [];
  if (s.address) lines.push(`- Звертання: ${ADDRESS_UK[s.address]}.`);
  if (s.hashtags === 'off') lines.push('- Хештеги не став (ні в полі hashtags, ні в тексті).');
  else if (s.hashtags === 'vocabulary') lines.push('- Хештеги: лише зі словника картки.');
  if (s.names === 'uk_translit') lines.push('- Імена людей: українською транслітерацією (Мустафа Сулейман), не латиницею.');
  if (s.names === 'original') lines.push('- Імена людей: в оригіналі (Mustafa Suleyman), без транслітерації.');
  if (s.units === 'words') lines.push('- Числа з одиницями словами: «3 млрд параметрів», не «3B»; назви моделей (d1-3B) не чіпай.');
  if (s.numbers?.decimal) lines.push(`- Десятковий роздільник: ${s.numbers.decimal === 'comma' ? 'кома (1,5)' : 'крапка (1.5)'}.`);
  if (s.headline?.max_chars) lines.push(`- Лід (жирний перший рядок): до ${s.headline.max_chars} символів.`);
  if (s.audience?.level) lines.push(`- Аудиторія: ${LEVEL_UK[s.audience.level]}.`);
  if (s.freshness_hours) lines.push(`- Джерело не старше ${s.freshness_hours} год.`);
  const g = glossaryEntries(s.glossary);
  if (g.length) {
    const parts = g.map((e) => (e.use ? `${e.use}, не ${e.term}` : `не ${e.term}`));
    lines.push(`- Глосарій: ${parts.join('; ')}.`);
  }
  return lines;
}

/** `## Стиль ресурсу` + the lines, at most STYLE_BLOCK_LIMIT characters (the glossary line is cut first). */
export function renderStyleBlock(s: ResourceStyle | null | undefined): string | null {
  const lines = styleLines(s);
  if (!lines.length) return null;
  const head = '## Стиль ресурсу (правила власника; код їх перевіряє)';
  let out = [head, ...lines].join('\n');
  if (out.length > STYLE_BLOCK_LIMIT) out = `${out.slice(0, STYLE_BLOCK_LIMIT - 1)}…`;
  return out;
}

/** The block as prompt lines (`['', block]`), empty without a style. One additive call in each prompt builder. */
export function styleSection(s: ResourceStyle | null | undefined): string[] {
  const b = renderStyleBlock(s);
  return b ? ['', b] : [];
}

/** A one-line Ukrainian summary of a stored style for renderFormatPrefs (the full rules are the style block). */
export function styleSummaryUk(s: ResourceStyle): string {
  const parts = [
    s.address ? `звертання ${s.address === 'vy' ? '«ви»' : s.address === 'ty' ? '«ти»' : 'безособове'}` : '',
    s.hashtags ? `хештеги ${s.hashtags === 'off' ? 'вимкнено' : 'зі словника'}` : '',
    s.names ? `імена ${s.names === 'uk_translit' ? 'транслітом' : 'в оригіналі'}` : '',
    s.units ? `одиниці ${s.units === 'words' ? 'словами' : 'латиницею'}` : '',
    s.glossary ? `глосарій: ${glossaryEntries(s.glossary).length}` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'за замовчуванням';
}
