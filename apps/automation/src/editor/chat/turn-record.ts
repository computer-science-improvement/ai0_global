import type { EditorTool, ToolContext } from '../harness/tool';
import { channelOf, isToolError } from '../harness/tool';
import { parseArtifactRef, type ArtifactType } from '../artifacts/artifact.types';
import { unquoted } from '../agents/mentions';
import { CAPTURED_TOOLS, readsOf, type ChatReadCapture } from './chat-reads';

/**
 * Spec 040 FR-014: truthful chat history. On 10-16 an agent answered «Записав правило» with no tool call, and later
 * said a card «не існує» that had been applied at 10:21: the history it read had only the texts. Each assistant turn
 * now keeps what its tools did (stored on the message) and the history shows it with the card statuses as they are
 * now; a reply that claims an action no tool did is re-prompted once, then marked.
 */

/** What one chat turn's tools did (stored as `editor_chat_messages.actions`). */
export interface TurnActions {
  cards:  Array<{ id: string; kind: string }>;
  rules:  number[];
  drafts: string[];
  skills: string[];
  /** Successful tool calls, in order (reads included). */
  tools:  string[];
  /** Spec 062 FR-003: the run id of the first answer, when a guard replaced it with a corrected one. */
  retried_from?: string;
}

export const emptyTurn = (): TurnActions => ({ cards: [], rules: [], drafts: [], skills: [], tools: [] });

/** Records the successful results of a turn's tools (the loop runs the wrapped tools). */
export class TurnRecorder {
  readonly turn: TurnActions = emptyTurn();
  /** Spec 048 FR-005: the artifacts the turn's tools made or changed (stored as `editor_chat_messages.artifacts`). */
  readonly artifacts: Array<{ type: ArtifactType; id: string }> = [];

  /** Spec 062 FR-003: every call of the turn with a one-line result (errors too), for the guards' retry. Not stored. */
  readonly trace: Array<{ tool: string; result: string }> = [];

  /**
   * Spec 069 FR-007: `reads` + `chatId` keep the texts the read tools return (the chat's drafts are linted against them).
   * Spec 069 FR-006: a successful act / terminal call is remembered by its tool and input, so the claim guard's retry does
   * not run it again (`replay()`): the retry has the first run's calls only as text and a model may repeat them.
   */
  constructor(private readonly o: { reads?: Pick<ChatReadCapture, 'add'>; chatId?: string | null } = {}) {}

  private readonly done = new Map<string, unknown>();
  private replaying = false;

  /** From now on, an act / terminal call that already succeeded in this turn answers with its first result and runs nothing. */
  replay(): void { this.replaying = true; }

  wrap(tools: EditorTool[]): EditorTool[] {
    return tools.map((t) => ({
      ...t,
      execute: async (input: unknown, ctx: any) => {
        const key = t.kind === 'read' ? null : `${t.name}|${stableJson(input)}`;
        if (key && this.replaying && this.done.has(key)) {
          const first = this.done.get(key);
          return first && typeof first === 'object' && !Array.isArray(first) ? { ...first, already_done: ALREADY_DONE } : first;
        }
        const out = await t.execute(input, ctx);
        try { this.trace.push({ tool: t.name, result: traceResult(out) }); } catch { /* the trace is best effort */ }
        try { this.record(t.name, input, out, ctx); } catch { /* recording never fails a tool */ }
        try { this.capture(t.name, input, out); } catch { /* the read capture is best effort */ }
        if (key && !isToolError(out)) this.done.set(key, out);
        return out;
      },
    }));
  }

  private capture(tool: string, input: unknown, out: unknown): void {
    if (!this.o.reads || !this.o.chatId || !CAPTURED_TOOLS.has(tool) || isToolError(out)) return;
    for (const r of readsOf(tool, input, out)) this.o.reads.add(this.o.chatId, r);
  }

  private artifact(type: ArtifactType, id: unknown): void {
    if (typeof id !== 'string' || !id || this.artifacts.some((a) => a.type === type && a.id === id)) return;
    this.artifacts.push({ type, id });
  }

