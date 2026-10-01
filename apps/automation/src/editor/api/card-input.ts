import { z } from 'zod';
import type { EditorCard } from '../card';
import { SUPPORTED_FORMATS } from '../post/post-spec';
import { API_SOURCE_NAMES } from '../tools/api-adapters/names';

/** Column defaults of editor_channels (migration 042), used when a card is created through the API. */
export const CARD_DEFAULTS: Omit<EditorCard, 'channelKey'> = {
  mode: 'off', title: null, language: 'uk', timezone: 'Europe/Kyiv',
  postsPerDayMin: 2, postsPerDayMax: 6, quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60, planHour: 6,
  brief: '', formats: { text: 1, photo: 1 }, hashtags: [], hashtagMin: 1, hashtagMax: 3, footer: null,
  linkStyle: 'inline', emojiPolicy: 'sparse', skills: [], sources: [], toolsAllow: null,
  exploreRatio: 0.2, dailyBudgetUsd: null, models: {}, bannedTerms: [],
};

const isTimeZone = (tz: string) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

const hour = z.number().int().min(0).max(23);
const smallint = (min: number, max: number) => z.number().int().min(min).max(max);
const name = z.string().trim().min(1).max(100);

const SourceSchema = z.object({
  id:   z.string().trim().min(1).max(64),
  kind: z.enum(['rss', 'url', 'library', 'api']),
  ref:  z.string().trim().min(1).max(2000),
  note: z.string().max(300).optional(),
}).strict().superRefine((s, ctx) => {
  if ((s.kind === 'rss' || s.kind === 'url') && !/^https?:\/\/\S+$/i.test(s.ref)) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: 'rss/url sources need an http(s) URL' });
  }
  if (s.kind === 'library' && !/^[a-z_]+$/.test(s.ref)) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: 'library sources take a table name' });
  }
  if (s.kind === 'api' && !(API_SOURCE_NAMES as readonly string[]).includes(s.ref)) {
    ctx.addIssue({ code: 'custom', path: ['ref'], message: `api sources take a fetch_api source: ${API_SOURCE_NAMES.join(', ')}` });
  }
});

/** Every editable card field, with the editor_channels column constraints. */
const CardFields = z.object({
  mode:           z.enum(['off', 'shadow', 'live']),
  title:          z.string().trim().max(200).nullable(),
  language:       z.string().trim().min(2).max(10),
  timezone:       z.string().refine(isTimeZone, 'unknown IANA time zone'),
  postsPerDayMin: smallint(0, 48),
  postsPerDayMax: smallint(1, 48),
  quietStartHour: hour,
  quietEndHour:   hour,
  minGapMinutes:  smallint(0, 1440),
  planHour:       hour,
  brief:          z.string().max(4000),
  formats:        z.partialRecord(z.enum(SUPPORTED_FORMATS), z.number().min(0.01).max(1))
                    .refine((f) => Object.keys(f).length > 0, 'at least one format'),
  hashtags:       z.array(z.string().regex(/^[\p{L}\p{N}_]{1,50}$/u, 'letters, digits and _ only, without #')).max(50),
  hashtagMin:     smallint(0, 10),
  hashtagMax:     smallint(0, 10),
  footer:         z.string().trim().max(300).nullable(),
  linkStyle:      z.enum(['inline', 'footer', 'button']),
  emojiPolicy:    z.enum(['none', 'sparse', 'free']),
  skills:         z.array(name).max(20),
  sources:        z.array(SourceSchema).max(30),
  toolsAllow:     z.array(name).max(50).nullable(),
  exploreRatio:   z.number().min(0).max(1).transform((x) => Math.round(x * 100) / 100),
  dailyBudgetUsd: z.number().min(0).max(1000).nullable(),
  models:         z.partialRecord(z.enum(['planner', 'executor', 'reviewer', 'checker']), z.string().trim().min(1).max(200)),
  bannedTerms:    z.array(z.string().trim().min(1).max(100)).max(100),
}).strict();

/** Body of PUT /api/editor/channels/:key — any subset of the card fields. */
export const CardPatchSchema = CardFields.partial().strict();
export type CardPatch = z.infer<typeof CardPatchSchema>;

const CardSchema = CardFields.superRefine((c, ctx) => {
  if (c.postsPerDayMin > c.postsPerDayMax) {
    ctx.addIssue({ code: 'custom', path: ['postsPerDayMin'], message: 'must be ≤ postsPerDayMax' });
  }
  if (c.hashtagMin > c.hashtagMax) {
    ctx.addIssue({ code: 'custom', path: ['hashtagMin'], message: 'must be ≤ hashtagMax' });
  }
});

export type MergeResult =
  | { ok: true; card: EditorCard }
  | { ok: false; issues: Array<{ path: PropertyKey[]; message: string }> };

/**
 * Upsert semantics: the patch is laid over the existing card (or the column
 * defaults for a new one) and the whole result is validated, so cross-field
 * rules (min ≤ max) hold no matter which half of the pair was sent.
 */
export function mergeCard(channelKey: string, existing: EditorCard | null, patch: unknown): MergeResult {
  const p = CardPatchSchema.safeParse(patch ?? {});
  if (!p.success) return { ok: false, issues: p.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  const { channelKey: _k, ...base } = existing ?? { channelKey, ...CARD_DEFAULTS };
  void _k;
  const full = CardSchema.safeParse({ ...pickCardFields(base), ...p.data });
  if (!full.success) return { ok: false, issues: full.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  return { ok: true, card: { channelKey, ...full.data } as EditorCard };
}

const FIELD_KEYS = Object.keys(CardFields.shape) as Array<keyof typeof CardFields.shape>;

/** Drop non-card properties (e.g. createdAt from the repository row). */
function pickCardFields(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) if (k in c) out[k] = c[k];
  return out;
}
