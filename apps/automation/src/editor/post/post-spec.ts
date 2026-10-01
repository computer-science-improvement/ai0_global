import { z } from 'zod';

export const POST_FORMATS = ['text', 'photo', 'album', 'poll', 'quiz', 'video', 'carousel', 'longread'] as const;
export const SUPPORTED_FORMATS = ['text', 'photo', 'album', 'poll', 'quiz'] as const;
export type PostFormat = typeof POST_FORMATS[number];

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be http(s)');

export const BlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lead'),  text: z.string().min(1).max(400) }).describe('Перший рядок жирним — заголовок/гачок'),
  z.object({ type: z.literal('p'),     text: z.string().min(1).max(1500) }),
  z.object({ type: z.literal('list'),  items: z.array(z.string().min(1).max(300)).min(1).max(15) }),
  z.object({ type: z.literal('quote'), text: z.string().min(1).max(800) }),
]);
export type Block = z.infer<typeof BlockSchema>;

export const PostSpecSchema = z.object({
  format:      z.enum(POST_FORMATS),
  title:       z.string().min(3).max(120).describe('Короткий внутрішній заголовок (для аналітики й дайджесту), українською'),
  origin:      z.enum(['external', 'library', 'original']).describe('external — з веб/RSS джерела; library — з бібліотеки БД; original — власний текст'),
  library_ref: z.string().regex(/^library:\/\/[a-z_]+\/\d+$/).optional().describe('Обовʼязково для origin=library: значення library_ref з search_library'),
  body:        z.array(BlockSchema).max(30).default([]),
  media:       z.array(z.object({ url: httpUrl, alt: z.string().max(200).optional(), credit: z.string().max(120).optional() })).max(10).default([]),
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
});

export type PostSpec = z.infer<typeof PostSpecSchema>;
