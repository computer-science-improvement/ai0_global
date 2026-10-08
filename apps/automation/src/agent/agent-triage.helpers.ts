import type { AgentCategory, TriageResult } from './agent.types';

const CATEGORIES: AgentCategory[] = ['ad', 'vp', 'question', 'spam', 'other'];

export function buildTriagePrompt(messageText: string): { system: string; user: string } {
  const system = [
    'You triage an incoming Telegram DM to the owner of a Ukrainian media network.',
    'Classify it and reply ONLY with a single JSON object, no prose, no code fence.',
    'Schema: {"category": "ad|vp|question|spam|other", "summary": string (Ukrainian, <= 200 chars),',
    '"fields": {"channel"?: string, "budget"?: string, "dates"?: string},',
    '"draftReply": string (Ukrainian, a short polite reply the owner could send),',
    '"score": integer 0-100 (business priority; ad/vp with budget = high, spam = 0)}.',
    'category meanings: ad = wants to buy ad placement; vp = mutual promotion (взаємний піар);',
    'question = a genuine question; spam = unsolicited junk; other = anything else.',
  ].join('\n');
  const user = `Message:\n"""\n${messageText}\n"""`;
  return { system, user };
}

export function parseTriageResult(raw: string): TriageResult {
  const fallback: TriageResult = { category: 'other', summary: '', fields: {}, draftReply: '', score: 0 };
  if (!raw) return fallback;
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  let obj: any;
  try { obj = JSON.parse(stripped); } catch { return fallback; }
  if (!obj || typeof obj !== 'object') return fallback;

  const category: AgentCategory = CATEGORIES.includes(obj.category) ? obj.category : 'other';
  const rawScore = Number(obj.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const f = obj.fields && typeof obj.fields === 'object' ? obj.fields : {};
  return {
    category,
    summary:    typeof obj.summary === 'string' ? obj.summary.slice(0, 400) : '',
    fields:     {
      channel: typeof f.channel === 'string' ? f.channel : undefined,
      budget:  typeof f.budget === 'string' ? f.budget : undefined,
      dates:   typeof f.dates === 'string' ? f.dates : undefined,
    },
    draftReply: typeof obj.draftReply === 'string' ? obj.draftReply : '',
    score,
  };
}

// ── Spec 026 FR-016: DM attribution from the public landing ─────────────────
// Every "Order an ad in Telegram" link on the landing prefills a message that ends
// with `[ai0web:<placement>]` or `[ai0web:<placement>:<channel_key>]` (built by
// config/landing-dm.ts). A forged tag only sets attribution and the `ad` category:
// no price, payment or send depends on it.

export const LANDING_REF_RE = /\[ai0web:([a-z_]{2,16})(?::@?([A-Za-z0-9_]{3,64}))?\]/;

export interface LandingRef { placement: string; channel: string | null }

/** The landing tag in a DM text, or null when there is none (the first tag wins). */
export function parseLandingRef(text: string | null | undefined): LandingRef | null {
  if (typeof text !== 'string' || !text) return null;
  const m = LANDING_REF_RE.exec(text);
  return m ? { placement: m[1], channel: m[2] ?? null } : null;
}

/** The landing attribution already stored on a thread (`fields.source = 'landing'`), if any. */
export function storedLandingRef(fields: Record<string, unknown> | null | undefined): LandingRef | null {
  if (!fields || fields.source !== 'landing') return null;
  return {
    placement: typeof fields.placement === 'string' ? fields.placement : 'unknown',
    channel:   typeof fields.channel === 'string' && fields.channel ? fields.channel : null,
  };
}

/**
 * Merge a triage result with the landing attribution (FR-016):
 * - fields are merged onto what the thread already has, so an untagged follow-up
 *   keeps `source`, `placement` and the tagged `channel` (the model may still name a
 *   channel explicitly, and then it wins: the advertiser said so);
 * - a tagged message sets `source='landing'`, its `placement` and, when the tag names
 *   one, its `channel` (the tag beats the model's guess for that message);
 * - an attributed thread (tag now or earlier) is an ad inquiry: `other` and
 *   `question` become `ad` (spam and cross-promo stay as the model said).
 */
export function applyLandingAttribution(
  t: TriageResult,
  ref: LandingRef | null,
  existing: Record<string, unknown> | null | undefined,
): TriageResult {
  const modelFields = Object.fromEntries(Object.entries(t.fields).filter(([, v]) => typeof v === 'string' && v !== ''));
  const fields: Record<string, unknown> = { ...(existing ?? {}), ...modelFields };
  if (ref) {
    fields.source = 'landing';
    fields.placement = ref.placement;
    if (ref.channel) fields.channel = ref.channel;
  }
  const attributed = ref !== null || storedLandingRef(existing) !== null;
  const category: AgentCategory = attributed && (t.category === 'other' || t.category === 'question') ? 'ad' : t.category;
  return { ...t, category, fields: fields as TriageResult['fields'] };
}
