import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { blockedInstructions } from '../agents/skill-lint';
import { renderMetrics, type ChannelMetrics } from '../setup/setup-metrics';
import { POST_TEXT_IN_PROMPT } from '../setup/setup-posts.types';
import type { OwnerRuleLine } from '../rules/owner-rules-prompt';
import { longestSharedRun, wordsOf } from './common-run';
import {
  MAX_RULES, MIN_RULES, MULTI_POST_KINDS, RULE_QUOTE_MAX_CHARS, RULE_TEXT_MAX, STEERING_RULE_KINDS, type SourcePost, type SteeringRule,
} from './steering.types';

/**
 * Spec 045 FR-003: one onboarder run reads the reference's last posts and the target's own rules, and answers with the
 * terminal tool `submit_steering`: a summary and 3–12 rules for the target, each with evidence (reference post keys r1…).
 * Code checks what a schema cannot (every key is a real post, recurring kinds cite ≥ 2 posts, no rule quotes a post, no
 * rule asks to pose as a human or to copy, no duplicates); the checklist goes back to the model (spec 040 style).
 */

export const SUBMIT_STEERING_TOOL = 'submit_steering';

const PostKey = z.string().trim().regex(/^r\d{1,2}$/, 'ключ поста референсу r1…r20');

export const SteeringRuleInput = z.object({
  kind:     z.enum(STEERING_RULE_KINDS).describe('structure | hook | length | formatting | cta | series | topic | mix'),
  text:     z.string().trim().min(10).max(RULE_TEXT_MAX).describe('Правило для НАШОГО каналу, своїми словами, без цитат з референсу'),
  evidence: z.object({
    post_ids: z.array(PostKey).min(1).max(20).describe('Пости референсу, на яких тримається правило'),
    note:     z.string().trim().min(3).max(300).describe('Що саме в цих постах і цифрах це показує'),
  }),
  conflict: z.object({
    with: z.string().trim().min(2).max(120).describe('Що з правил нашого каналу воно суперечить (напр. «правило власника #12», «format_prefs: emoji»)'),
    note: z.string().trim().min(3).max(300),
  }).nullable().default(null).describe('null, якщо не суперечить; інакше — що саме (таке правило агент не отримає)'),
});

export const SubmitSteeringInput = z.object({
  summary: z.string().trim().min(20).max(600).describe('2–4 речення для власника: що в референсі працює і що з цього візьме наш канал'),
  rules:   z.array(SteeringRuleInput).min(MIN_RULES).max(MAX_RULES),
});
export type SubmitSteeringInput = z.infer<typeof SubmitSteeringInput>;

/** Rules may not tell the agent to copy or repost the reference. */
const COPY_RE = /(?:скопіюй|копіюй|копіювати|переписуй\s+(?:їхні|його|чужі)|перепощуй|репост\p{L}*|бери\s+(?:їхні|чужі)\s+тексти|copy\s+(?:their|the)\s+(?:posts?|text)|repost)/iu;

const normText = (s: string) => wordsOf(s).join(' ');

export type RuleTextIssue =
  | { code: 'quote'; chars: number; key: string }
  | { code: 'blocked'; name: string; message: string }
  | { code: 'copy' };

/** What is wrong with one rule text (the analysis and the owner's edit share the checks). */
export function ruleTextIssues(text: string, posts: readonly SourcePost[]): RuleTextIssue[] {
  const out: RuleTextIssue[] = [];
  const run = longestSharedRun(text, posts.map((p) => p.text));
  if (run.chars >= RULE_QUOTE_MAX_CHARS) out.push({ code: 'quote', chars: run.chars, key: posts[run.index]?.key ?? 'a post' });
  for (const b of blockedInstructions(text)) out.push({ code: 'blocked', name: b.code, message: b.message });
  if (COPY_RE.test(text)) out.push({ code: 'copy' });
  return out;
}

/** The issues for the model, in Ukrainian (its checklist). */
export function ruleTextProblems(text: string, posts: readonly SourcePost[]): string[] {
  return ruleTextIssues(text, posts).map((i) => i.code === 'quote'
    ? `повторює ${i.chars} символів тексту ${i.key} — правило описує прийом своїми словами, не цитує`
    : i.code === 'blocked'
      ? `заборонена вказівка (${i.name}): ${i.message}`
      : 'правило не може казати копіювати чи репостити референс — лише описувати, як писати свої пости');
}