  record(tool: string, input: unknown, out: unknown, ctx?: ToolContext): void {
    if (isToolError(out)) return;
    const o = (out && typeof out === 'object' ? out : {}) as Record<string, any>;
    this.turn.tools.push(tool);
    if (tool === 'steer_channel') this.artifact('steering', o.set_id);
    if (tool === 'analyze_channel_history') this.artifact('setup', o.proposal_id);
    if (tool === 'launch_channel') this.artifact('launch', o.launch_id);
    if (tool === 'update_artifact' && typeof o.ref === 'string') { const r = parseArtifactRef(o.ref); if (r?.id) this.artifact(r.type, r.id); }
    if (tool === 'add_owner_rule' && o.stored !== false) this.artifact('rules', o.channel ?? (ctx ? channelOf(ctx) : null));
    if (typeof o.pending_action === 'string' && !this.turn.cards.some((c) => c.id === o.pending_action)) {
      this.turn.cards.push({ id: o.pending_action, kind: typeof o.kind === 'string' ? o.kind : tool });
    }
    if (tool === 'add_owner_rule' && typeof o.id === 'number' && o.stored !== false) this.turn.rules.push(o.id);
    if (tool === 'propose_skill_edit' && o.ok) this.turn.skills.push(`${o.skill ?? (input as any)?.skill ?? '?'} v${o.version ?? '?'}`);
    const draftId = o.draft?.id ?? (tool === 'save_draft' ? o.id : null);
    if (typeof draftId === 'string' && !this.turn.drafts.includes(draftId)) this.turn.drafts.push(draftId);
  }

  /** A draft the composer saved (onDraft). */
  draft(id: string): void {
    if (!this.turn.drafts.includes(id)) this.turn.drafts.push(id);
  }

  /** A card the UI was told about (onAction) carries its real kind. */
  card(id: string, kind: string): void {
    const c = this.turn.cards.find((x) => x.id === id);
    if (c) c.kind = kind; else this.turn.cards.push({ id, kind });
  }

  /** Two runs of one turn (the claim guard's re-prompt) are one record. */
  merge(other: TurnActions): void {
    for (const c of other.cards) if (!this.turn.cards.some((x) => x.id === c.id)) this.turn.cards.push(c);
    for (const r of other.rules) if (!this.turn.rules.includes(r)) this.turn.rules.push(r);
    for (const d of other.drafts) if (!this.turn.drafts.includes(d)) this.turn.drafts.push(d);
    this.turn.skills.push(...other.skills);
    this.turn.tools.push(...other.tools);
  }
}

/** What a repeated act call answers (Spec 069 FR-006). */
const ALREADY_DONE = 'цей виклик уже виконано в цьому ході з тими самими параметрами — нічого не повторено; його результат вище';

/** JSON with sorted keys: the same input in another key order is the same call. */
function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, sort(y)]))
      : x);
  try { return JSON.stringify(sort(v)) ?? ''; } catch { return ''; }
}

const TRACE_RESULT_CHARS = 140;
export const TRACE_CHARS = 1500;

/** One line about a tool result: the error code (+details) or the start of the JSON. */
function traceResult(out: unknown): string {
  const text = isToolError(out)
    ? `error: ${out.error}${out.details === undefined ? '' : ` ${typeof out.details === 'string' ? out.details : JSON.stringify(out.details)}`}`
    : typeof out === 'string' ? out : JSON.stringify(out) ?? '';
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > TRACE_RESULT_CHARS ? `${one.slice(0, TRACE_RESULT_CHARS - 1)}…` : one;
}

