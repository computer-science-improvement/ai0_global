import type { EditorTool, ToolContext } from '../harness/tool';
import { channelOf, isToolError } from '../harness/tool';
import { parseArtifactRef, type ArtifactType } from '../artifacts/artifact.types';
import { unquoted } from '../agents/mentions';

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
}

export const emptyTurn = (): TurnActions => ({ cards: [], rules: [], drafts: [], skills: [], tools: [] });

/** Records the successful results of a turn's tools (the loop runs the wrapped tools). */
export class TurnRecorder {
  readonly turn: TurnActions = emptyTurn();
  /** Spec 048 FR-005: the artifacts the turn's tools made or changed (stored as `editor_chat_messages.artifacts`). */
  readonly artifacts: Array<{ type: ArtifactType; id: string }> = [];

  wrap(tools: EditorTool[]): EditorTool[] {
    return tools.map((t) => ({
      ...t,
      execute: async (input: unknown, ctx: any) => {
        const out = await t.execute(input, ctx);
        try { this.record(t.name, input, out, ctx); } catch { /* recording never fails a tool */ }
        return out;
      },
    }));
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

const STATUS_UK: Record<string, string> = { pending: 'чекає Apply', applied: 'застосовано', discarded: 'відхилено', failed: 'не вдалося', expired: 'прострочено' };

/** The history line of a turn: «[дії: картка write_skill (застосовано); правило #12 записано]», or «[дії: немає]». */
export function actionLine(t: TurnActions | null | undefined, statusOf: (cardId: string) => string | undefined = () => undefined): string | null {
  if (!t) return null;
  const parts = [
    ...t.cards.map((c) => { const s = statusOf(c.id); return `картка ${c.kind} ${c.id.slice(0, 8)}${s ? ` (${STATUS_UK[s] ?? s})` : ''}`; }),
    ...t.rules.map((r) => `правило #${r} записано`),
    ...t.drafts.map((d) => `чернетка ${d.slice(0, 8)} збережена`),
    ...t.skills.map((s) => `скіл ${s} змінено`),
  ];
  return `[дії: ${parts.length ? parts.join('; ') : 'немає — інструменти нічого не змінили'}]`;
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
/** A sentence about an earlier turn is not this turn's claim. */
const EARLIER_RE = /(?<![\p{L}])(?:раніше|вчора|минулого|позавчора|earlier|yesterday|previously|last\s+time)(?![\p{L}])/iu;
/** «не записав», «ще не зберіг», «буде застосовано», «didn't save»: the verb is negated or not yet done. */
const NEGATED_BEFORE = /(?:^|[^\p{L}])(?:не|ще\s+не|буде|будуть|можу|можемо|not|didn't|haven't|wasn't|nothing|will|will\s+be|can|could)\s+$/iu;

/** Sentences of the reply that claim an action, by kind. */
export function claimedActions(text: string): Array<{ kind: ClaimKind; sentence: string }> {
  const out: Array<{ kind: ClaimKind; sentence: string }> = [];
  // Quoted words («…», "…") are someone's text, not this reply's claim.
  const own = unquoted(text).replace(/«[^»]*»|"[^"\n]*"|“[^”]*”/g, '');
  for (const sentence of own.split(/(?<=[.!?\n])\s+/)) {
    if (EARLIER_RE.test(sentence)) continue;
    for (const [kind, re] of CLAIMS) {
      const m = re.exec(sentence);
      if (!m || NEGATED_BEFORE.test(sentence.slice(Math.max(0, m.index - 16), m.index))) continue;
      out.push({ kind, sentence: sentence.trim().slice(0, 200) });
      break;
    }
  }
  return out;
}

/** Claims no tool of this turn backs: a rule needs a stored rule (or its card), a card a card, a write any change. */
export function unbackedClaims(text: string, t: TurnActions): Array<{ kind: ClaimKind; sentence: string }> {
  const wrote = t.cards.length + t.rules.length + t.drafts.length + t.skills.length > 0;
  return claimedActions(text).filter((c) =>
    c.kind === 'rule' ? !(t.rules.length || t.cards.some((x) => x.kind === 'owner_rule'))
      : c.kind === 'card' ? !t.cards.length
        : !wrote);
}

/** The one re-prompt after an unbacked claim. */
export function claimRePrompt(claims: Array<{ sentence: string }>): string {
  return [
    `Ти написав, що виконав дію («${claims[0].sentence}»), але жоден інструмент у цьому ході цього не зробив.`,
    'Або зроби це зараз відповідним інструментом, або виправ відповідь: скажи прямо, що не зроблено і що потрібно від власника. Відповідай власнику заново, повністю.',
  ].join(' ');
}

/** Appended when the corrected reply still claims an action no tool did. */
export const NOT_DONE_NOTE = '(Not done: no tool call recorded this action.)';
