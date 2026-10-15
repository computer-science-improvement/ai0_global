import type { Pool } from 'pg';
import { effectiveStyle, parseStoredStyle, resourceKind, STYLE_DEFAULTED, type ResourceStyle, type StyleKind } from './resource-style';

/** The style sheet of one resource as the Formatting page, the platform paths and the proposal see it. */
export interface ResourceStyleView {
  /** format_prefs.style as stored (what the owner set). */
  stored:     ResourceStyle;
  /** With the owner's defaults filled in: what the checks and prompts use. */
  effective:  ResourceStyle;
  /** Fields that come from the defaults, not from the owner. */
  defaulted:  string[];
  /** What the resource looks like (the content_kind default; news and games: hashtags default off). */
  kind:       StyleKind | null;
  /** Telegram only: the card's hashtag vocabulary (card.hashtags), edited in vocabulary mode. */
  vocabulary?: string[];
}

/**
 * Spec 037 FR-008: the effective style of a resource ref from resource_profiles (format_prefs.style, content_kind,
 * topic) and, for `telegram:<key>`, the editor card (brief, title, formats, sources: the spec 034 news detection) —
 * the same computation the card read (`styleOfRow`) does, for refs read without a card.
 */
export async function resourceStyleOf(pool: Pick<Pool, 'query'>, ref: string): Promise<ResourceStyleView> {
  const { rows } = await pool.query(`SELECT profile FROM resource_profiles WHERE resource_ref = $1`, [ref]);
  const profile = (rows[0]?.profile ?? {}) as Record<string, any>;
  const fp = (profile.format_prefs && typeof profile.format_prefs === 'object' ? profile.format_prefs : {}) as Record<string, unknown>;
  let card: any = null;
  if (ref.startsWith('telegram:')) {
    const r = await pool.query(`SELECT brief, title, formats, sources, hashtags FROM editor_channels WHERE channel_key = $1`, [ref.slice('telegram:'.length)]);
    card = r.rows[0] ?? null;
  }
  const kind = resourceKind({
    contentKind: typeof fp.content_kind === 'string' ? fp.content_kind : null,
    topic: typeof profile.topic === 'string' ? profile.topic : null,
    card: card ? { brief: card.brief ?? '', title: card.title ?? null, formats: card.formats ?? {}, sources: card.sources ?? [] } : null,
  });
  const stored = parseStoredStyle(fp.style);
  return {
    stored, effective: effectiveStyle(stored, { kind, vocabulary: card?.hashtags ?? null }), kind,
    defaulted: STYLE_DEFAULTED.filter((k) => stored[k] === undefined),
    ...(card ? { vocabulary: card.hashtags ?? [] } : {}),
  };
}
