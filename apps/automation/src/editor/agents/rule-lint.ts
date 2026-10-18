/**
 * Spec 047 FR-004: owner rules are linted when they are written and on the agent page. Review 1 left junk active:
 * #15 «Ці правила завжди виконуються для всіх постів» (a pointer with no content — the owner's 8-point list it pointed at
 * was lost), #14 names a skill "poster-bank" that does not exist, #10 is a request to the agent, not a rule.
 */

export type RuleIssueCode = 'pointer_only' | 'too_vague' | 'meta_request' | 'unknown_skill' | 'unknown_agent';

export interface RuleIssue { code: RuleIssueCode; detail: string }

export interface RuleLintContext {
  /** Does a skill with this name exist for the agent or as a shared skill? Absent → skills are not checked. */
  skillExists?: (name: string) => Promise<boolean>;
  /** Agent handles of the network (without "@"). Absent → handles are not checked. */
  handles?: string[];
}

/** Words that carry no content of their own in a rule (pointers, "always", "posts"…). */
const FILLER = new Set([
  // uk
  'ці', 'ця', 'це', 'цей', 'цих', 'ті', 'той', 'та', 'те', 'такі', 'такий', 'вище', 'наведені', 'перелічені', 'вищезгадані', 'згадані', 'усі', 'всі',
  'всіх', 'усіх', 'для', 'правила', 'правило', 'правил', 'пункти', 'пунктів', 'завжди', 'виконуються', 'виконувались', 'виконуватись', 'виконувати',
  'дотримуватись', 'дотримуйся', 'мають', 'має', 'повинні', 'треба', 'потрібно', 'щоб', 'постів', 'пости', 'поста', 'посту', 'постах', 'кожного', 'кожен',
  'кожному', 'наших', 'наші', 'мої', 'моїх', 'мене', 'мені', 'вони', 'них', 'їх', 'тут', 'там', 'так', 'також', 'теж', 'будь', 'ласка', 'дякую',
  // ru
  'эти', 'все', 'всех', 'правила', 'всегда', 'постов',
  // en
  'these', 'those', 'this', 'that', 'the', 'rules', 'rule', 'always', 'all', 'every', 'posts', 'post', 'for', 'must', 'should', 'apply', 'applied',
  'follow', 'followed', 'please', 'above', 'listed',
]);
const POINTER_RE = /(?<![\p{L}])(?:ці|ті|такі|вищезгадані|вище\s+наведені|перелічені|наведені\s+вище|ці\s+пункти|these|those|the\s+above|above)(?![\p{L}])/iu;
/** A request to the agent, not a rule about posts: «запамʼятай це», «додай правило», «remember this». */
const META_RE = /^(?:\s*(?:@\w+\s+)?)(?:запам['ʼ]?ятай|запиши|додай\s+(?:правило|в\s+памʼять|в\s+пам'ять)|збережи|remember|save|add\s+(?:a\s+)?rule)(?![\p{L}])/iu;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'ʼ-]*/gu;
const KEBAB_RE = /(?<![\p{L}\p{N}_-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\p{L}\p{N}_-])/gu;
const HANDLE_RE = /(?:^|[^\p{L}\p{N}_@])@([A-Za-z][A-Za-z0-9_]{1,63})/gu;

/** Content words of a rule: 3+ characters (or a digit), not filler. «Без хештегів» → [без, хештегів]. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).filter((w) => (w.length >= 3 || /\d/.test(w)) && !FILLER.has(w));
}

export const MIN_CONTENT_WORDS = 2;
/** A rule that points at something («ці правила…») needs this much content of its own. */
export const MIN_POINTER_CONTENT_WORDS = 4;

export async function lintOwnerRule(text: string, c: RuleLintContext = {}): Promise<RuleIssue[]> {
  const out: RuleIssue[] = [];
  const words = contentWords(text);
  if (POINTER_RE.test(text) && words.length < MIN_POINTER_CONTENT_WORDS) {
    out.push({ code: 'pointer_only', detail: 'the rule points at other text ("these rules") instead of saying what to do — write the points themselves' });
  } else if (words.length < MIN_CONTENT_WORDS) {
    out.push({ code: 'too_vague', detail: 'the rule says too little to follow — name what to do or avoid' });
  }
  if (META_RE.test(text)) out.push({ code: 'meta_request', detail: 'this is a request to the agent, not a rule for posts — keep only what the posts must follow' });
  if (c.skillExists && /скіл|skill/i.test(text)) {
    const missing: string[] = [];
    for (const name of new Set(text.toLowerCase().match(KEBAB_RE) ?? [])) if (!(await c.skillExists(name).catch(() => true))) missing.push(name);
    if (missing.length) out.push({ code: 'unknown_skill', detail: `no such skill: ${missing.join(', ')}` });
  }
  if (c.handles) {
    const known = new Set(c.handles.map((h) => h.replace(/^@/, '').toLowerCase()));
    const unknown = [...new Set([...text.matchAll(HANDLE_RE)].map((m) => m[1].toLowerCase()))].filter((h) => !known.has(h));
    if (unknown.length) out.push({ code: 'unknown_agent', detail: `no such agent: ${unknown.map((h) => `@${h}`).join(', ')} (agents: ${[...known].map((h) => `@${h}`).join(', ')})` });
  }
  return out;
}

const POINT_RE = /^\s*(?:\d{1,2}[.)]|[-•*–—]|[✅✔️❌🚫▪️◾️])\s*(.+?)\s*$/u;
export const MAX_RULE_POINTS = 12;
export const MAX_POINT_CHARS = 300;

/**
 * The points of a list in the owner's message («1. …», «- …», «• …»), when it has two or more. A rule built from them
 * keeps the owner's own words, so nothing of a long list is lost to a paraphrase.
 */
export function ownerListPoints(message: string): string[] {
  const pts = message.split('\n').map((l) => POINT_RE.exec(l)?.[1]?.trim() ?? '').filter((p) => contentWords(p).length >= 1);
  return pts.length >= 2 ? pts.slice(0, MAX_RULE_POINTS).map((p) => p.slice(0, MAX_POINT_CHARS)) : [];
}

/** One rule with several points: a short heading (optional) and the numbered points, one per line. */
export function multiPointRule(points: string[], heading?: string | null): string {
  const head = heading?.trim().replace(/[:.]\s*$/, '');
  return [...(head ? [`${head}:`] : []), ...points.map((p, i) => `${i + 1}. ${p.replace(/^\d{1,2}[.)]\s*/, '')}`)].join('\n');
}
