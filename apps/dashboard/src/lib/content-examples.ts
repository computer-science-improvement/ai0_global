// Spec 034 FR-008: the "Example posts" card @ai0 proposes in the agent-creation chat (pending action kind
// `content_examples`). The payload carries 3 example posts (reader text + its Telegram render) and 2–4 warnings
// about bad posts; the owner marks each example good / bad, edits the text and keeps or drops each warning.
// Apply sends those choices as `input`; the server refuses a "good" example with AI clichés (the card stays pending).

import type { TgMessage } from '../api/types';

export interface CardExample {
  format: string;
  title:  string;
  text:   string;
  why:    string;
  render: TgMessage[] | null;
  notes:  string[];
}
export interface CardWarning { pattern: string; why: string; bad_example: string; format: string }
export interface ContentExamplesPayload { handle: string; resource_ref: string; examples: CardExample[]; warnings: CardWarning[] }

export type Verdict = 'good' | 'bad';
/** The owner's choice for one example (text = the edited text, null = as written). */
export interface ExampleChoice { verdict: Verdict; text: string | null; note: string }
export interface ContentExamplesState { examples: ExampleChoice[]; keep: boolean[] }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A defensive read of the stored payload (an older or malformed card renders as empty lists, never crashes). */
export function parsePayload(raw: unknown): ContentExamplesPayload {
  const p = obj(raw);
  const examples = Array.isArray(p.examples) ? p.examples.map((x) => {
    const e = obj(x);
    return {
      format: str(e.format) || 'text', title: str(e.title), text: str(e.text), why: str(e.why),
      render: Array.isArray(e.render) ? e.render as TgMessage[] : null,
      notes: Array.isArray(e.notes) ? e.notes.filter((n): n is string => typeof n === 'string') : [],
    };
  }) : [];
  const warnings = Array.isArray(p.warnings) ? p.warnings.map((x) => {
    const w = obj(x);
    return { pattern: str(w.pattern), why: str(w.why), bad_example: str(w.bad_example), format: str(w.format) || 'text' };
  }) : [];
  return { handle: str(p.handle), resource_ref: str(p.resource_ref), examples, warnings };
}

export function initialState(p: ContentExamplesPayload): ContentExamplesState {
  return { examples: p.examples.map(() => ({ verdict: 'good', text: null, note: '' })), keep: p.warnings.map(() => true) };
}

/** The Apply body `input` (matches the server's ContentExamplesChoice). */
export function choiceInput(p: ContentExamplesPayload, s: ContentExamplesState) {
  return {
    examples: p.examples.map((e, index) => {
      const c = s.examples[index] ?? { verdict: 'good' as const, text: null, note: '' };
      const edited = c.text !== null && c.text.trim() && c.text.trim() !== e.text.trim() ? c.text.trim() : undefined;
      return { index, verdict: c.verdict, ...(edited ? { text: edited } : {}), ...(c.note.trim() ? { note: c.note.trim() } : {}) };
    }),
    warnings: p.warnings.map((_, index) => ({ index, keep: s.keep[index] ?? true })),
  };
}

/** How many items Apply stores (good + bad examples, kept warnings). */
export function savedCount(s: ContentExamplesState): { good: number; bad: number } {
  const good = s.examples.filter((e) => e.verdict === 'good').length;
  return { good, bad: s.examples.length - good + s.keep.filter(Boolean).length };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The backend's markdown-lite (**bold**, _italic_, [label](https://url)) → Telegram HTML, for the preview of an
 * edited example (the server renders the original; an edit is previewed here until it is applied).
 */
export function markdownLiteToTgHtml(src: string): string {
  const links: string[] = [];
  const withTokens = src.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(label)}</a>`);
    return `${links.length - 1}`;
  });
  const html = escapeHtml(withTokens)
    .replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(«"])_([^_\n]+?)_(?=$|[\s.,!?:;)»"])/g, '$1<i>$2</i>');
  return html
    .replace(/(\d+)/g, (_m, i) => links[Number(i)])
    .split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).join('\n\n');
}

/** The messages to preview: the server's render, or a text bubble of the edited text. */
export function previewMessages(e: CardExample, edited: string | null): TgMessage[] {
  if (edited === null || edited.trim() === e.text.trim()) {
    if (e.render?.length) return e.render;
    return [{ method: 'sendMessage', text: markdownLiteToTgHtml(e.text), preview: null, buttons: [] }];
  }
  return [{ method: 'sendMessage', text: markdownLiteToTgHtml(edited), preview: null, buttons: [] }];
}
