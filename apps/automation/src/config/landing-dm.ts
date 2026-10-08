// apps/automation/src/config/landing-dm.ts
// Spec 026 FR-003: the "order an ad in Telegram" deep link. Pure and side-effect free:
// the server renders every link (the public page has no template logic), and the
// admin card previews a draft template through the same function.
//
// A link is `https://t.me/<username>?text=<message>`. The message is the owner's
// template with {target} (a channel or network title) and {ref} (an attribution tag
// `[ai0web:<placement>]` or `[ai0web:<placement>:<channel_key>]`, parsed back by the
// DM triage in T5). The message is capped at 300 characters by shortening the target;
// the tag is never cut.

export const LANDING_PLACEMENTS = [
  'hero', 'topbar', 'network', 'resource', 'mediakit', 'advertise', 'footer', 'howitworks',
] as const;
export type LandingPlacement = (typeof LANDING_PLACEMENTS)[number];

/** Placements whose target is the whole network (no channel): the public config renders these. */
export const NETWORK_PLACEMENTS = ['hero', 'topbar', 'advertise', 'footer', 'howitworks'] as const satisfies readonly LandingPlacement[];
export type NetworkPlacement = (typeof NETWORK_PLACEMENTS)[number];

/** Telegram's public username rule (5–32 chars, starts with a letter). */
export const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
/** The channel key inside a ref tag (FR-016 parses `@?[A-Za-z0-9_]{3,64}`). */
const REF_CHANNEL_RE = /^[A-Za-z0-9_]{3,64}$/;

export const AD_MESSAGE_MAX = 300;
/** A template longer than this is refused on save (it leaves no room for the target). */
export const AD_TEMPLATE_MAX = 240;
export const DEFAULT_AD_MESSAGE = "Hi! I'd like to order an ad in {target}. {ref}";
export const DEFAULT_AD_TARGET = 'the ai0 network';
const ELLIPSIS = '…';

export function isLandingPlacement(v: unknown): v is LandingPlacement {
  return typeof v === 'string' && (LANDING_PLACEMENTS as readonly string[]).includes(v);
}

/** `@Name`, ` Name ` and `https://t.me/Name` → `Name`; anything that is not a valid username → null. */
export function normalizeTgUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  v = v.replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\//i, '');
  v = v.replace(/^@/, '').replace(/\/+$/, '');
  return TG_USERNAME_RE.test(v) ? v : null;
}

/** `[ai0web:<placement>]`, plus `:<channel_key>` when the key is usable in a tag. */
export function buildLandingRef(placement: LandingPlacement, channelKey?: string | null): string {
  const key = typeof channelKey === 'string' ? channelKey.trim().replace(/^@/, '') : '';
  return REF_CHANNEL_RE.test(key) ? `[ai0web:${placement}:${key}]` : `[ai0web:${placement}]`;
}

/** Placeholders a template may use; anything else in braces is a typo. */
export const TEMPLATE_PLACEHOLDERS = ['{target}', '{ref}'] as const;

/** Problems with an owner template ([] when it is usable). */
export function validateAdTemplate(template: string): string[] {
  const issues: string[] = [];
  if (template.trim().length === 0) issues.push('The message template is empty.');
  if (chars(template).length > AD_TEMPLATE_MAX) issues.push(`The message template is longer than ${AD_TEMPLATE_MAX} characters.`);
  const unknown = (template.match(/\{[^{}]*\}/g) ?? []).filter((p) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown.length > 0) issues.push(`Unknown placeholder ${unknown[0]}: use {target} and {ref}.`);
  return issues;
}

/** Code points, so a cut never splits an emoji or a surrogate pair. */
function chars(s: string): string[] {
  return Array.from(s);
}

function fill(template: string, target: string, ref: string): string {
  // Function replacers: a `$&` in a title must stay literal.
  return template.replace(/\{target\}/g, () => target).replace(/\{ref\}/g, () => ref);
}

/**
 * The message text: the template with {target} and {ref} filled in, at most
 * AD_MESSAGE_MAX characters. A template without {ref} gets the tag appended, so
 * attribution never depends on the owner remembering it. Over the cap, the target
 * is shortened (with an ellipsis); if the fixed text alone is too long, the text is
 * cut before the tag. The tag itself is always whole.
 */
export function renderAdMessage(input: { template: string; target?: string | null; ref: string }): string {
  const template = input.template.includes('{ref}') ? input.template : `${input.template.trimEnd()} {ref}`;
  const target = (input.target ?? '').trim() || DEFAULT_AD_TARGET;
  const full = fill(template, target, input.ref);
  if (chars(full).length <= AD_MESSAGE_MAX) return full;

  // Shorten the target: every {target} occurrence costs its length again.
  const occurrences = (template.match(/\{target\}/g) ?? []).length;
  if (occurrences > 0) {
    const fixed = chars(fill(template, '', input.ref)).length;
    const room = Math.floor((AD_MESSAGE_MAX - fixed) / occurrences) - 1; // 1 for the ellipsis
    if (room >= 1) {
      const short = chars(target).slice(0, room).join('').trimEnd() + ELLIPSIS;
      const msg = fill(template, short, input.ref);
      if (chars(msg).length <= AD_MESSAGE_MAX) return msg;
    }
  }
  // The fixed text alone is too long: keep the start of the text, then the whole tag.
  const withoutRef = fill(template.replace(/\{ref\}/g, ''), target, '').trimEnd();
  const keep = AD_MESSAGE_MAX - chars(input.ref).length - 2; // a space and the ellipsis
  return `${chars(withoutRef).slice(0, Math.max(0, keep)).join('').trimEnd()}${ELLIPSIS} ${input.ref}`;
}

export interface AdDmInput {
  username: string | null | undefined;
  template: string;
  /** Channel or network title; empty → "the ai0 network". */
  target?: string | null;
  placement: LandingPlacement;
  /** The channel the CTA belongs to (resource, mediakit, network placements). */
  channelKey?: string | null;
}

/** `https://t.me/<username>?text=<encoded message>`, or null when the username is not valid. */
export function buildAdDmUrl(input: AdDmInput): string | null {
  const username = normalizeTgUsername(input.username);
  if (!username) return null;
  const message = renderAdMessage({
    template: input.template,
    target: input.target,
    ref: buildLandingRef(input.placement, input.channelKey),
  });
  return `https://t.me/${username}?text=${encodeURIComponent(message)}`;
}
