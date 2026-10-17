import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { POST_FORMATS } from '../post/post-spec';
import { FormatPrefsSchema, ResourceProfileSchema, type FormatPrefField } from '../agents/resource-profile';
import { StyleSchema } from '../post/style/resource-style';
import { CadenceSchema } from '../network/series';
import { renderMetrics, type ChannelMetrics, type ObservedFormat } from './setup-metrics';
import { hasPostText, MIN_SPAN_DAYS, POST_TEXT_IN_PROMPT, type SetupPost } from './setup-posts.types';

/**
 * Spec 042 FR-003 / FR-004: the onboarder's one run. It reads the channel's last posts (full texts) and the metrics from
 * code, and answers with the terminal tool `submit_channel_setup`: six sections, each with evidence (post keys p1…pN).
 * Code checks what a schema cannot: every key is a real post, a rubric has ≥ 2 posts, shares add up, formats are ones the
 * channel publishes, voice quotes are copied from the posts. The checklist goes back to the model (spec 040 style).
 */

export const SETUP_SECTIONS = ['brief_profile', 'formatting', 'format_mix', 'series_pillars', 'schedule', 'examples_voice'] as const;
export type SetupSection = typeof SETUP_SECTIONS[number];

export const SUBMIT_SETUP_TOOL = 'submit_channel_setup';
export const VOICE_SKILL_NAME = 'channel-voice';

const PostKey = z.string().trim().regex(/^p\d{1,2}$/, 'ключ поста p1…p20');
const Evidence = z.object({
  post_ids: z.array(PostKey).max(20).default([]).describe('Пости, на яких тримається висновок (p1…)'),
  note:     z.string().trim().min(3).max(300).describe('Коротко: що саме в постах і цифрах це показує'),
});
const hour = z.number().int().min(0).max(23);

/** Format fields the analysis may propose (the rest — media, rich, caps, preferred_formats — stay the owner's or the agent's). */
export const SETUP_FORMAT_FIELDS = [
  'tone', 'length', 'emoji', 'hashtags', 'mentions', 'cta', 'links', 'line_breaks', 'signature', 'humor', 'slang', 'content_kind',
] as const satisfies readonly FormatPrefField[];

const ProposedFormat = FormatPrefsSchema.pick({
  tone: true, length: true, emoji: true, hashtags: true, mentions: true, cta: true, links: true, line_breaks: true, signature: true,
  humor: true, slang: true, content_kind: true,
}).partial();

const ProposedStyle = StyleSchema.pick({ address: true, hashtags: true, headline: true, names: true, audience: true, content_kind: true }).partial();

const ProposedCard = z.object({
  hashtags:     z.array(z.string().regex(/^[\p{L}\p{N}_]{1,50}$/u, 'без #, лише літери, цифри, _')).max(30).optional()
    .describe('Словник хештегів каналу (лише ті, що повторюються в постах)'),
  hashtag_min:  z.number().int().min(0).max(10).optional(),
  hashtag_max:  z.number().int().min(0).max(10).optional(),
  footer:       z.string().trim().max(300).nullable().optional().describe('Підпис / футер, лише якщо він повторюється в постах'),
  emoji_policy: z.enum(['none', 'sparse', 'free']).optional(),
  link_style:   z.enum(['inline', 'footer', 'button']).optional(),
}).strict();

