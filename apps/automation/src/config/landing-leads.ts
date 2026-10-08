// apps/automation/src/config/landing-leads.ts
// Spec 026 FR-011: validation and spam rules for the two public forms, pure (no I/O).
//   • kind 'ad'          — "No Telegram? Leave a request" next to every ad CTA;
//   • kind 'white_label' — the white-label request on #white-label and /white-label.
// The service (landing-leads.service.ts) does rate limiting, dedup, storage and the alert.
import { z } from 'zod';
import { isLandingPlacement } from './landing-dm';

export const LEAD_KINDS = ['ad', 'white_label'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost', 'spam'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_PLATFORMS = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube', 'other'] as const;
export const AUDIENCE_SIZES = ['lt_10k', '10k_100k', '100k_1m', 'gt_1m', 'unknown'] as const;
export const SERVICE_MODES = ['dedicated', 'consult', 'unsure'] as const;
export type ContactKind = 'telegram' | 'email' | 'phone';

export const LEAD_LIMITS = { contact: 200, message: 2000, name: 120, company: 200, target: 200, resources: 10, resourceUrl: 500 } as const;
/** A form sent faster than this after it opened is a bot (stored as spam, answered 201 like any lead). */
export const MIN_FILL_MS = 2500;
/** At most this many new-lead alerts a day; leads past the cap are still stored. */
export const DAILY_ALERT_CAP = 20;
/** `lost` and `spam` leads lose their message and resource links after this many days. */
export const LEAD_PURGE_DAYS = 180;

const TG_USER = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TG_LINK = /^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{6,22}$/;

/** `@name` / `t.me/name` → `{telegram, @name}`, an email → email, a phone → phone; null for anything else. */
export function normalizeContact(raw: string): { contact: string; kind: ContactKind } | null {
  const v = raw.trim();
  const link = TG_LINK.exec(v);
  if (link) return { contact: `@${link[1]}`, kind: 'telegram' };
  // A bare word is only a Telegram username with the @ (a name like "john_smith" is ambiguous).
  if (v.startsWith('@') && TG_USER.test(v)) return { contact: v, kind: 'telegram' };
  if (EMAIL.test(v)) return { contact: v.toLowerCase(), kind: 'email' };
  const digits = v.replace(/\D/g, '');
  if (PHONE.test(v) && digits.length >= 7 && digits.length <= 15) return { contact: v.replace(/\s+/g, ' '), kind: 'phone' };
  return null;
}

const CONTACT_HINT = 'Enter a Telegram @username, an email address or a phone number.';

const text = (max: number, label: string) =>
  z.string().trim().max(max, `${label} is longer than ${max} characters.`);
const optText = (max: number, label: string) =>
  z.preprocess((v) => (v === null || v === undefined ? undefined : v), text(max, label).optional())
    .transform((v) => (v ? v : undefined));

const httpUrl = z.string().trim().max(LEAD_LIMITS.resourceUrl, 'A link is too long.').refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && u.hostname.includes('.');
  } catch { return false; }
}, 'Each link must be a full http(s) address, like https://t.me/yourchannel.');

const common = {
  name:    optText(LEAD_LIMITS.name, 'The name'),
  contact: z.string({ error: CONTACT_HINT }).trim().min(1, CONTACT_HINT).max(LEAD_LIMITS.contact, `The contact is longer than ${LEAD_LIMITS.contact} characters.`)
    .refine((v) => normalizeContact(v) !== null, CONTACT_HINT),
  message: optText(LEAD_LIMITS.message, 'The message'),
  consent: z.literal(true, { error: 'Please agree to be contacted about this request.' }),
  placement: z.preprocess((v) => (isLandingPlacement(v) ? v : undefined), z.string().optional()),
  utm: z.preprocess(
    (v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>)
        .filter(([k, x]) => /^utm_(source|medium|campaign|term|content)$/.test(k) && typeof x === 'string' && x.trim())
        .map(([k, x]) => [k, String(x).trim().slice(0, 100)]))
      : undefined),
    z.record(z.string(), z.string()).optional(),
  ),
  // Spam signals (never stored): the honeypot and the time the form was open.
  website:   z.unknown().optional(),
  elapsedMs: z.unknown().optional(),
};

export const adLeadSchema = z.object({
  kind:   z.literal('ad'),
  target: optText(LEAD_LIMITS.target, 'The channel'),
  ...common,
});

export const whiteLabelLeadSchema = z.object({
  kind:         z.literal('white_label'),
  company:      optText(LEAD_LIMITS.company, 'The company'),
  resources:    z.preprocess((v) => (v === undefined || v === null ? [] : v),
    z.array(httpUrl, { error: 'Resource links must be a list.' }).max(LEAD_LIMITS.resources, `Add at most ${LEAD_LIMITS.resources} links.`)),
  platforms:    z.preprocess((v) => (v === undefined || v === null ? [] : v),
    z.array(z.enum(LEAD_PLATFORMS, { error: 'Unknown platform.' })).max(LEAD_PLATFORMS.length)),
  audienceSize: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(AUDIENCE_SIZES, { error: 'Pick an audience size.' }).optional()),
  serviceMode:  z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(SERVICE_MODES, { error: 'Pick how you would like us to help.' }).optional()),
  ...common,
  // A white-label request needs a name to address the reply to.
  name: text(LEAD_LIMITS.name, 'The name').min(1, 'Enter your name.'),
});

export interface LeadIssue { path: string; message: string }

