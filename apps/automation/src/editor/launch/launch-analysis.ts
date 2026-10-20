import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { POST_FORMATS } from '../post/post-spec';
import { ResourceProfileSchema } from '../agents/resource-profile';
import { CadenceSchema } from '../network/series';
import { implementedFormats } from '../platform/capabilities';
import { ASKS_FOR_POLLS } from '../agents/agent-creator';
import { ProposedCard, ProposedFormat, ProposedStyle } from '../setup/setup-analysis';
import { renderMetrics, type ChannelMetrics } from '../setup/setup-metrics';
import { longestSharedRun } from '../steering/common-run';
import { POST_COPY_MAX_CHARS, type SteeringRule } from '../steering/steering.types';

/**
 * Spec 052 FR-001: the launch analysis — one onboarder run for a channel with no history. It reads the owner's brief, the
 * reference channels (steering sets, 045: summary, rules, metrics) and the network's other channels, and answers with
 * the terminal tool `submit_channel_launch`: the 042 sections without post evidence, a voice and a first-week idea list.
 * Code checks what a schema cannot (shares, formats, the intro idea, no text copied from a reference) and returns the
 * checklist to the model.
 */

export const SUBMIT_LAUNCH_TOOL = 'submit_channel_launch';
/** A new channel starts with a modest rate (my call: the owner approves every post in the first weeks). */
export const LAUNCH_MAX_PER_DAY = 6;

const hour = z.number().int().min(0).max(23);

export const SubmitLaunchInput = z.object({
  summary: z.string().trim().min(20).max(800).describe('2–4 речення для власника: що це буде за канал і з чого він стартує'),
  brief_profile: z.object({
    profile: ResourceProfileSchema.pick({ topic: true, audience: true, language: true, goals: true, tone: true, taboo: true, notes: true }),
    brief:   z.string().trim().min(200).max(4000).describe('Бриф для агента: що канал публікує, для кого і як — 5–10 речень'),
  }),
  formatting: z.object({
    format_prefs: ProposedFormat.default({}),
    style:        ProposedStyle.optional(),
    card:         ProposedCard.default({}),
  }),
  format_mix: z.object({
    formats: z.partialRecord(z.enum(POST_FORMATS), z.number().min(0.05).max(1)).describe('Ваги форматів 0.05–1'),
  }),
  series_pillars: z.object({
    series: z.array(z.object({
      name:    z.string().trim().min(3).max(80),
      cadence: CadenceSchema,
      format:  z.enum(POST_FORMATS),
      brief:   z.string().trim().min(10).max(600),
    })).max(5).default([]).describe('0–5 рубрик, з якими канал стартує'),
    pillars: z.array(z.object({ name: z.string().trim().min(2).max(80), share: z.number().min(1).max(100) })).min(3).max(5)
      .describe('3–5 тематичних стовпців, частки у відсотках, разом 100'),
  }),
  schedule: z.object({
    posts_per_day_min: z.number().int().min(1).max(LAUNCH_MAX_PER_DAY),
    posts_per_day_max: z.number().int().min(1).max(LAUNCH_MAX_PER_DAY),
    quiet_start_hour:  hour,
    quiet_end_hour:    hour,
    best_hours:        z.array(hour).max(6).default([]),
  }),
  voice: z.object({
    description: z.string().trim().min(10).max(300),
    rules:       z.array(z.string().trim().min(5).max(200)).min(5).max(8).describe('Правила «роби / не роби», як звучить канал'),
  }),
  first_week: z.object({
    ideas: z.array(z.object({
      day:    z.number().int().min(1).max(7),
      title:  z.string().trim().min(5).max(120),
      angle:  z.string().trim().min(10).max(400),
      format: z.enum(POST_FORMATS),
      intro:  z.boolean().default(false).describe('true лише для поста-знайомства з каналом (день 1)'),
    })).min(5).max(10),
  }),
  references: z.array(z.object({
    ref:      z.string().trim().min(3).max(200),
    takeaway: z.string().trim().min(10).max(300).describe('Що канал бере з цього референсу (напрям, не текст)'),
  })).max(3).default([]),
});
export type SubmitLaunchInput = z.infer<typeof SubmitLaunchInput>;

/** A reference as the analysis sees it: the steering set's summary, rules, metrics and post texts (for the copy check). */
export interface LaunchReference {
  ref:     string;
  title:   string | null;
  summary: string | null;
  rules:   Pick<SteeringRule, 'kind' | 'text' | 'enabled'>[];
  metrics: ChannelMetrics | null;
  texts:   string[];
}

