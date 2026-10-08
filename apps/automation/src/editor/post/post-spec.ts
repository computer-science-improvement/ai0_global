import { z } from 'zod';
import { CONTENT_REF_RE } from '../../data/data-refs';

export const POST_FORMATS = ['text', 'photo', 'album', 'poll', 'quiz', 'video', 'carousel', 'longread'] as const;
/** Formats lint accepts. Phase 2 (spec 009 T002) added video, carousel and longread, so this is every format. */
export const SUPPORTED_FORMATS = POST_FORMATS;
export type PostFormat = typeof POST_FORMATS[number];

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be http(s)');

/** Spec 033 FR-001 limits (zod + lint): a table is ≤ 6 columns × 20 rows, a cell ≤ 200 chars; math ≤ 500 chars. */
export const TABLE_MAX_COLS = 6;
export const TABLE_MAX_ROWS = 20;
export const TABLE_CELL_MAX = 200;
export const MATH_MAX = 500;
/** Every block of a post, nested `details` bodies included. */
export const MAX_BLOCKS = 60;

const cell = z.string().max(TABLE_CELL_MAX);

/** Blocks that may sit inside `details` (everything except `details` itself). */
const INNER_BLOCKS = [
  z.object({ type: z.literal('lead'),  text: z.string().min(1).max(400) }).describe('Перший рядок жирним — заголовок/гачок'),
  z.object({ type: z.literal('p'),     text: z.string().min(1).max(1500) }),
  z.object({ type: z.literal('list'),  items: z.array(z.string().min(1).max(300)).min(1).max(15) }),
  z.object({ type: z.literal('quote'), text: z.string().min(1).max(800) }),
  // Spec 033: rich-only blocks (Telegram Rich Messages; a plain/HTML fallback everywhere else).
  z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(3).default(2), text: z.string().min(1).max(200) })
    .describe('Підзаголовок розділу (1 — найбільший); лише в довших постах'),
  z.object({ type: z.literal('olist'), items: z.array(z.string().min(1).max(300)).min(1).max(15) }).describe('Нумерований список: кроки, рейтинг'),
  z.object({
    type:   z.literal('table'),
    header: z.array(cell).min(1).max(TABLE_MAX_COLS).describe('Назви колонок'),
    rows:   z.array(z.array(cell).min(1).max(TABLE_MAX_COLS)).min(1).max(TABLE_MAX_ROWS).describe('Рядки; клітинка — короткий текст з inline-розміткою'),
  }).describe('Таблиця для порівнянь і характеристик: до 6 колонок × 20 рядків'),
  z.object({ type: z.literal('math'), expression: z.string().min(1).max(MATH_MAX) }).describe('Формула у форматі LaTeX'),
  z.object({ type: z.literal('divider') }),
  z.object({ type: z.literal('footer'), text: z.string().min(1).max(300) }).describe('Дрібний текст у кінці поста'),
  z.object({ type: z.literal('code'), text: z.string().min(1).max(3000), language: z.string().regex(/^[a-z0-9+#.-]{1,30}$/i).optional() })
    .describe('Моноширинний блок (код, команда)'),
] as const;

export const InnerBlockSchema = z.discriminatedUnion('type', [...INNER_BLOCKS]);
export type InnerBlock = z.infer<typeof InnerBlockSchema>;

export const BlockSchema = z.discriminatedUnion('type', [
  ...INNER_BLOCKS,
  z.object({ type: z.literal('details'), title: z.string().min(1).max(200), body: z.array(InnerBlockSchema).min(1).max(20) })
    .describe('Згорнутий розділ: заголовок + блоки, що розкриваються'),
]);
export type Block = z.infer<typeof BlockSchema>;

/** One carousel slide: rendered by code into an image (title + text over the optional background picture). */
export const SlideSchema = z.object({
  title: z.string().min(1).max(80).describe('Заголовок слайда, коротко'),
  text:  z.string().min(1).max(400).describe('Текст слайда, звичайний текст без розмітки, 1–3 речення'),
  image: httpUrl.optional().describe('Фонове зображення слайда з джерела (https)'),
});
export type Slide = z.infer<typeof SlideSchema>;

/** A Telegraph article behind a longread teaser. */
export const LongreadSchema = z.object({
  title:  z.string().min(3).max(200).describe('Заголовок статті на Telegraph'),
  blocks: z.array(BlockSchema).min(1).max(MAX_BLOCKS).describe('Повний текст статті: lead стає підзаголовком, p/list/quote — як у пості'),
});
export type Longread = z.infer<typeof LongreadSchema>;

export const PostSpecSchema = z.object({
  format:      z.enum(POST_FORMATS),
  title:       z.string().min(3).max(120).describe('Короткий внутрішній заголовок (для аналітики й дайджесту), українською'),
  origin:      z.enum(['external', 'library', 'original']).describe('external — з веб/RSS джерела; library — з бібліотеки БД; original — власний текст'),
  library_ref: z.string().regex(CONTENT_REF_RE).optional().describe('Обовʼязково для origin=library: ref рядка з query_data (data://<dataset>/<id>) або library_ref з search_library'),
  body:        z.array(BlockSchema).max(MAX_BLOCKS).default([]),
  media:       z.array(z.object({
    url:    httpUrl,
    alt:    z.string().max(200).optional(),
    credit: z.string().max(120).optional(),
    kind:   z.enum(['image', 'video']).optional().describe('video — пряме посилання на відеофайл (mp4), лише для format=video'),
  })).max(10).default([]),
  placement:   z.enum(['above', 'below']).default('above').describe('Зображення над текстом (above) чи під ним (below)'),
  hashtags:    z.array(z.string().min(1).max(40)).max(10).default([]).describe('Без #, лише зі словника каналу'),
  source:      z.object({ url: httpUrl, label: z.string().min(1).max(60).optional() }).optional(),
  cta:         z.object({ url: httpUrl, label: z.string().min(1).max(40) }).optional(),
  buttons:     z.array(z.array(z.object({ text: z.string().min(1).max(40), url: httpUrl })).min(1).max(3)).max(4).default([]),
  poll:        z.object({
    question:      z.string().min(1).max(300),
    options:       z.array(z.string().min(1).max(100)).min(2).max(10),
    correct_index: z.number().int().min(0).max(9).optional(),
    explanation:   z.string().max(200).optional(),
    anonymous:     z.boolean().default(true),
  }).optional(),
  slides:      z.array(SlideSchema).max(10).optional().describe('Лише для format=carousel: 2–10 слайдів, код рендерить їх у зображення'),
  longread:    LongreadSchema.optional().describe('Лише для format=longread: стаття для Telegraph; body — короткий тизер до 600 символів'),
});

export type PostSpec = z.infer<typeof PostSpecSchema>;
