/**
 * Owner preferences learnt from approval decisions (spec 031 FR-008). Each
 * owner edit becomes a compact before/after note and each reject reason a note
 * of what to avoid; both go into the channel memory as owner entries tagged
 * `evidence.source = 'approval'`, and the planner and executor prompts show
 * the last 20 (APPROVAL_PREFS_IN_PROMPT). The notes are prompt text for the
 * agents, so they are written in the language of the prompts (Ukrainian).
 */

export const APPROVAL_PREFS_IN_PROMPT = 20;
export const APPROVAL_PREF_SOURCE = 'approval';

const MAX_NOTE = 700;
const SNIPPET = 90;

export interface OwnerPreference {
  kind:     'rule' | 'avoid';
  text:     string;
  evidence: { source: typeof APPROVAL_PREF_SOURCE; action: 'edit' | 'reject'; slotId: string; resourceRef: string | null; topic: string };
}

type AnySpec = Record<string, any> | null | undefined;

const clip = (s: string, n = SNIPPET) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The reader-facing text of a post spec: Telegram blocks (lead first) or a platform caption. */
function textParts(spec: AnySpec): { lead: string; rest: string[] } {
  if (!spec) return { lead: '', rest: [] };
  if (typeof spec.caption === 'string') {
    const lines = spec.caption.split(/\n+/).map((l: string) => l.trim()).filter(Boolean);
    return { lead: lines[0] ?? '', rest: lines.slice(1) };
  }
  const blocks: any[] = Array.isArray(spec.body) ? spec.body : [];
  const parts: string[] = [];
  let lead = '';
  for (const b of blocks) {
    if (b?.type === 'lead' && !lead) lead = String(b.text ?? '');
    else if (b?.type === 'list' || b?.type === 'olist') parts.push(...(b.items ?? []).map(String));
    else if (b?.text) parts.push(String(b.text));
  }
  if (!lead && parts.length) lead = parts.shift()!;
  return { lead, rest: parts };
}

function sentences(parts: string[]): string[] {
  return parts.flatMap((p) => p.split(/(?<=[.!?…])\s+|\n+/u)).map((s) => s.trim()).filter((s) => s.length > 2);
}

const fullText = (spec: AnySpec) => { const t = textParts(spec); return [t.lead, ...t.rest].join('\n'); };

const tags = (spec: AnySpec): string[] => (Array.isArray(spec?.hashtags) ? spec!.hashtags.map((h: string) => String(h).replace(/^#/, '')) : []);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What the owner changed, as short Ukrainian clauses: format, length, the
 * intro, removed and added sentences, hashtags, media, links/buttons, poll,
 * slides. Null when nothing the reader sees changed.
 */
export function describeEdit(before: AnySpec, after: AnySpec): string[] | null {
  const out: string[] = [];
  if (before?.format && after?.format && before.format !== after.format) out.push(`змінив формат ${before.format} → ${after.format}`);

  const a = textParts(before);
  const b = textParts(after);
  const la = fullText(before).length;
  const lb = fullText(after).length;
  if (la && lb && Math.abs(lb - la) >= 20 && Math.abs(lb - la) / la >= 0.1) {
    out.push(`${lb < la ? 'скоротив' : 'розширив'} текст (${la} → ${lb} симв.)`);
  }
  if (a.lead && b.lead && norm(a.lead) !== norm(b.lead)) out.push(`переписав вступ: «${clip(a.lead)}» → «${clip(b.lead)}»`);

  const sa = sentences(a.rest);
  const sb = sentences(b.rest);
  const inB = new Set(sb.map(norm));
  const inA = new Set(sa.map(norm));
  const removed = sa.filter((s) => !inB.has(norm(s)));
  const added = sb.filter((s) => !inA.has(norm(s)));
  if (removed.length) out.push(`прибрав: ${removed.slice(0, 2).map((s) => `«${clip(s)}»`).join(', ')}${removed.length > 2 ? ` і ще ${removed.length - 2}` : ''}`);
  if (added.length) out.push(`додав: ${added.slice(0, 2).map((s) => `«${clip(s)}»`).join(', ')}${added.length > 2 ? ` і ще ${added.length - 2}` : ''}`);

  const ta = tags(before);
  const tb = tags(after);
  const goneTags = ta.filter((t) => !tb.includes(t));
  const newTags = tb.filter((t) => !ta.includes(t));
  if (goneTags.length) out.push(`прибрав хештеги ${goneTags.map((t) => `#${t}`).join(' ')}`);
  if (newTags.length) out.push(`додав хештеги ${newTags.map((t) => `#${t}`).join(' ')}`);

  const ma = Array.isArray(before?.media) ? before!.media.length : 0;
  const mb = Array.isArray(after?.media) ? after!.media.length : 0;
  if (ma !== mb) out.push(`змінив кількість медіа (${ma} → ${mb})`);
  else if (!same(before?.media?.map((m: any) => m?.url), after?.media?.map((m: any) => m?.url))) out.push('замінив медіа');
  if (!same(before?.cta, after?.cta) || !same(before?.buttons, after?.buttons) || !same(before?.link, after?.link)) out.push('змінив кнопку чи посилання');
  if (!same(before?.poll, after?.poll)) out.push('змінив опитування');
  if (!same(before?.slides, after?.slides)) out.push('змінив слайди');
  if (!same(before?.first_comment, after?.first_comment)) out.push('змінив перший коментар');
  return out.length ? out : null;
}

const where = (resourceRef: string | null) => (resourceRef && !resourceRef.startsWith('telegram:') ? ` (${resourceRef})` : '');

/** The memory entry of an owner edit, or null when the edit changed nothing the reader sees. */
export function editPreference(o: { slotId: string; topic: string; resourceRef: string | null; before: unknown; after: unknown }): OwnerPreference | null {
  const changes = describeEdit(o.before as AnySpec, o.after as AnySpec);
  if (!changes) return null;
  const text = `Власник відредагував пост «${clip(o.topic, 80)}»${where(o.resourceRef)} перед апрувом: ${changes.join('; ')}.`;
  return {
    kind: 'rule', text: text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text,
    evidence: { source: APPROVAL_PREF_SOURCE, action: 'edit', slotId: o.slotId, resourceRef: o.resourceRef, topic: o.topic },
  };
}

/** The memory entry of a rejection with a reason (a rejection without one teaches nothing specific). */
export function rejectPreference(o: { slotId: string; topic: string; resourceRef: string | null; reason: string | null }): OwnerPreference | null {
  const reason = o.reason?.trim();
  if (!reason) return null;
  return {
    kind: 'avoid',
    text: `Власник відхилив пост «${clip(o.topic, 80)}»${where(o.resourceRef)}: ${clip(reason, 400)}`,
    evidence: { source: APPROVAL_PREF_SOURCE, action: 'reject', slotId: o.slotId, resourceRef: o.resourceRef, topic: o.topic },
  };
}