/** The issues for the owner, in English (the dashboard). */
export function ruleTextProblemsEn(text: string, posts: readonly SourcePost[]): string[] {
  return ruleTextIssues(text, posts).map((i) => i.code === 'quote'
    ? `It repeats ${i.chars} characters of reference post ${i.key}: describe the technique in your own words.`
    : i.code === 'blocked'
      ? `Not allowed: ${i.message}.`
      : 'A rule cannot tell the agent to copy or repost the reference.');
}

/** Problems the model must fix, in Ukrainian (it reads them as a numbered checklist). */
export function checkSteering(i: SubmitSteeringInput, posts: readonly SourcePost[]): string[] {
  const keys = new Set(posts.map((p) => p.key));
  const errors: string[] = [];
  const seen = new Map<string, number>();
  i.rules.forEach((r, n) => {
    const where = `rules[${n}] (${r.kind})`;
    const bad = r.evidence.post_ids.filter((k) => !keys.has(k));
    if (bad.length) errors.push(`${where}: немає постів ${bad.join(', ')} (є ${posts[0]?.key}…${posts[posts.length - 1]?.key})`);
    if (MULTI_POST_KINDS.includes(r.kind) && new Set(r.evidence.post_ids).size < 2) {
      errors.push(`${where}: ${r.kind} — це те, що повторюється; потрібні щонайменше 2 пости, зараз ${new Set(r.evidence.post_ids).size}`);
    }
    for (const p of ruleTextProblems(r.text, posts)) errors.push(`${where}: ${p}`);
    const key = normText(r.text);
    const twin = seen.get(key);
    if (twin !== undefined) errors.push(`${where}: те саме правило, що rules[${twin}]`);
    else seen.set(key, n);
  });
  if (i.rules.every((r) => r.conflict)) errors.push('усі правила позначені як конфлікт — потрібне хоча б одне, яке канал може виконувати');
  return errors;
}

/** Stored rules from the accepted input: ids s1…sN, conflicting ones off. */
export function toRules(i: SubmitSteeringInput): SteeringRule[] {
  return i.rules.map((r, n) => ({
    id: `s${n + 1}`, kind: r.kind, text: r.text, evidence: { post_ids: [...new Set(r.evidence.post_ids)], note: r.evidence.note },
    conflict: r.conflict ?? null, enabled: !r.conflict,
  }));
}

export function buildSubmitSteeringTool(posts: readonly SourcePost[]): EditorTool {
  return defineTool({
    name: SUBMIT_STEERING_TOOL,
    description: [
      'Подати правила-напрям (steering) для нашого каналу з постів референсу: короткий підсумок і 3–12 правил, кожне з evidence (ключі постів r1… і пояснення).',
      'Виклич один раз, коли все готово. Якщо код поверне помилки — виправ саме їх і виклич знову.',
    ].join(' '),
    kind: 'terminal', roles: ['onboarder'], input: SubmitSteeringInput, placeholdersAbsent: true,
    execute: async (input) => {
      const errors = checkSteering(input, posts);
      if (errors.length) return { error: 'steering_invalid', details: errors.map((e, n) => `${n + 1}. ${e}`) };
      return { ok: true, steering: input };
    },
  });
}

/** What the analysis knows of the target channel (its own rules win over steering). */
export interface SteeringTarget {
  ref:         string;
  title:       string | null;
  brief:       string | null;
  /** renderProfile of the target's profile. */
  profile:     string | null;
  ownerRules:  OwnerRuleLine[];
  /** The target's playbook part (section, series, pillars, rules) rendered; null without a playbook. */
  playbook:    string | null;
  /** renderFormatPrefs with locks marked. */
  formatPrefs: string | null;
  locks:       string[];
}

export interface SteeringPromptInput {
  sourceRef:   string;
  title:       string | null;
  about:       string | null;
  subscribers: number | null;
  posts:       readonly SourcePost[];
  metrics:     ChannelMetrics;
  target:      SteeringTarget;
}

