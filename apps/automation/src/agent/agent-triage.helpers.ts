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