/** The tool trace of a run as the retry reads it: «- name: result» per call, at most `max` chars (older calls first dropped last). */
export function traceText(trace: ReadonlyArray<{ tool: string; result: string }>, max = TRACE_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of trace) {
    const line = `- ${t.tool}: ${t.result || 'ok'}`;
    if (used + line.length + 1 > max) { lines.push(`- … ще ${trace.length - lines.length} викликів`); break; }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

const STATUS_UK: Record<string, string> = { pending: 'чекає Apply', applied: 'застосовано', discarded: 'відхилено', failed: 'не вдалося', expired: 'прострочено' };

/** The most tool names one history line lists. */
const LINE_TOOLS = 10;

/**
 * The history line of a turn: «[дії: картка write_skill (застосовано); правило #12 записано; викликано: …]». Spec 062 FR-002:
 * a read-only turn says «змін немає; викликано: library_catalog, sql_readonly» (it used to say «немає — інструменти нічого не
 * змінили», which the model read as «I checked nothing»); «інструменти не викликались» only when none were called.
 */
export function actionLine(t: TurnActions | null | undefined, statusOf: (cardId: string) => string | undefined = () => undefined): string | null {
  if (!t) return null;
  const parts = [
    ...t.cards.map((c) => { const s = statusOf(c.id); return `картка ${c.kind} ${c.id.slice(0, 8)}${s ? ` (${STATUS_UK[s] ?? s})` : ''}`; }),
    ...t.rules.map((r) => `правило #${r} записано`),
    ...t.drafts.map((d) => `чернетка ${d.slice(0, 8)} збережена`),
    ...t.skills.map((s) => `скіл ${s} змінено`),
  ];
  const called = [...new Set(t.tools ?? [])];
  const shown = called.length > LINE_TOOLS ? `${called.slice(0, LINE_TOOLS).join(', ')} та ще ${called.length - LINE_TOOLS}` : called.join(', ');
  if (!parts.length) {
    if (!called.length) return `[дії: ${t.tools ? 'інструменти не викликались' : 'змін немає'}]`;
    return `[дії: змін немає; викликано: ${shown}]`;
  }
  return `[дії: ${parts.join('; ')}${called.length ? `; викликано: ${shown}` : ''}]`;
}

// ── system footers (spec 062 FR-001) ────────────────────────────────────────

/** A trailing «[дії: …]», «[чернетки: …]» or «[actions: …]» block. */
const FOOTER_RE = /\s*\[(?:дії|чернетки|actions)\s*:[^\]]*\]\s*$/iu;
/** A leading «@handle:» (the history shows the author that way). */
const HANDLE_PREFIX_RE = /^\s*@[a-z][a-z0-9_]{1,63}\s*:[ \t]*/i;

/**
 * The model's final text without what only the system writes: the trailing action/draft footers (one or more) and a
 * leading «@handle:». They are claims dressed as system facts (review 3: «[дії: немає — нічого не збережено]» after a turn
 * that ran three tools). The history adds the real ones.
 */
export function stripSystemFooters(text: string): string {
  let out = text;
  for (let k = 0; k < 8 && FOOTER_RE.test(out); k++) out = out.replace(FOOTER_RE, '');
  return out.replace(HANDLE_PREFIX_RE, '').trim();
}

/** The assistant turn as the history shows it: the author and the action line. */
export function historyTurn(content: string, author: string | null, line: string | null): string {
  return `${author ? `@${author}: ` : ''}${content}${line ? `\n\n${line}` : ''}`;
}

// ── claim guard ─────────────────────────────────────────────────────────────

export type ClaimKind = 'rule' | 'card' | 'write';

