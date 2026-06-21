import type { Opportunity, OpportunityKind, SuggestedAction } from './agent.types';

const KINDS: OpportunityKind[] = ['ad_offer', 'vp_request', 'pricing', 'other'];
const ACTIONS: SuggestedAction[] = ['advertise', 'do_vp', 'skip'];
// Cheap heuristic so most chatter never reaches the model.
const KEYWORDS = ['реклам', 'вп', 'взаємн', 'взаимн', 'прайс', 'розміщенн', 'размещен', 'бартер', 'співпрац', 'сотруднич', 'ad', 'promo'];
const PRICE_RE = /\d+\s?(грн|uah|₴|\$|usd)/i;

export function isOpportunityCandidate(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (PRICE_RE.test(t)) return true;
  return KEYWORDS.some(k => t.includes(k));
}

export function buildOpportunityPrompt(text: string): { system: string; user: string } {
  const system = [
    'You analyze a message from a Telegram group the owner of a media network is in.',
    'Decide if it is a monetization/collaboration opportunity and reply ONLY with one JSON object, no prose, no code fence.',
    'Schema: {"kind":"ad_offer|vp_request|pricing|other","summary":string(Ukrainian,<=200),',
    '"score":integer 0-100 (business value),"suggestedAction":"advertise|do_vp|skip"}.',
    'kind: ad_offer = someone offers/wants to buy ad placement; vp_request = mutual promotion (ВП);',
    'pricing = a price list / rate post; other = anything else.',
  ].join('\n');
  return { system, user: `Message:\n"""\n${text}\n"""` };
}

export function parseOpportunity(raw: string): Opportunity {
  const fb: Opportunity = { kind: 'other', summary: '', score: 0, suggestedAction: 'skip' };
  if (!raw) return fb;
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  let o: any;
  try { o = JSON.parse(stripped); } catch { return fb; }
  if (!o || typeof o !== 'object') return fb;
  const kind: OpportunityKind = KINDS.includes(o.kind) ? o.kind : 'other';
  const suggestedAction: SuggestedAction = ACTIONS.includes(o.suggestedAction) ? o.suggestedAction : 'skip';
  const rawScore = Number(o.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  return { kind, summary: typeof o.summary === 'string' ? o.summary.slice(0, 400) : '', score, suggestedAction };
}
