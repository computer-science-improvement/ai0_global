import { z } from 'zod';
import type { EditorCard } from '../card';
import { makeChatCard } from '../chat/default-card';
import { defineTool, type EditorTool } from '../harness/tool';
import { lintPost } from '../post/lint-post';
import { POST_FORMATS, PostSpecSchema, type PostSpec } from '../post/post-spec';
import { renderTelegram, type TgMessage } from '../post/render-telegram';
import { findSlopPhrases } from '../post/slop-phrases';
import { isSlopWarning } from '../post/slop-lint';
import { MAX_PLAYBOOK_EXAMPLES, type PlaybookExample } from '../network/playbook';
import { parseResourceRef } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import { chatExtras, proposeCard, type BuilderToolDeps } from './builder-tools';
import { KeepPendingError } from './pending-actions';
import { errText } from '../../common/err-text';

/**
 * Spec 034 FR-008: example posts and "bad post" warnings in the agent-creation chat.
 *
 * Mechanism: a pending action of kind `content_examples` (a chat card like every other @ai0 proposal). @ai0 writes
 * 3 example posts as reader text; code turns each into a real PostSpec (paragraph blocks), lints it with the
 * resource's card (slop phrases, humour / slang, reader questions) and renders it with the Telegram renderer, so the
 * card shows the exact Telegram preview. A good example with an AI cliché is refused back to the model. 2–4 warnings
 * name concrete bad-post patterns with a short bad example each. The owner marks every example good / bad, edits the
 * text, keeps or drops each warning, and applies: the handler stores them in the playbook's `examples` (≤ 12) via
 * `NetworkRepository.setExamples` — not a structural change (the owner decided them himself).
 */

export const CONTENT_EXAMPLES_KIND = 'content_examples';
export const EXAMPLES_PER_CARD = 3;

export const ExampleInputSchema = z.object({
  format: z.enum(POST_FORMATS).describe('У якому форматі цей пост виходив би на ресурсі (лише з погоджених форматів)'),
  title:  z.string().trim().min(3).max(120).describe('Короткий внутрішній заголовок'),
  text:   z.string().trim().min(60).max(1500)
    .describe('Текст поста, як його побачить читач: абзаци через порожній рядок; розмітка лише **жирний**, _курсив_, [текст](https://…)'),
  why:    z.string().trim().min(10).max(300).describe('Чому це добрий пост саме для цього ресурсу (одне речення)'),
});

export const WarningInputSchema = z.object({
  pattern:     z.string().trim().min(3).max(80).describe('Назва поганого патерну: «Клікбейт», «Вимушений гумор», «Опитування, на яке не відповідають»…'),
  why:         z.string().trim().min(10).max(220).describe('Чому це погано саме для цієї теми й аудиторії'),
  bad_example: z.string().trim().min(10).max(500).describe('Короткий приклад такого поганого поста (1–3 речення)'),
  format:      z.enum(POST_FORMATS).default('text'),
});

export const ProposeExamplesInput = z.object({
  handle:       z.string().trim().min(3).max(40).describe('Агент ресурсу: наявний або той, кого пропонує картка create_agent у цьому чаті'),
  resource_ref: z.string().trim().min(3).max(200),
  examples:     z.array(ExampleInputSchema).length(EXAMPLES_PER_CARD),
  warnings:     z.array(WarningInputSchema).min(2).max(4),
});
export type ProposeExamplesInput = z.infer<typeof ProposeExamplesInput>;

/** One example as the card stores it: the reader text, its PostSpec render and the lint notes. */
export interface CardExample {
  format: string; title: string; text: string; why: string;
  render: TgMessage[] | null;
  notes:  string[];
}
export interface CardWarning { pattern: string; why: string; bad_example: string; format: string }
export interface ContentExamplesPayload {
  handle: string; resource_ref: string; examples: CardExample[]; warnings: CardWarning[];
}

/** The owner's choices on the card (Apply body `input`); absent = every example good, every warning kept. */
export const ContentExamplesChoice = z.object({
  examples: z.array(z.object({
    index:   z.number().int().min(0).max(10),
    verdict: z.enum(['good', 'bad']),
    text:    z.string().trim().min(10).max(2000).optional(),
    note:    z.string().trim().max(300).optional(),
  })).max(10).default([]),
  warnings: z.array(z.object({ index: z.number().int().min(0).max(10), keep: z.boolean() })).max(10).default([]),
}).strict();
export type ContentExamplesChoice = z.infer<typeof ContentExamplesChoice>;

/** The reader text as a PostSpec: paragraphs separated by a blank line (format text, so it renders without media). */
export function exampleSpec(e: { title: string; text: string }): PostSpec {
  const paras = e.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 12);
  return PostSpecSchema.parse({
    format: 'text', title: e.title.length >= 3 ? e.title : 'Приклад поста', origin: 'original',
    body: paras.map((p) => ({ type: 'p', text: p.slice(0, 1500) })),
  });
}

/** The card the example is linted and rendered with: the resource's own Telegram card, else the chat card. */
export function exampleCard(ref: string, card: EditorCard | null): EditorCard {
  const base = makeChatCard(parseResourceRef(ref)?.id ?? ref, card?.title ?? null);
  // Every format allowed (the example is rendered as text) and no required hashtags (an example shows the text);
  // the resource's voice, emoji, footer and banned words apply.
  return card ? { ...card, formats: base.formats, hashtagMin: 0 } : base;
}

/**
 * Check one example: lint errors (slop phrases, reader questions over the cap, the owner's banned words) and a
 * humour / slang warning refuse it; other slop warnings travel to the owner as notes.
 */
