import { EM_DASH_CHARS_PER, emDashes } from './slop-lint';
import type { TextEdit } from '../critic/spec-edits';

/**
 * Spec 063 FR-004: the dash-to-comma/colon rule of `slop_em_dash` as a deterministic transform in code, not a model
 * edit (review 3, pp1732: the critic's edit for a dash also dropped «це»). The same count as the lint: one dash per
 * EM_DASH_CHARS_PER characters, at least one. Only the excess is converted, from the end of the post backwards, and a
 * dash that is grammar stays:
 *   • «X — це Y» (also «— є», «— то», «— ось»): the definition dash;
 *   • a dash at the start of a line (dialogue, a list item);
 *   • a dash between two numbers or before a quote / an uppercase letter (a range, a new sentence).
 * The rest becomes «, » (a parenthetical pair of dashes in one sentence: both commas) or «: » when what follows is a
 * short tail (≤ 3 words) closing the sentence («Є одна проблема — ціна» → «Є одна проблема: ціна»).
 * Each fix is an exact edit with enough context to occur once in the text (`applySpecEdits` needs exactly one match).
 */

const DASH = /(?<=\S) [—–] (?=\S)/gu;
const KEEP_AFTER = /^(?:це|є|то|ось)(?![\p{L}ʼ])/iu;
const SENTENCE_END = /[.!?…\n]/u;

interface Dash { at: number; len: number }

function dashesOf(text: string): Dash[] {
  const out: Dash[] = [];
  for (const m of text.matchAll(DASH)) {
    // The lint counts « – » only when spaced, and so does the pattern above; an en dash between digits is a range.
    out.push({ at: m.index!, len: m[0].length });
  }
  return out;
}

/** A dash that is part of the grammar and stays. */
function protectedDash(text: string, d: Dash): boolean {
  const after = text.slice(d.at + d.len);
  const before = text.slice(0, d.at);
  if (KEEP_AFTER.test(after)) return true;
  if (/(?:^|\n)\s*$/u.test(before)) return true;
  if (/\p{N}$/u.test(before) && /^\p{N}/u.test(after)) return true;
  return /^[«"„“\p{Lu}]/u.test(after);
}

/** The end of the sentence a dash is in (index of its terminator, or the end of the text). */
function sentenceEnd(text: string, from: number): number {
  const rest = text.slice(from);
  const m = SENTENCE_END.exec(rest);
  return m ? from + m.index : text.length;
}

function replacement(text: string, d: Dash, pairedClosing: Set<number>): string {
  if (pairedClosing.has(d.at)) return ', ';
  const end = sentenceEnd(text, d.at + d.len);
  const tail = text.slice(d.at + d.len, end).trim();
  const words = tail.split(/\s+/).filter(Boolean).length;
  return words <= 3 && !/\s[—–]\s/.test(tail) && !/[,;:]/.test(tail) ? ': ' : ', ';
}

const count = (s: string, sub: string) => {
  let n = 0;
  for (let i = s.indexOf(sub); i !== -1; i = s.indexOf(sub, i + sub.length)) n++;
  return n;
};

/** An edit around one dash with the context that makes it unique (word-snapped, up to 60 chars each side). */
function editAround(text: string, d: Dash, to: string): TextEdit | null {
  for (const radius of [14, 28, 44, 60]) {
    let a = Math.max(0, d.at - radius);
    let b = Math.min(text.length, d.at + d.len + radius);
    const lineStart = text.lastIndexOf('\n', d.at - 1) + 1;
    const lineEnd = text.indexOf('\n', d.at + d.len);
    a = Math.max(a, lineStart);
    b = Math.min(b, lineEnd < 0 ? text.length : lineEnd);
    if (a > lineStart) { const sp = text.indexOf(' ', a); if (sp >= 0 && sp < d.at) a = sp + 1; }
    if (b < (lineEnd < 0 ? text.length : lineEnd)) { const sp = text.lastIndexOf(' ', b); if (sp > d.at + d.len) b = sp; }
    const from = text.slice(a, b);
    if (count(text, from) === 1) return { from, to: `${text.slice(a, d.at)}${to}${text.slice(d.at + d.len, b)}` };
  }
  return null;
}

/** The exact edits that bring the dash count of a post down to what the lint allows (empty when it is within it). */
export function dashFixes(text: string): TextEdit[] {
  const total = emDashes(text);
  const allowed = Math.max(1, Math.floor(text.length / EM_DASH_CHARS_PER));
  let excess = total - allowed;
  if (excess <= 0) return [];
  const all = dashesOf(text);
  const free = all.filter((d) => !protectedDash(text, d));
  // A parenthetical pair «X — вставка — Y» in one sentence: both dashes become commas, together.
  const closing = new Set<number>();
  const pairs = new Map<number, Dash>();
  for (let i = 0; i < free.length - 1; i++) {
    const a = free[i];
    const b = free[i + 1];
    if (closing.has(a.at) || sentenceEnd(text, a.at + a.len) < b.at) continue;
    pairs.set(a.at, b);
    closing.add(b.at);
    i++;
  }
  const chosen: Dash[] = [];
  const seen = new Set<number>();
  for (const d of [...free].reverse()) {
    if (excess <= 0) break;
    if (seen.has(d.at)) continue;
    const mate = closing.has(d.at) ? free.find((x) => pairs.get(x.at)?.at === d.at) : pairs.get(d.at);
    const group = mate ? [d, mate] : [d];
    for (const g of group) { chosen.push(g); seen.add(g.at); }
    excess -= group.length;
  }
  // From the end backwards: an edit's context is read from the text as the earlier edits left it, so the edits apply in order.
  const out: TextEdit[] = [];
  let work = text;
  for (const d of chosen.sort((x, y) => y.at - x.at)) {
    const rep = replacement(text, d, closing);
    const e = editAround(work, d, rep);
    if (!e) continue;
    out.push(e);
    work = `${work.slice(0, d.at)}${rep}${work.slice(d.at + d.len)}`;
  }
  return out;
}