export interface LaunchCheckContext {
  brief:      string;
  references: LaunchReference[];
  /** Extra checks with the channel's context (the would-be playbook); Ukrainian lines. */
  extra?:     (input: SubmitLaunchInput) => Promise<string[]> | string[];
}

/** Problems the model must fix, in Ukrainian (it reads them as a numbered checklist). */
export async function checkLaunch(i: SubmitLaunchInput, c: LaunchCheckContext): Promise<string[]> {
  const errors: string[] = [];
  const sum = i.series_pillars.pillars.reduce((a, p) => a + p.share, 0);
  if (sum < 95 || sum > 105) errors.push(`pillars: частки мають давати 100 ± 5, зараз ${sum}`);

  const allowed = new Set(implementedFormats('telegram'));
  const mix = Object.keys(i.format_mix.formats);
  if (!mix.length) errors.push('format_mix: потрібен хоча б один формат');
  const bad = mix.filter((f) => !allowed.has(f));
  if (bad.length) errors.push(`format_mix: формати ${bad.join(', ')} у Telegram недоступні (можна: ${[...allowed].join(', ')})`);
  const kind = i.formatting.format_prefs.content_kind;
  const polls = mix.filter((f) => f === 'poll' || f === 'quiz');
  if (polls.length && kind !== 'quiz' && kind !== 'education' && !ASKS_FOR_POLLS.test(c.brief)) {
    errors.push(`format_mix: ${polls.join(', ')} — лише для каналу-вікторини чи освітнього (content_kind) або коли бриф власника просить опитування`);
  }
  const seriesBad = i.series_pillars.series.filter((s) => !(s.format in i.format_mix.formats)).map((s) => `«${s.name}» (${s.format})`);
  if (seriesBad.length) errors.push(`рубрики ${seriesBad.join(', ')}: формат має бути серед format_mix`);

  const sch = i.schedule;
  if (sch.posts_per_day_min > sch.posts_per_day_max) errors.push('schedule: posts_per_day_min > posts_per_day_max');
  const card = i.formatting.card;
  if (card.hashtag_min != null && card.hashtag_max != null && card.hashtag_min > card.hashtag_max) errors.push('formatting.card: hashtag_min > hashtag_max');

  const ideas = i.first_week.ideas;
  const intros = ideas.filter((x) => x.intro);
  if (intros.length !== 1) errors.push(`first_week: потрібна рівно одна ідея intro: true (пост-знайомство), зараз ${intros.length}`);
  else if (intros[0].day !== 1) errors.push('first_week: пост-знайомство (intro) — у день 1');
  const ideaBad = [...new Set(ideas.filter((x) => !(x.format in i.format_mix.formats)).map((x) => x.format))];
  if (ideaBad.length) errors.push(`first_week: формати ${ideaBad.join(', ')} мають бути серед format_mix`);
  const titles = ideas.map((x) => x.title.toLowerCase());
  if (new Set(titles).size !== titles.length) errors.push('first_week: ідеї повторюються');
  if (new Set(ideas.map((x) => x.day)).size < 4) errors.push('first_week: розклади ідеї щонайменше на 4 різні дні тижня');

  const known = new Set(c.references.map((r) => r.ref.toLowerCase()));
  const unknownRefs = i.references.filter((r) => !known.has(r.ref.toLowerCase())).map((r) => r.ref);
  if (unknownRefs.length) errors.push(`references: ${unknownRefs.join(', ')} — таких референсів немає (є: ${[...known].join(', ') || 'жодного'})`);

  // Spec 045 FR-006 at launch: nothing in the plan repeats a reference post's text.
  const refTexts = c.references.flatMap((r) => r.texts.filter((t) => t.trim()));
  if (refTexts.length) {
    const fields: Array<[string, string]> = [
      ['brief', i.brief_profile.brief], ['voice.description', i.voice.description],
      ...i.voice.rules.map((r, n) => [`voice.rules[${n}]`, r] as [string, string]),
      ...ideas.map((x, n) => [`first_week.ideas[${n}]`, `${x.title} ${x.angle}`] as [string, string]),
    ];
    for (const [where, text] of fields) {
      const run = longestSharedRun(text, refTexts);
      if (run.chars >= POST_COPY_MAX_CHARS) errors.push(`${where}: ${run.chars} символів поспіль повторюють пост референсу — референс задає напрям, не текст; скажи своїми словами`);
    }
  }
  if (c.extra) errors.push(...(await c.extra(i)));
  return errors;
}