export const SubmitSetupInput = z.object({
  summary: z.string().trim().min(20).max(800).describe('2–4 речення для власника: що це за канал і що змінить ця пропозиція'),
  brief_profile: z.object({
    profile:  ResourceProfileSchema.pick({ topic: true, audience: true, language: true, goals: true, tone: true, taboo: true, notes: true }),
    brief:    z.string().trim().min(200).max(4000).describe('Бриф для агента: що канал публікує, для кого і як — 5–10 речень'),
    evidence: Evidence,
  }),
  formatting: z.object({
    format_prefs: ProposedFormat.default({}),
    style:        ProposedStyle.optional(),
    card:         ProposedCard.default({}),
    evidence:     Evidence,
  }),
  format_mix: z.object({
    formats:  z.partialRecord(z.enum(POST_FORMATS), z.number().min(0.05).max(1)).describe('Ваги форматів 0.05–1 за фактичною часткою'),
    evidence: Evidence,
  }),
  series_pillars: z.object({
    series: z.array(z.object({
      name:     z.string().trim().min(3).max(80),
      cadence:  CadenceSchema,
      format:   z.enum(POST_FORMATS),
      brief:    z.string().trim().min(10).max(600),
      post_ids: z.array(PostKey).min(1).max(20).describe('Пости цієї рубрики (щонайменше 2)'),
    })).max(8).default([]),
    pillars:  z.array(z.object({ name: z.string().trim().min(2).max(80), share: z.number().min(1).max(100) })).min(3).max(5)
      .describe('3–5 тематичних стовпців, частки у відсотках, разом 100'),
    evidence: Evidence,
  }),
  schedule: z.object({
    posts_per_day_min: z.number().int().min(0).max(48),
    posts_per_day_max: z.number().int().min(1).max(48),
    quiet_start_hour:  hour,
    quiet_end_hour:    hour,
    best_hours:        z.array(hour).max(6).default([]),
    evidence:          Evidence,
    /** Spec 041 FR-008: set by code when the history spans under 7 days — posting rate and quiet hours stay as they are. */
    insufficient_span: z.boolean().optional(),
  }),
  examples_voice: z.object({
    example_ids: z.array(PostKey).min(3).max(5).describe('3–5 найкращих постів-зразків (ключі; текст код візьме з бази)'),
    voice: z.object({
      description: z.string().trim().min(10).max(300),
      rules:       z.array(z.string().trim().min(5).max(200)).min(5).max(8).describe('Правила «роби / не роби», як звучить канал'),
      quotes:      z.array(z.string().trim().min(5).max(200)).min(2).max(3).describe('Дослівні короткі цитати з постів'),
    }),
    evidence: Evidence,
  }),
});
export type SubmitSetupInput = z.infer<typeof SubmitSetupInput>;