/** A validated lead, ready for the DB (no spam signals, no IP). */
export interface LeadInput {
  kind:         LeadKind;
  name:         string | null;
  contact:      string;
  contactKind:  ContactKind;
  company:      string | null;
  resources:    string[];
  platforms:    string[] | null;
  audienceSize: string | null;
  serviceMode:  string | null;
  target:       string | null;
  message:      string | null;
  placement:    string | null;
  utm:          Record<string, string> | null;
}

export type ParsedLead =
  | { ok: true; lead: LeadInput; spam: boolean; spamReason: 'honeypot' | 'too_fast' | null }
  | { ok: false; kind: LeadKind | null; issues: LeadIssue[] };

/** The lead kind of a body, or null (checked first: the white-label flag gates before validation). */
export function leadKindOf(body: unknown): LeadKind | null {
  const k = body && typeof body === 'object' ? (body as Record<string, unknown>).kind : undefined;
  return (LEAD_KINDS as readonly unknown[]).includes(k) ? (k as LeadKind) : null;
}

/** Validate a POST /api/landing/leads body and read its spam signals. */
export function parseLead(body: unknown): ParsedLead {
  const kind = leadKindOf(body);
  if (!kind) return { ok: false, kind: null, issues: [{ path: 'kind', message: 'Unknown request type.' }] };
  const parsed = (kind === 'ad' ? adLeadSchema : whiteLabelLeadSchema).safeParse(body);
  if (!parsed.success) {
    const seen = new Set<string>();
    const issues: LeadIssue[] = [];
    for (const i of parsed.error.issues) {
      const path = i.path.length ? String(i.path[0]) : 'form';
      if (seen.has(path)) continue; // one message per field: the first is the one to fix
      seen.add(path);
      issues.push({ path, message: i.message });
    }
    return { ok: false, kind, issues };
  }
  const d = parsed.data as Omit<z.infer<typeof adLeadSchema>, 'kind'> & Partial<Omit<z.infer<typeof whiteLabelLeadSchema>, 'kind'>>;
  const contact = normalizeContact(d.contact)!;
  const honeypot = typeof d.website === 'string' ? d.website.trim() !== '' : d.website !== undefined && d.website !== null && d.website !== '';
  const elapsed = typeof d.elapsedMs === 'number' && Number.isFinite(d.elapsedMs) ? d.elapsedMs : null;
  const tooFast = elapsed !== null && elapsed < MIN_FILL_MS;
  const lead: LeadInput = {
    kind,
    name:         d.name ?? null,
    contact:      contact.contact,
    contactKind:  contact.kind,
    company:      kind === 'white_label' ? d.company ?? null : null,
    resources:    kind === 'white_label' ? [...new Set(d.resources ?? [])] : [],
    platforms:    kind === 'white_label' && d.platforms?.length ? [...new Set(d.platforms)] : null,
    audienceSize: kind === 'white_label' ? d.audienceSize ?? null : null,
    serviceMode:  kind === 'white_label' ? d.serviceMode ?? null : null,
    target:       kind === 'ad' ? d.target ?? null : null,
    message:      d.message ?? null,
    placement:    (d.placement as string | undefined) ?? null,
    utm:          d.utm && Object.keys(d.utm).length ? d.utm : null,
  };
  return { ok: true, lead, spam: honeypot || tooFast, spamReason: honeypot ? 'honeypot' : tooFast ? 'too_fast' : null };
}

const AUDIENCE_LABEL: Record<string, string> = {
  lt_10k: 'under 10k', '10k_100k': '10k–100k', '100k_1m': '100k–1M', gt_1m: 'over 1M', unknown: 'not sure',
};
const SERVICE_LABEL: Record<string, string> = { dedicated: 'dedicated deployment', consult: 'consultation', unsure: 'not sure yet' };

/**
 * The owner-inbox item for a new lead. The stored item carries no personal data (no
 * name, no contact): those stay in landing_leads (owner-only). The Telegram alert to
 * the owner's admin bot includes the contact so the owner can answer right away.
 */
export function leadInboxItem(id: string, l: LeadInput): {
  title: string; body: string; alert: { title: string; body: string };
} {
  const isAd = l.kind === 'ad';
  const title = isAd ? 'New ad request from the landing' : 'New white-label request from the landing';
  const facts = isAd
    ? [`Channel: ${l.target ?? 'the network'}`, l.placement ? `Button: ${l.placement}` : null]
    : [
      l.company ? `Company: ${l.company}` : null,
      l.platforms?.length ? `Platforms: ${l.platforms.join(', ')}` : null,
      l.audienceSize ? `Audience: ${AUDIENCE_LABEL[l.audienceSize] ?? l.audienceSize}` : null,
      l.serviceMode ? `Wants: ${SERVICE_LABEL[l.serviceMode] ?? l.serviceMode}` : null,
      l.resources.length ? `${l.resources.length} resource link(s)` : null,
    ];
  const body = [...facts.filter(Boolean), 'Open Landing → Leads in the dashboard to reply and set the status.'].join('\n');
  const alertBody = [
    `${l.name ? `${l.name} · ` : ''}${l.contact} (${l.contactKind})`,
    ...facts.filter(Boolean),
    l.message ? `“${l.message.slice(0, 300)}${l.message.length > 300 ? '…' : ''}”` : null,
    `Lead ${id.slice(0, 8)} · Landing → Leads`,
  ].filter(Boolean).join('\n');
  return { title, body, alert: { title, body: alertBody } };
}
