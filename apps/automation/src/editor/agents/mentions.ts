/**
 * `@handle` mentions in an owner chat message (spec 018 FR-002). Quoted lines
 * ("> …") are ignored, so pasting someone's message never re-addresses the chat.
 */
const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([A-Za-z][A-Za-z0-9_]{1,63})/gu;

export interface Mention {
  handle: string;
  /** Offset in the unquoted text. */
  index:  number;
}

export function unquoted(text: string): string {
  return text.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

/** Mentions in order of appearance (lower-cased, without "@"), outside quote lines. */
export function parseMentions(text: string): Mention[] {
  const src = unquoted(text);
  const out: Mention[] = [];
  for (const m of src.matchAll(MENTION_RE)) {
    out.push({ handle: m[2].toLowerCase(), index: (m.index ?? 0) + m[1].length });
  }
  return out;
}

/** Does the (unquoted) message start with this mention (after whitespace)? */
export function startsWithMention(text: string, handle: string): boolean {
  return new RegExp(`^\\s*@${handle.replace(/[^a-z0-9_]/gi, '')}(?![A-Za-z0-9_])`, 'i').test(unquoted(text));
}

const CHANGE_VERBS = [
  // uk
  'створ', 'зроби агента', 'додай агента', 'перейменуй', 'назви', 'постав на паузу', 'поставь на паузу', 'пауза', 'призупин', 'зупини', 'віднови', 'увімкни', 'вимкни',
  'зміни', 'змінити', 'онови', 'оновити', 'видали', 'прибери', 'додай скіл', 'додай собі', 'скіл', 'бриф', 'профіль', 'розклад', 'бюджет', 'переведи', 'запусти', 'затверди',
  // ru
  'создай', 'переименуй', 'поставь на паузу', 'останови', 'возобнови', 'включи', 'выключи', 'измени', 'обнови', 'удали', 'добавь',
  // en
  'create', 'rename', 'pause', 'resume', 'enable', 'disable', 'change', 'update', 'delete', 'remove', 'add skill', 'set ',
];
const NEGATION_RE = /(?:^|[^\p{L}])(?:не|не\s+треба|не\s+потрібно|don't|do\s+not|не\s+надо)\s+(?:\p{L}+\s+){0,1}?(?:створ|перейменуй|зміни|видали|create|rename|change|delete|pause|паузу)/iu;

/**
 * Did the owner ask, in THIS message, to change agents (create, rename, pause,
 * edit skills…)? Mutating builder tools refuse without it (FR-005), so text from
 * an inspected channel can never trigger a change. Deliberately broad: the card
 * click is the real confirmation; this gate only blocks the model acting on its own.
 */
export function hasAgentChangeIntent(message: string): boolean {
  const t = unquoted(message).toLowerCase();
  if (NEGATION_RE.test(t)) return false;
  return CHANGE_VERBS.some((v) => t.includes(v));
}

const WORD_RE = /[\p{L}\p{N}]{3,}/gu;

/**
 * Share of the rule's words that the owner actually wrote in the latest message.
 * add_owner_rule needs ≥ 0.5, so a "rule" can only paraphrase the owner, never
 * come from a fetched page (prompt injection).
 */
export function ruleOverlap(rule: string, ownerMessage: string): number {
  const words = (s: string) => new Set((s.toLowerCase().match(WORD_RE) ?? []).map((w) => w.slice(0, 5)));
  const r = words(rule);
  if (!r.size) return 0;
  const m = words(ownerMessage);
  let hit = 0;
  for (const w of r) if (m.has(w)) hit++;
  return hit / r.size;
}