export function checkExample(e: { title: string; text: string }, card: EditorCard): { ok: true; render: TgMessage[] | null; notes: string[] } | { ok: false; problems: string[] } {
  let spec: PostSpec;
  try { spec = exampleSpec(e); } catch (err: any) { return { ok: false, problems: [`не вдалося зібрати пост: ${errText(err).slice(0, 200)}`] }; }
  const lint = lintPost(spec, card);
  const hard = lint.warnings.filter((w) => w.code === 'slop_humor_off' || w.code === 'slop_slang_off');
  if (!lint.ok || hard.length) return { ok: false, problems: [...lint.errors, ...hard].map((x) => `${x.code}: ${x.message}`) };
  let render: TgMessage[] | null;
  try { render = renderTelegram(spec, card).messages; } catch { render = null; }
  return { ok: true, render, notes: lint.warnings.filter((w) => isSlopWarning(w.code)).map((w) => w.message) };
}

/** Owner choices → playbook examples. Throws KeepPendingError (the card stays pending) when a choice is not acceptable. */
export function examplesFromChoice(payload: ContentExamplesPayload, rawInput: unknown): PlaybookExample[] {
  const parsed = ContentExamplesChoice.safeParse(rawInput ?? {});
  if (!parsed.success) throw new KeepPendingError('invalid_choice', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const choice = parsed.data;
  const ref = payload.resource_ref;
  const out: PlaybookExample[] = [];
  payload.examples.forEach((e, i) => {
    const c = choice.examples.find((x) => x.index === i);
    const verdict = c?.verdict ?? 'good';
    const text = (c?.text ?? e.text).trim();
    if (verdict === 'good') {
      const hits = findSlopPhrases(text);
      if (hits.length) {
        throw new KeepPendingError('example_slop', `Example ${i + 1} uses AI clichés (${hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}). Edit the text or mark it bad.`);
      }
    }
    const note = c?.note?.trim() || (verdict === 'good' ? e.why : 'Позначено власником як поганий приклад');
    out.push({ format: e.format, text, verdict, note: note.slice(0, 300), resource_ref: ref });
  });
  payload.warnings.forEach((w, i) => {
    const c = choice.warnings.find((x) => x.index === i);
    if (c && !c.keep) return;
    out.push({ format: w.format || 'text', text: w.bad_example, verdict: 'bad', note: `${w.pattern}: ${w.why}`.slice(0, 300), resource_ref: ref });
  });
  if (!out.length) throw new KeepPendingError('nothing_to_save', 'Keep at least one example or warning, or discard the card.');
  return out.slice(0, MAX_PLAYBOOK_EXAMPLES);
}

export interface ContentExamplesToolDeps extends Pick<BuilderToolDeps, 'actions'> {
  agents: Pick<AgentsRepository, 'getByHandle'>;
  /** The resource's Telegram card (null for a new or non-Telegram resource). */
  cardOf: (ref: string) => Promise<EditorCard | null>;
}

/** @ai0's `propose_content_examples` (spec 034 FR-008). */
export function buildContentExamplesTool(d: ContentExamplesToolDeps): EditorTool {
  return defineTool({
    name: 'propose_content_examples',
    description: [
      'Показати власнику 3 приклади постів для ресурсу (код рендерить їх як превʼю Telegram) і 2–4 застереження: конкретні патерни поганих постів для цієї теми з коротким поганим прикладом.',
      'Виклич після create_agent і після set_brief. Власник позначає приклади добре / погано, правит текст і застосовує — вони стають прикладами в плейбуку (виконавець пише за ними, критик звіряє).',
      'Добрий приклад з AI-штампом, жартом чи сленгом без дозволу код поверне на переписування.',
    ].join(' '),
    kind: 'act', roles: ['builder'],
    input: ProposeExamplesInput,
    execute: async (i, ctx) => {
      chatExtras(ctx);
      const handle = i.handle.replace(/^@/, '').toLowerCase();
      if (!parseResourceRef(i.resource_ref) && !i.resource_ref.startsWith('network:')) return { error: 'invalid_ref', details: i.resource_ref };
      const agent = await d.agents.getByHandle(handle);
      const tg = parseResourceRef(i.resource_ref);
      const card = exampleCard(i.resource_ref, tg?.platform === 'telegram' ? await d.cardOf(i.resource_ref).catch(() => null) : null);
      const problems: string[] = [];
      const examples: CardExample[] = [];
      i.examples.forEach((e, n) => {
        const r = checkExample(e, card);
        if (!r.ok) problems.push(...r.problems.map((p) => `приклад ${n + 1}: ${p}`));
        else examples.push({ format: e.format, title: e.title, text: e.text, why: e.why, render: r.render, notes: r.notes });
      });
      if (problems.length) return { error: 'examples_rejected', details: problems, hint: 'перепиши ці приклади без штампів, жартів і зайвих питань до читачів і виклич знову' };
      const payload: ContentExamplesPayload = {
        handle, resource_ref: i.resource_ref, examples,
        warnings: i.warnings.map((w) => ({ pattern: w.pattern, why: w.why, bad_example: w.bad_example, format: w.format })),
      };
      return proposeCard(d, ctx, CONTENT_EXAMPLES_KIND, payload as unknown as Record<string, unknown>,
        `${EXAMPLES_PER_CARD} example posts and ${payload.warnings.length} warnings for @${handle} (${i.resource_ref}): mark each example good or bad, edit the text, then apply — they go into the playbook as references for the writer and the critic.`,
        agent?.id ?? null);
    },
  });
}