/** Formats the card may weight, by what the posts show (`other` = a poll, a file or an album part). */
export function allowedFormats(mix: Partial<Record<ObservedFormat, number>>): Set<string> {
  const out = new Set<string>();
  if (mix.text) out.add('text');
  if (mix.photo) { out.add('photo'); out.add('album'); }
  if (mix.video) out.add('video');
  if (mix.other) { out.add('poll'); out.add('quiz'); out.add('album'); }
  if (!out.size) out.add('text');
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[«»"“”'’ʼ`]/g, '').replace(/\s+/g, ' ').trim();

export interface SetupCheckContext {
  posts:   SetupPost[];
  metrics: ChannelMetrics;
  /** Extra checks with the channel's context (the would-be playbook); Ukrainian lines. */
  extra?:  (input: SubmitSetupInput) => Promise<string[]> | string[];
}

/** Problems the model must fix, in Ukrainian (it reads them as a numbered checklist). */
export async function checkSetup(i: SubmitSetupInput, c: SetupCheckContext): Promise<string[]> {
  const keys = new Set(c.posts.map((p) => p.key));
  const errors: string[] = [];
  const unknown = (ids: string[], where: string) => {
    const bad = ids.filter((k) => !keys.has(k));
    if (bad.length) errors.push(`${where}: немає постів ${bad.join(', ')} (є ${c.posts[0]?.key}…${c.posts[c.posts.length - 1]?.key})`);
  };
  for (const s of ['brief_profile', 'formatting', 'format_mix', 'series_pillars', 'schedule', 'examples_voice'] as const) {
    unknown(i[s].evidence.post_ids, `${s}.evidence`);
  }
  i.series_pillars.series.forEach((s) => {
    unknown(s.post_ids, `рубрика «${s.name}»`);
    if (new Set(s.post_ids).size < 2) errors.push(`рубрика «${s.name}»: рубрика — це те, що повторюється; потрібні щонайменше 2 пости, зараз ${new Set(s.post_ids).size}`);
  });
  const sum = i.series_pillars.pillars.reduce((a, p) => a + p.share, 0);
  if (sum < 95 || sum > 105) errors.push(`pillars: частки мають давати 100 ± 5, зараз ${sum}`);

  const allowed = allowedFormats(c.metrics.formatMix);
  const mixBad = Object.keys(i.format_mix.formats).filter((f) => !allowed.has(f));
  if (mixBad.length) errors.push(`format_mix: формати ${mixBad.join(', ')} у постах не трапляються (можна: ${[...allowed].join(', ')})`);
  if (!Object.keys(i.format_mix.formats).length) errors.push('format_mix: потрібен хоча б один формат');
  const seriesBad = i.series_pillars.series.filter((s) => !(s.format in i.format_mix.formats)).map((s) => `«${s.name}» (${s.format})`);
  if (seriesBad.length) errors.push(`рубрики ${seriesBad.join(', ')}: формат має бути серед format_mix`);

  const sch = i.schedule;
  if (sch.posts_per_day_min > sch.posts_per_day_max) errors.push('schedule: posts_per_day_min > posts_per_day_max');
  const card = i.formatting.card;
  if (card.hashtag_min != null && card.hashtag_max != null && card.hashtag_min > card.hashtag_max) errors.push('formatting.card: hashtag_min > hashtag_max');

  const ex = i.examples_voice.example_ids;
  unknown(ex, 'examples_voice.example_ids');
  if (new Set(ex).size !== ex.length) errors.push('examples_voice.example_ids: пост повторюється');
  const texts = c.posts.map((p) => norm(p.text));
  i.examples_voice.voice.quotes.forEach((q, n) => {
    if (!texts.some((t) => t.includes(norm(q)))) errors.push(`examples_voice.voice.quotes[${n}]: «${q.slice(0, 60)}» — такого тексту в постах немає; копіюй дослівно`);
  });
  if (c.extra) errors.push(...(await c.extra(i)));
  return errors;
}

/** The terminal tool of the run; `check` adds the context checks (FR-003). */
export function buildSubmitSetupTool(c: SetupCheckContext): EditorTool {
  return defineTool({
    name: SUBMIT_SETUP_TOOL,
    description: [
      'Подати налаштування каналу з його постів: шість розділів, кожен з evidence (ключі постів p1… і коротке пояснення).',
      'Виклич один раз, коли все готово. Якщо код поверне помилки — виправ саме їх і виклич знову.',
    ].join(' '),
    kind: 'terminal', roles: ['onboarder'], input: SubmitSetupInput, placeholdersAbsent: true,
    execute: async (input) => {
      const errors = await checkSetup(input, c);
      if (errors.length) return { error: 'setup_invalid', details: errors.map((e, n) => `${n + 1}. ${e}`) };
      return { ok: true, setup: input };
    },
  });
}

export interface OnboarderPromptInput {
  channelKey: string;
  title:      string | null;
  about:      string | null;
  subscribers: number | null;
  posts:      SetupPost[];
  metrics:    ChannelMetrics;
  /** Format fields and series the owner locked: the proposal leaves them as they are. */
  lockedFormat: string[];
  lockedSeries: string[];
  current:    { brief: string | null; profile: string | null };
}

export function onboarderSystemPrompt(): string {
  return [
    'Ти — аналітик налаштування каналу. Ти читаєш останні пости каналу і цифри, які порахував код, і пропонуєш власнику налаштування агента, що вестиме канал далі в тому ж стилі.',
    'Правила:',
    '- Описуй канал таким, яким він є в постах. Не вигадуй: аудиторію, тон, табу й рубрики виводь із текстів і цифр; чого не видно — пиши обережно і познач у notes.',
    '- Кожен висновок підкріплюй evidence: ключі постів (p1 — найновіший) і коротке пояснення.',
    '- Рубрика — лише те, що повторюється щонайменше у 2 постах (однаковий початок, тег, формат, день). Немає повторів — порожній список рубрик.',
    '- Мова профілю — мова постів. Гумор (humor: light) — лише якщо в постах є жарти; сленг — лише якщо пости ним пишуть.',
    '- Ваги форматів — за фактичною часткою постів; формат, якого в постах немає, не пропонуй.',
    '- Розклад: кількість постів на день і тиха пора — з цифр; найкращі години — з годин з найкращими переглядами.',
    '- Цитати для голосу копіюй з постів дослівно (до 200 символів).',
    '- Поля й рубрики, які власник закріпив, не пропонуй — вони лишаються як є.',
    '- Не пропонуй режим, бюджет, моделі, джерела чи інструменти — це вирішує власник.',
    '- Агенти ніколи не видають себе за людей: у брифі й правилах голосу немає вказівок писати від імені людини.',
    `Відповідай лише викликом ${SUBMIT_SETUP_TOOL}.`,
  ].join('\n');
}

export function onboarderUserPrompt(i: OnboarderPromptInput): string {
  const posts = i.posts.map((p) => {
    const meta = [
      p.postedAt.toISOString().slice(0, 16).replace('T', ' '),
      p.hasMedia ? (p.mediaType ?? 'media') : 'text',
      p.views != null ? `${p.views} переглядів` : null,
      p.reactionsTotal != null ? `${p.reactionsTotal} реакцій` : null,
      p.forwards != null ? `${p.forwards} пересилань` : null,
    ].filter(Boolean).join(' · ');
    const text = p.text.length > POST_TEXT_IN_PROMPT ? `${p.text.slice(0, POST_TEXT_IN_PROMPT)}…` : p.text;
    return `### ${p.key} (${meta})\n${text || '(без тексту)'}`;
  });
  return [
    `Канал ${i.channelKey}${i.title ? ` — «${i.title}»` : ''}${i.subscribers != null ? `, ${i.subscribers} підписників` : ''}.`,
    i.about ? `Опис каналу: ${i.about}` : null,
    i.current.brief ? `Поточний бриф (заміниться, якщо власник прийме):\n${i.current.brief}` : 'Брифу ще немає.',
    i.current.profile ? `Поточний профіль:\n${i.current.profile}` : 'Профілю ще немає.',
    i.lockedFormat.length ? `Закріплені власником поля форматування (не пропонуй): ${i.lockedFormat.join(', ')}.` : null,
    i.lockedSeries.length ? `Закріплені власником рубрики (лишаються як є): ${i.lockedSeries.join(', ')}.` : null,
    `## Цифри з коду\n${renderMetrics(i.metrics)}`,
    // Spec 041 FR-008: what the history cannot tell.
    i.metrics.spanDays < MIN_SPAN_DAYS
      ? `Історія охоплює лише ${i.metrics.spanDays} дн. (менше ${MIN_SPAN_DAYS}): частоту постів і тиху пору код не застосує — у schedule лиши найкращі години, а в evidence напиши, що даних замало.`
      : null,
    noTextNote(i.posts),
    `## Останні пости (${i.posts.length}, від найновішого)\n${posts.join('\n\n')}`,
  ].filter(Boolean).join('\n\n');
}

/** Spec 041 FR-008: how many posts have no text — style conclusions never come from them. */
export function noTextNote(posts: ReadonlyArray<{ text: string }>): string | null {
  const none = posts.filter((p) => !hasPostText(p)).length;
  return none ? `${none} з ${posts.length} постів без тексту (медіа без підпису чи з коротким підписом): висновки про стиль, довжину, емодзі й звертання роби лише з постів із текстом.` : null;
}
