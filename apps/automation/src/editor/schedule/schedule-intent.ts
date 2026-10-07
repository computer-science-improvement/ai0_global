import { hasAgentChangeIntent, unquoted } from '../agents/mentions';

/**
 * Did the owner ask, in THIS message, to change the schedule (BR-EDT-38 verb check, spec 023 FR-006)?
 * The agent-change verbs, plus schedule verbs (move, skip, cancel…), plus a time with a cadence word
 * ("рецепти о 20:30 по буднях"). A negated request is not a request. Deliberately broad: the card click is
 * the real confirmation; this only stops the model proposing on its own or from fetched text.
 */
const SCHEDULE_VERBS = [
  'перенеси', 'пересунь', 'посунь', 'зсунь', 'перемісти', 'пропусти', 'скасуй', 'відміни', 'постав', 'додай', 'прибери', 'закріпи',
  'заборони', 'не публікуй з', 'не пости з', 'перенести', 'пропустити', 'скасувати', 'отмени', 'пропусти',
  'move', 'shift', 'skip', 'cancel', 'reschedule', 'pin ', 'block ', 'blackout',
];
const TIME_RE = /(?:^|[^\d])([01]?\d|2[0-3])[:.][0-5]\d(?!\d)/;
const CADENCE_RE = /(щодня|щоранку|щовечора|щотижня|будн|вихідн|кожн|понеділ|вівтор|серед|четвер|пʼятниц|п'ятниц|субот|неділ|daily|weekday|weekend|every|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/iu;
const NEGATED_RE = /(?:^|[^\p{L}])(?:не|don't|do\s+not)\s+(?:треба\s+)?(?:перенос|пересув|посува|пропуск|скасов|відмін|чіпа|змін|move|skip|cancel|change|touch)/iu;

export function hasScheduleChangeIntent(message: string): boolean {
  const t = unquoted(message).toLowerCase();
  if (NEGATED_RE.test(t)) return false;
  if (hasAgentChangeIntent(message)) return true;
  if (SCHEDULE_VERBS.some((v) => t.includes(v))) return true;
  return TIME_RE.test(t) && CADENCE_RE.test(t);
}
