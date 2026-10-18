import { hasAgentChangeIntent, unquoted } from '../agents/mentions';
import { hasScheduleChangeIntent } from '../schedule/schedule-intent';

/**
 * Spec 040 FR-009: a short "yes" to the assistant's proposal. The owner answered «так» / «+» / «ок» / «давай» / «yes, do it»
 * (or «nfr» — «так» typed in the English layout) and the gate refused because the reply has no verb. Short only: a longer
 * message says what it wants itself. Negation wins.
 */
const AFFIRMATIVE = new Set([
  'так', '+', '++', 'ок', 'окей', 'ok', 'okay', 'давай', 'давайте', 'yes', 'yep', 'sure', 'да', 'ага', 'угу', 'звісно', 'згоден', 'згодна',
  'роби', 'зроби', 'зробіть', 'погнали', 'го', 'do it', 'go', 'go ahead', 'yes do it', 'так роби', 'так зроби', 'так давай', 'ок давай',
  'підтверджую', 'confirm', 'approved', 'нормально', 'добре', 'гаразд',
  // The same words typed in the English layout.
  'nfr', 'jr', 'lfdfq', 'lf',
]);
const NEGATIVE_RE = /(?:^|[^\p{L}])(?:ні|нє|не|no|nope|don't|do\s+not|cancel|стоп|stop)(?:[^\p{L}]|$)/iu;
const MAX_AFFIRMATIVE_CHARS = 40;

export function isAffirmative(message: string): boolean {
  // «@ai0 так»: the addressee is not part of the answer.
  const t = unquoted(message).replace(/(^|\s)@[a-z][a-z0-9_]*/gi, ' ').trim().toLowerCase();
  if (!t || t.length > MAX_AFFIRMATIVE_CHARS || NEGATIVE_RE.test(t)) return false;
  const norm = t.replace(/[!.,…?👍✅🙏]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (AFFIRMATIVE.has(norm)) return true;
  // «так, роби», «ок, давай, дякую»: every word affirmative or a thanks.
  const words = norm.split(' ');
  return words.length <= 4 && words.every((w) => AFFIRMATIVE.has(w) || /^(дякую|спасибі|thanks|thx|будь|ласка|please)$/.test(w));
}

/** An offer is usually phrased with an infinitive: «Можу перейменувати…», «Скасувати слот на 18:00?», «Shall I rename…». */
const OFFER_VERB_RE = /(?<![\p{L}])(?:перейменувати|створити|змінити|оновити|видалити|прибрати|додати|поставити|призупинити|зупинити|відновити|увімкнути|вимкнути|перепланувати|скасувати|відмінити|перенести|пропустити|перезапустити|перегенерувати|записати|зберегти|запустити|rename|create|change|update|delete|remove|add|pause|resume|enable|disable|cancel|reschedule|skip|move|regenerate|replan|save)(?![\p{L}])/iu;

/** Did the assistant's turn propose a change (an offer or a question with a change verb)? */
export function proposedChange(assistantText: string | null | undefined): boolean {
  if (!assistantText) return false;
  return OFFER_VERB_RE.test(assistantText) || hasAgentChangeIntent(assistantText) || hasScheduleChangeIntent(assistantText);
}

const MAX_PICK_CHARS = 120;
const ORDINALS: Record<string, number> = {
  перший: 1, перша: 1, перше: 1, другий: 2, друга: 2, друге: 2, третій: 3, третя: 3, третє: 3, четвертий: 4, четверта: 4, четверте: 4,
  first: 1, second: 2, third: 3, fourth: 4,
};
const norm = (s: string) => s.toLowerCase().replace(/[*_`«»"“”'’.,!?…:;()\[\]]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Spec 047 FR-001: the options an assistant turn offered — list items («1. Машина», «- Ракета»), quoted names («Машина»,
 * "Rocket") and bold ones (**Машина**). In order; a list item counts from its text before a dash or a colon.
 */
export function offeredOptions(assistantText: string | null | undefined): string[] {
  if (!assistantText) return [];
  const out: string[] = [];
  const add = (v: string) => { const n = norm(v); if (n.length >= 2 && n.length <= 80 && !out.includes(n)) out.push(n); };
  for (const line of assistantText.split('\n')) {
    const m = /^\s*(?:\d{1,2}[.)]|[-•*–])\s+(.+)$/u.exec(line);
    if (m) add(m[1].split(/\s[—–-]\s|:\s/u)[0]);
  }
  for (const m of assistantText.matchAll(/«([^»\n]{2,80})»|"([^"\n]{2,80})"|“([^”\n]{2,80})”|\*\*([^*\n]{2,80})\*\*/gu)) add(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

/**
 * Spec 047 FR-001: the owner's reply picks one of the options the assistant just offered with a change — «Машина»,
 * «давай другий», «2», «хай буде Ракета». Short replies only; negation wins.
 */
export function picksOfferedOption(message: string, lastAssistant: string | null | undefined): boolean {
  const raw = unquoted(message).replace(/(^|\s)@[a-z][a-z0-9_]*/gi, ' ').trim();
  if (!raw || raw.length > MAX_PICK_CHARS || NEGATIVE_RE.test(raw) || !proposedChange(lastAssistant)) return false;
  const options = offeredOptions(lastAssistant);
  if (!options.length) return false;
  const t = norm(raw);
  const num = /^(?:(?:варіант|option|номер|#)\s*)?(\d{1,2})$/u.exec(t.replace(/^(?:давай|let's|go with|беру|обираю)\s+/u, ''));
  if (num) return Number(num[1]) >= 1 && Number(num[1]) <= options.length;
  for (const w of t.split(' ')) if (ORDINALS[w] && ORDINALS[w] <= options.length) return true;
  return options.some((o) => t.includes(o) || (t.length >= 3 && o.includes(t)));
}

/**
 * The owner's change intent for this turn (the gates of tools that write or start a paid run): the verbs or a requirement
 * in the message itself, a short "yes" to the previous assistant turn when that turn proposed a change, or a reply that
 * picks one of the options it offered (spec 047 FR-001).
 */
export function ownerChangeIntent(message: string, lastAssistant: string | null | undefined): boolean {
  if (hasAgentChangeIntent(message)) return true;
  return (isAffirmative(message) && proposedChange(lastAssistant)) || picksOfferedOption(message, lastAssistant);
}