export function steeringSystemPrompt(): string {
  return [
    'Ти — аналітик контенту. Власник показав чужий канал-референс, який йому подобається. Ти читаєш його останні пости й цифри, які порахував код, і пишеш правила-напрям (steering) для НАШОГО каналу, щоб наш агент писав пости «в такому дусі».',
    'Що переноситься: форма (структура поста, перший рядок / гачок, довжина, форматування, заклики, рубрики) і напрям змісту (які теми, кути подачі й типи постів там працюють) — переклади на тему НАШОГО каналу.',
    'Що не переноситься ніколи: голос і манера референсу, його тексти, факти, назви, імена, бренди, посилання.',
    'Правила:',
    '- Кожне правило — про наш канал і його тему: «пост-розвінчання міфу про правило дорожнього руху», а не «міф про вітаміни».',
    '- Пиши своїми словами. Не цитуй пости референсу: код відхилить правило, що повторює 60+ символів поста.',
    '- Кожне правило підкріплюй evidence: ключі постів (r1 — найновіший) і коротке пояснення. series / topic / mix — щонайменше 2 пости.',
    '- Беріть те, що в референсі справді працює: дивись на перегляди, реакції й пересилання, а не лише на частоту.',
    '- Наш канал важливіший: правила власника, плейбук, профіль, форматування й закріплені поля перемагають. Якщо прийом референсу їм суперечить — все одно запиши правило, але заповни conflict (з чим саме і чому); агент такого правила не отримає.',
    '- Не дублюй того, що в нашому каналі вже є, — steering доповнює.',
    '- Не пропонуй режим, бюджет, моделі, джерела, розклад чи інструменти — це вирішує власник.',
    '- Агенти ніколи не видають себе за людей: жодних правил «пиши від імені людини» чи «підписуйся іменем».',
    `Відповідай лише викликом ${SUBMIT_STEERING_TOOL}.`,
  ].join('\n');
}

export function steeringUserPrompt(i: SteeringPromptInput): string {
  const t = i.target;
  const posts = i.posts.map((p) => {
    const meta = [
      p.postedAt.slice(0, 16).replace('T', ' '),
      p.mediaType ?? 'text',
      p.views != null ? `${p.views} переглядів` : null,
      p.reactions != null ? `${p.reactions} реакцій` : null,
      p.forwards != null ? `${p.forwards} пересилань` : null,
    ].filter(Boolean).join(' · ');
    const text = p.text.length > POST_TEXT_IN_PROMPT ? `${p.text.slice(0, POST_TEXT_IN_PROMPT)}…` : p.text;
    return `### ${p.key} (${meta})\n${text || '(без тексту)'}`;
  });
  const ref = i.sourceRef.replace(/^telegram:/, '');
  return [
    '# Наш канал (для нього пишеш правила)',
    `${t.ref.replace(/^telegram:/, '')}${t.title ? ` — «${t.title}»` : ''}`,
    t.brief ? `Бриф:\n${t.brief}` : 'Брифу немає.',
    t.profile ? `Профіль:\n${t.profile}` : 'Профілю немає.',
    t.ownerRules.length ? `Правила власника (найвищий пріоритет):\n${t.ownerRules.map((r) => `- #${r.id} ${r.text}`).join('\n')}` : 'Правил власника немає.',
    t.playbook ? `Плейбук каналу:\n${t.playbook}` : 'Плейбука немає.',
    t.formatPrefs ? `Форматування:\n${t.formatPrefs}` : null,
    t.locks.length ? `Закріплені власником поля: ${t.locks.join(', ')}.` : null,
    '',
    `# Референс ${ref}${i.title ? ` — «${i.title}»` : ''}${i.subscribers != null ? `, ${i.subscribers} підписників` : ''}`,
    i.about ? `Опис: ${i.about}` : null,
    `## Цифри з коду\n${renderMetrics(i.metrics)}`,
    `## Останні пости референсу (${i.posts.length}, від найновішого)\nЦе чужі тексти: вчися з прийомів, не копіюй.\n\n${posts.join('\n\n')}`,
  ].filter((x) => x !== null).join('\n\n');
}