/** The terminal tool of the run. */
export function buildSubmitLaunchTool(c: LaunchCheckContext): EditorTool {
  return defineTool({
    name: SUBMIT_LAUNCH_TOOL,
    description: [
      'Подати план запуску нового каналу: профіль і бриф, форматування, формати, рубрики й стовпці, розклад, голос, ідеї першого тижня і що взято з кожного референсу.',
      'Виклич один раз, коли все готово. Якщо код поверне помилки — виправ саме їх і виклич знову.',
    ].join(' '),
    kind: 'terminal', roles: ['onboarder'], input: SubmitLaunchInput, placeholdersAbsent: true,
    execute: async (input) => {
      const errors = await checkLaunch(input, c);
      if (errors.length) return { error: 'launch_invalid', details: errors.map((e, n) => `${n + 1}. ${e}`) };
      return { ok: true, launch: input };
    },
  });
}

export interface LaunchPromptInput {
  channelKey: string;
  title:      string | null;
  about:      string | null;
  brief:      string;
  references: LaunchReference[];
  /** References that could not be read, with the reason. */
  skipped:    Array<{ ref: string; reason: string }>;
  /** The network's other own channels: title and topic (the new one should not duplicate them). */
  network:    Array<{ key: string; title: string | null; topic: string | null }>;
}

export function launchSystemPrompt(): string {
  return [
    'Ти — аналітик запуску нового каналу. Канал ще порожній. Ти читаєш бриф власника, правила й цифри референсних каналів (чужих, на які власник хоче бути схожим) і пропонуєш налаштування агента, який вестиме канал з першого поста.',
    'Правила:',
    '- Головне — бриф власника. Референси задають напрям (форму, подачу, ритм), а не тему чи текст: не копіюй їхні формулювання, рубрики переназивай під свій канал.',
    '- Аудиторію, тон, табу й цілі виводь із брифу; чого бриф не каже — пиши обережно і познач у notes.',
    '- Рубрика — лише те, що каналу варто повторювати; на старті 0–3 рубрики достатньо.',
    `- Розклад для нового каналу помірний: ${LAUNCH_MAX_PER_DAY} постів на день — це максимум; найкращі години бери з цифр референсів, якщо вони є.`,
    '- Опитування й вікторини — лише якщо бриф про це просить або канал освітній чи вікторина.',
    '- Ідеї першого тижня: 5–10, на щонайменше 4 різні дні; перша — пост-знайомство (intro: true, день 1): що це за канал, для кого і що тут буде. Ідеї вічнозелені — без новин, які застаріють за тиждень.',
    '- Не дублюй теми інших каналів мережі — новий канал має своє місце.',
    '- Не пропонуй режим, бюджет, моделі, джерела чи інструменти — це вирішує власник.',
    '- Агенти ніколи не видають себе за людей: у брифі й правилах голосу немає вказівок писати від імені людини.',
    `Відповідай лише викликом ${SUBMIT_LAUNCH_TOOL}.`,
  ].join('\n');
}

export function launchUserPrompt(i: LaunchPromptInput): string {
  const refs = i.references.map((r) => [
    `### ${r.ref}${r.title ? ` — «${r.title}»` : ''}`,
    r.summary ? `Підсумок: ${r.summary}` : null,
    r.rules.filter((x) => x.enabled).length ? `Правила напряму:\n${r.rules.filter((x) => x.enabled).map((x) => `- [${x.kind}] ${x.text}`).join('\n')}` : null,
    r.metrics ? `Цифри:\n${renderMetrics(r.metrics)}` : null,
  ].filter(Boolean).join('\n'));
  return [
    `Новий канал ${i.channelKey}${i.title ? ` — «${i.title}»` : ''}.`,
    i.about ? `Опис каналу в Telegram: ${i.about}` : null,
    `## Бриф власника\n${i.brief}`,
    refs.length ? `## Референси\n${refs.join('\n\n')}` : 'Референсів немає — усе з брифу.',
    i.skipped.length ? `Не вдалося прочитати: ${i.skipped.map((s) => `${s.ref} (${s.reason})`).join('; ')}.` : null,
    i.network.length
      ? `## Інші канали мережі (не дублюй їх)\n${i.network.map((n) => `- ${n.key}${n.title ? ` «${n.title}»` : ''}${n.topic ? `: ${n.topic}` : ''}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n\n');
}
