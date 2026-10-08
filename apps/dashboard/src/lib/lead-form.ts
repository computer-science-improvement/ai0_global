// Spec 026 FR-011: client-side checks for the two public forms. They mirror the
// server rules (apps/automation/src/config/landing-leads.ts) so a visitor sees the
// problem next to the field before sending; the server stays the authority.
import type { LandingPublicConfig } from '../api/landing';

export const LEAD_LIMITS = { contact: 200, message: 2000, name: 120, company: 200, target: 200, resources: 10 } as const;

const TG_USER = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TG_LINK = /^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/i;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{6,22}$/;

export const CONTACT_HINT = 'Enter a Telegram @username, an email address or a phone number.';

/** The kind of contact a visitor typed, or null when it is none of the three. */
export function contactKind(raw: string): 'telegram' | 'email' | 'phone' | null {
  const v = raw.trim();
  if (TG_LINK.test(v) || TG_USER.test(v)) return 'telegram';
  if (EMAIL.test(v)) return 'email';
  const digits = v.replace(/\D/g, '');
  if (PHONE.test(v) && digits.length >= 7 && digits.length <= 15) return 'phone';
  return null;
}

export function contactError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return CONTACT_HINT;
  if (v.length > LEAD_LIMITS.contact) return `The contact is longer than ${LEAD_LIMITS.contact} characters.`;
  return contactKind(v) ? null : CONTACT_HINT;
}

export function lengthError(raw: string, max: number, label: string): string | null {
  return raw.trim().length > max ? `${label} is longer than ${max} characters.` : null;
}

/** One link per line (or separated by spaces/commas) → the list, plus the first problem. */
export function parseResourceLinks(raw: string): { links: string[]; error: string | null } {
  const links = [...new Set(raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
  if (links.length > LEAD_LIMITS.resources) return { links, error: `Add at most ${LEAD_LIMITS.resources} links.` };
  for (const l of links) {
    let ok = false;
    try {
      const u = new URL(l);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.');
    } catch { ok = false; }
    if (!ok) return { links, error: `“${l.slice(0, 60)}” is not a full link. Use the form https://t.me/yourchannel.` };
  }
  return { links, error: null };
}

/** The white-label section, page and links show only once the config says the flag is on. */
export function whiteLabelVisible(config: Pick<LandingPublicConfig, 'whiteLabelEnabled'> | undefined): boolean {
  return config?.whiteLabelEnabled === true;
}

/** utm_* parameters of the current page (kept with a lead so the owner sees where it came from). */
export function utmFrom(search: string): Record<string, string> | undefined {
  const p = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = p.get(k);
    if (v && v.trim()) out[k] = v.trim().slice(0, 100);
  }
  return Object.keys(out).length ? out : undefined;
}