/** «Записав», «зберіг», «оновив», «надіслав картку», «застосовано» (and the English): what each claim needs as evidence. */
const CLAIMS: ReadonlyArray<[ClaimKind, RegExp]> = [
  ['card', /(?<![\p{L}])(?:надіслав|надіслала|створив|створила|запропонував|запропонувала|sent|created|proposed)\s+(?:\p{L}+\s+){0,2}?(?:картк\p{L}*|card)/iu],
  ['rule', /(?<![\p{L}])(?:записав|записала|запамʼятав|запам'ятав|запамʼятала|запам'ятала|додав\s+правило|додала\s+правило|recorded|saved\s+the\s+rule|added\s+the\s+rule)(?![\p{L}])/iu],
  ['write', /(?<![\p{L}])(?:зберіг|зберегла|оновив|оновила|змінив|змінила|застосовано|застосував|застосувала|saved|updated|applied)(?![\p{L}])/iu],
];
/** Spec 069 FR-006: «створив / created» says nothing alone; it is a write claim when it names a skill, a post or a draft. */
const CREATED_RE = /(?<![\p{L}])(?:створив|створила|created)(?![\p{L}])/iu;
/** What a write claim is about: a skill, a post, a draft. */
const WRITE_OBJECT_RE = /(?<![\p{L}])(?:скіл(?:и|а|у|ом|і|ів|ами|ах|е)?|skills?|пост(?:и|у|а|ом|і|ів|ами|ах|ові)?|posts?|чернетк\p{L}*|drafts?)(?![\p{L}])/iu;
/** …and the rule claim keeps its word: «записав правило про пости» is a rule claim. */
const RULE_WORD_RE = /(?<![\p{L}])(?:правил\p{L}*|rules?)(?![\p{L}])/iu;
/** A sentence about an earlier turn is not this turn's claim. */
const EARLIER_RE = /(?<![\p{L}])(?:раніше|вчора|минулого|позавчора|earlier|yesterday|previously|last\s+time)(?![\p{L}])/iu;
/** «не записав», «ще не зберіг», «буде застосовано», «didn't save»: the verb is negated or not yet done. */
const NEGATED_BEFORE = /(?:^|[^\p{L}])(?:не|ще\s+не|буде|будуть|можу|можемо|not|didn't|haven't|wasn't|nothing|will|will\s+be|can|could)\s+$/iu;
/** Quoted words («…», "…") are someone's text, not this reply's claim. */
const QUOTED_RE = /«[^»]*»|"[^"\n]*"|“[^”]*”/g;

export interface ClaimedAction {
  kind: ClaimKind;
  /** The claim sentence without its quoted words (what the guards read). */
  sentence: string;
  /** The same sentence with its «quoted» words kept: the skill handle may sit in quotes (spec 069 FR-006). */
  full: string;
}

/** Sentences of the reply that claim an action, by kind. */
export function claimedActions(text: string): ClaimedAction[] {
  const out: ClaimedAction[] = [];
  const quoted: string[] = [];
  // The quoted spans are masked while the text is cut into sentences, so a full stop inside a quote splits nothing.
  const masked = unquoted(text).replace(QUOTED_RE, (m) => { quoted.push(m); return `${quoted.length - 1}`; });
  for (const raw of masked.split(/(?<=[.!?\n])\s+/)) {
    const sentence = raw.replace(/\d+/g, '');
    if (EARLIER_RE.test(sentence)) continue;
    const full = raw.replace(/(\d+)/g, (_m, n: string) => quoted[Number(n)] ?? '');
    const found = kindOf(sentence);
    if (!found) continue;
    out.push({ kind: found, sentence: sentence.trim().slice(0, 200), full: full.trim().slice(0, 400) });
  }
  return out;
}

/** The claim kind of one sentence, or null. A rule verb on a skill / post / draft is a write claim, not a rule claim. */
function kindOf(sentence: string): ClaimKind | null {
  for (const [kind, re] of CLAIMS) {
    const m = re.exec(sentence);
    if (!m || NEGATED_BEFORE.test(sentence.slice(Math.max(0, m.index - 16), m.index))) continue;
    return kind === 'rule' && !RULE_WORD_RE.test(sentence) && WRITE_OBJECT_RE.test(sentence) ? 'write' : kind;
  }
  const created = CREATED_RE.exec(sentence);
  if (created && WRITE_OBJECT_RE.test(sentence) && !NEGATED_BEFORE.test(sentence.slice(Math.max(0, created.index - 16), created.index))) return 'write';
  return null;
}

/**
 * Spec 069 FR-006: what the chat did before this turn. `turns` is the stored `actions` of the earlier assistant messages,
 * `cards` the chat's cards with their status now (ChatFacts).
 */
export interface ChatPast {
  turns: ReadonlyArray<TurnActions>;
  cards: ReadonlyArray<{ id: string; kind: string; status: string; summary?: string | null }>;
}

