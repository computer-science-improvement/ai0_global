import { unquoted } from '../agents/mentions';
import type { PendingAction } from '../agents/pending-actions';
import type { TurnActions } from './turn-record';

/**
 * Spec 047 FR-002: denials checked against the data. In review 1 @ai0 said nothing was applied while card a657a845 had been
 * applied, and @ai_global "corrected" @nova_dev and @loko_games as wrong names (both real). The claim guard (040 FR-014)
 * checked only positive claims. Every chat turn now gets the chat's cards with their statuses and the agent roster, and a
 * reply that denies what that data shows is re-prompted once, then marked.
 */
export interface ChatFacts {
  cards:   Array<Pick<PendingAction, 'id' | 'kind' | 'status' | 'summary'> & { createdAt?: Date }>;
  /** Agent handles of the network, without "@", lower-case. */
  handles: string[];
}

export const FACT_CARDS = 12;

const STATUS_UK: Record<string, string> = { pending: 'чекає Apply', applied: 'застосовано', discarded: 'відхилено', failed: 'не вдалося', expired: 'прострочено' };

/** The block the model reads each turn (the end of the system prompt). Null when there is nothing to state. */
export function factsBlock(f: ChatFacts): string | null {
  const cards = f.cards.slice(-FACT_CARDS);
  if (!cards.length && !f.handles.length) return null;
  const lines = ['## Факти цього чату (з бази на цей момент — вони важливіші за твою памʼять і за історію)'];
  if (cards.length) {
    lines.push('Картки чату (старші → новіші):');
    for (const c of cards) lines.push(`- ${c.id.slice(0, 8)} ${c.kind} — ${STATUS_UK[c.status] ?? c.status}${c.summary ? `: ${String(c.summary).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
  } else {
    lines.push('Карток у цьому чаті немає.');
  }
  if (f.handles.length) lines.push(`Агенти мережі (усі справжні): ${f.handles.map((h) => `@${h}`).join(', ')}.`);
  lines.push('Не заперечуй цього: не кажи «не застосовано», «немає такого агента» чи «я не викликав», якщо факти вище або твої інструменти цього ходу показують інше.');
  return lines.join('\n');
}

export type DenialKind = 'not_applied' | 'no_such_agent' | 'did_not_call';

/** `evidence` is for the model (Ukrainian), `note` for the owner (English UI text). */
export interface Denial { kind: DenialKind; sentence: string; evidence: string; note: string }

const NOT_APPLIED_RE = /(?<![\p{L}])(?:(?:нічого\s+)?не\s+(?:було\s+)?(?:застосован\p{L}*|застосува\p{L}*|записан\p{L}*|збережен\p{L}*)|нічого\s+не\s+змінилос\p{L}*|картк\p{L}*\s+(?:не\s+існує|немає|нема)|(?:nothing\s+(?:was\s+)?|not\s+(?:been\s+)?|wasn't\s+|was\s+not\s+|hasn't\s+been\s+)applied|no\s+such\s+card)(?![\p{L}])/iu;
const NO_AGENT_RE = /(?<![\p{L}])(?:немає\s+такого\s+агента|такого\s+агента\s+(?:@\S+\s+)?(?:немає|нема|не\s+існує)|агента?\s+@\S+\s+(?:немає|нема)|агента?\s+\S+\s+не\s+існує|не\s+існує\s+(?:такого\s+)?агента|неправильн\p{L}*\s+(?:назв\p{L}*|ім['ʼ]\p{L}*|хендл\p{L}*|handle)|помилк\p{L}*\s+в\s+(?:назві|імені|хендлі)|no\s+such\s+agent|(?:agent|handle)\s+\S+\s+does\s+not\s+exist|wrong\s+(?:name|handle))(?![\p{L}])/iu;
const DID_NOT_CALL_RE = /(?<![\p{L}])(?:я\s+не\s+(?:викликав|викликала|запускав|запускала|використовував|використовувала|створював|створювала|надсилав|надсилала)|не\s+викликав|i\s+(?:did\s+not|didn't|haven't)\s+(?:call|run|use|create|send))(?![\p{L}])/iu;
const HANDLE_RE = /@([a-z][a-z0-9_]{1,63})/gi;
const ID8_RE = /(?<![0-9a-f])([0-9a-f]{8})(?![0-9a-f])/gi;

/**
 * Sentences of the reply that deny what the data shows: a card «not applied» that is applied (the one it names, else the
 * chat's latest card), an agent «that does not exist» that is in the roster, a tool «I did not call» that this turn called.
 */
export function contradictedDenials(text: string, f: ChatFacts, turn: TurnActions): Denial[] {
  const out: Denial[] = [];
  const roster = new Set(f.handles.map((h) => h.toLowerCase()));
  const own = unquoted(text).replace(/«[^»]*»|"[^"\n]*"|“[^”]*”/g, ' ');
  for (const raw of own.split(/(?<=[.!?\n])\s+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (NOT_APPLIED_RE.test(sentence)) {
      const named = [...sentence.matchAll(ID8_RE)].map((m) => m[1].toLowerCase());
      const card = named.length
        ? f.cards.find((c) => named.includes(c.id.slice(0, 8).toLowerCase()))
        : f.cards.at(-1);
      if (card?.status === 'applied') {
        out.push({ kind: 'not_applied', sentence: sentence.slice(0, 200), evidence: `картка ${card.id.slice(0, 8)} (${card.kind}) — застосована`, note: `card ${card.id.slice(0, 8)} (${card.kind}) is applied` });
        continue;
      }
    }
    if (NO_AGENT_RE.test(sentence)) {
      const real = [...sentence.matchAll(HANDLE_RE)].map((m) => m[1].toLowerCase()).filter((h) => roster.has(h));
      if (real.length) {
        out.push({ kind: 'no_such_agent', sentence: sentence.slice(0, 200), evidence: `${real.map((h) => `@${h}`).join(', ')} — справжні агенти мережі`, note: `${real.map((h) => `@${h}`).join(', ')} ${real.length > 1 ? 'are real agents' : 'is a real agent'}` });
        continue;
      }
    }
    if (DID_NOT_CALL_RE.test(sentence)) {
      const lower = sentence.toLowerCase();
      const named = [...new Set(turn.tools)].filter((t) => lower.includes(t.toLowerCase()));
      const wrote = turn.cards.length + turn.rules.length + turn.drafts.length + turn.skills.length > 0;
      if (named.length || (wrote && !/[a-z]+_[a-z_]+/.test(lower))) {
        const tools = (named.length ? named : [...new Set(turn.tools)]).join(', ');
        out.push({ kind: 'did_not_call', sentence: sentence.slice(0, 200), evidence: `цей хід викликав: ${tools}`, note: `this turn called ${tools}` });
      }
    }
  }
  return out;
}

/**
 * A claim sentence that restates a fact of the chat — «картку a657a845 застосовано» names a card that is applied — is not
 * this turn's claim, so the 040 claim guard lets it through.
 */
export function restatesFact(sentence: string, f: ChatFacts | null): boolean {
  if (!f) return false;
  const named = [...sentence.matchAll(ID8_RE)].map((m) => m[1].toLowerCase());
  return named.some((id) => f.cards.some((c) => c.status === 'applied' && c.id.slice(0, 8).toLowerCase() === id));
}

/** The re-prompt after a denial the data contradicts. */
export function denialRePrompt(d: Denial[]): string {
  return [
    `Твоя відповідь заперечує те, що показують дані: «${d[0].sentence}» — а насправді ${d[0].evidence}.`,
    ...d.slice(1, 3).map((x) => `Також: «${x.sentence}» — ${x.evidence}.`),
    'Перевір факти чату (картки, агенти, свої інструменти цього ходу) і відповідай власнику заново, повністю і точно.',
  ].join(' ');
}

/** Appended when the corrected reply still denies what the data shows. */
export function denialNote(d: Denial[]): string {
  return `(Check: the data says otherwise — ${d.map((x) => x.note).join('; ')}.)`;
}
