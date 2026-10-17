import type { ResourceStyle } from '../post/style/resource-style';

/**
 * Spec 041 FR-003 (T3): the owner's rules as style. Precedence: owner rule > profile (`format_prefs.style`, which also
 * holds what 042 setup applied) > card > inferred defaults. Review 2 found «без хештегів» and «простіше» kept only in
 * the rules block while the style sheet, the lint and the planner went by the profile, so the posts got hashtags and
 * jargon. The overlay reads the rules code can understand; every other rule stays a prompt rule the critic checks.
 *
 *   «без хештегів»                               → hashtags: off
 *   «без сленгу»                                 → slang: false
 *   «простіше», «простими словами», «для новачків» → audience.level: beginner
 */

export interface OverlayRule { id: number; text: string }

export interface StyleOverlay {
  hashtags?: 'off';
  slang?:    false;
  level?:    'beginner';
  /** The rule behind each field (for the conflict detail and the prompt line). */
  rule_ids:  Partial<Record<'hashtags' | 'slang' | 'level', number>>;
}

export const NO_HASHTAGS_RE = /(без|ні|не\s+(?:став|додав|пиши|використов)\p{L}*|no|without|don't\s+use)\s+(?:\p{L}+\s+){0,2}?(хештег|хэштег|hashtag|#)/iu;
export const NO_SLANG_RE = /(без|не\s+(?:вживай|використов|пиши)\p{L}*|no|without)\s+(?:\p{L}+\s+){0,2}?(сленг|slang)/iu;
export const SIMPLER_RE = /(простіш|простими\s+словами|простою\s+мовою|для\s+(?:новачк|початківц|чайник)|без\s+(?:складн\p{L}*\s+)?(?:термін|жаргон)|зрозуміл\p{L}*\s+(?:всім|кожному|усім)|simpler|plain\s+(?:words|language)|for\s+beginners)/iu;

export function ownerStyleOverlay(rules: readonly OverlayRule[]): StyleOverlay {
  const out: StyleOverlay = { rule_ids: {} };
  const hit = (re: RegExp) => rules.find((r) => re.test(r.text));
  const h = hit(NO_HASHTAGS_RE);
  if (h) { out.hashtags = 'off'; out.rule_ids.hashtags = h.id; }
  const s = hit(NO_SLANG_RE);
  if (s) { out.slang = false; out.rule_ids.slang = s.id; }
  const l = hit(SIMPLER_RE);
  if (l) { out.level = 'beginner'; out.rule_ids.level = l.id; }
  return out;
}

export const overlayEmpty = (o: StyleOverlay) => !o.hashtags && o.slang === undefined && !o.level;

/** The style with the overlay on top: an owner rule beats the stored style and the defaults. */
export function applyStyleOverlay(style: ResourceStyle, o: StyleOverlay): ResourceStyle {
  if (overlayEmpty(o)) return style;
  return {
    ...style,
    ...(o.hashtags ? { hashtags: o.hashtags } : {}),
    ...(o.level ? { audience: { level: o.level } } : {}),
  };
}

/** Owner rules from a card row's `owner_rules` json (CARD_SELECT); anything malformed is dropped. */
export function rowOwnerRules(raw: unknown): OverlayRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => (x && typeof x === 'object' && typeof (x as any).text === 'string' && Number.isFinite(Number((x as any).id))
    ? [{ id: Number((x as any).id), text: (x as any).text as string }] : []));
}

/**
 * The planner's one-line style summary (Ukrainian, like the planner prompt): what the plan must respect, so a slot is
 * never planned for a format or tone the style forbids.
 */
export function plannerStyleLine(style: ResourceStyle | null | undefined, slang: boolean | undefined): string | null {
  if (!style) return null;
  const parts: string[] = [];
  if (style.content_kind) parts.push(`тип ресурсу ${style.content_kind}`);
  if (style.audience?.level) parts.push(`аудиторія ${style.audience.level === 'beginner' ? 'початківці (прості теми, без жаргону)' : style.audience.level === 'expert' ? 'фахівці' : 'широка'}`);
  if (style.hashtags === 'off') parts.push('без хештегів');
  if (slang !== true) parts.push('без сленгу');
  return parts.length ? `Стиль ресурсу: ${parts.join('; ')}.` : null;
}