const ID8_IN = /(?<![0-9a-f])([0-9a-f]{8})(?![0-9a-f])/gi;
const RULE_NO_IN = /(?:#|№|(?<![\p{L}])правил\p{L}*\s+)(\d{1,7})(?!\d)/giu;
/** «Skill "x" for @h», «Add skill "x"…»: the skill name of a card is the quoted word of its summary. */
const QUOTED_NAME_IN = /["“«]([^"”»\n]{3,48})["”»]/g;
const SKILL_CARD_KINDS = new Set(['write_skill', 'attach_skill', 'detach_skill']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `name` stands in the sentence as a whole token (letters, digits, `_` and `-` are inside a name). */
const namedIn = (full: string, name: string): boolean =>
  name.trim().length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(name.trim())}(?![\\p{L}\\p{N}_-])`, 'iu').test(full);

/**
 * A claim sentence that names what an earlier turn did: the skill handle (the version stripped), the rule number (#N), the
 * id of a draft or of a card (an earlier turn's card; a card in the chat facts must be applied unless the claim is only
 * about sending the card). Free-word overlap is not enough: «я записав скіл» that names nothing is not backed by the past.
 */
export function backedByPast(c: Pick<ClaimedAction, 'kind' | 'full'>, past: ChatPast): boolean {
  const ids = [...c.full.matchAll(ID8_IN)].map((m) => m[1].toLowerCase());
  const numbers = [...c.full.matchAll(RULE_NO_IN)].map((m) => Number(m[1]));
  const status = new Map(past.cards.map((x) => [x.id.slice(0, 8).toLowerCase(), x.status]));
  const live = (id: string, wantApplied: boolean): boolean => {
    const s = status.get(id);
    return s === undefined || s === 'applied' || (!wantApplied && s === 'pending');
  };
  const wantApplied = c.kind !== 'card';
  for (const t of past.turns) {
    if (t.rules?.some((r) => numbers.includes(r))) return true;
    if (t.cards?.some((x) => ids.includes(x.id.slice(0, 8).toLowerCase()) && live(x.id.slice(0, 8).toLowerCase(), wantApplied))) return true;
    if (t.drafts?.some((d) => ids.includes(d.slice(0, 8).toLowerCase()))) return true;
    if (t.skills?.some((s) => namedIn(c.full, s.replace(/\s+v\S+$/, '')))) return true;
  }
  for (const x of past.cards) {
    const id = x.id.slice(0, 8).toLowerCase();
    if (x.status === 'applied' || (!wantApplied && x.status === 'pending')) {
      if (ids.includes(id)) return true;
      if (SKILL_CARD_KINDS.has(x.kind)) {
        for (const m of String(x.summary ?? '').matchAll(QUOTED_NAME_IN)) if (namedIn(c.full, m[1])) return true;
      }
    }
  }
  return false;
}

/**
 * Claims no tool backs: a rule needs a stored rule (or its card), a card a card, a write any change of this turn; a claim
 * that names what an earlier turn of the chat did (`past`) is a restatement of that, not a new claim.
 */
export function unbackedClaims(text: string, t: TurnActions, past?: ChatPast | null): ClaimedAction[] {
  const wrote = t.cards.length + t.rules.length + t.drafts.length + t.skills.length > 0;
  return claimedActions(text).filter((c) =>
    (c.kind === 'rule' ? !(t.rules.length || t.cards.some((x) => x.kind === 'owner_rule'))
      : c.kind === 'card' ? !t.cards.length
        : !wrote) && !(past && backedByPast(c, past)));
}

/** Spec 069 FR-006 (A1): the system note of the claim retry. */
export const CLAIM_RETRY_NOTE = 'відповідай на останнє повідомлення власника ще раз; кажи лише те, що зробили інструменти; ніколи не згадуй перевірку чи виправлення.';

/**
 * The retry's user message after an unbacked claim: the owner's last message again, plus the note and the calls this turn
 * already made (a retry starts from the history without the first answer, so it would run them again).
 */
export function claimRetryUser(ownerText: string, trace: string): string {
  return `${ownerText}\n\n[Системна примітка: ${CLAIM_RETRY_NOTE}${trace ? ` Ці виклики вже виконано в цьому ході — не повторюй їх:\n${trace}` : ''}]`;
}

/** Appended when the corrected reply still claims an action no tool did. */
export const NOT_DONE_NOTE = '(Not done: no tool call recorded this action.)';
