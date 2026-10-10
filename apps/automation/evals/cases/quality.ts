import type { Pool } from 'pg';
import type { CaseCtx, EvalCase } from '../lib/case';
import { runExecutor } from '../lib/case';
import { FakeWeb, article, rss } from '../lib/fake-web';
import { bannedHits, check, isUkrainian, specText, stepsOf, toolErrors, ungroundedNumbers } from '../lib/graders';
import { createCard, PostSeed, seedPosts } from '../lib/seed';
import { ownChannel, resetAgents, trace } from './agents';
import { localDate, zonedToUtc } from '../../src/editor/roles/time';
import { htmlToPlain } from '../../src/editor/post/inline-markup';
import { lintPost } from '../../src/editor/post/lint-post';
import { humorHits, isSlopWarning, slangHits } from '../../src/editor/post/slop-lint';
import { readerQuestions } from '../../src/editor/post/audience-asks';
import { similarity } from '../../src/editor/post/similarity';
import type { PostSpec } from '../../src/editor/post/post-spec';
import { checkExample, exampleCard, exampleSpec, type CardExample, type CardWarning } from '../../src/editor/agents/content-examples';
import type { CriticRequest } from '../../src/editor/critic/critic.service';
import type { CriticScoreKey, StoredCritic } from '../../src/editor/critic/critic';
import { PlaybookSchema } from '../../src/editor/network/playbook';
import type { EditorCard } from '../../src/editor/card';
import type { Agent } from '../../src/editor/agents/agent.types';

// Spec 034 FR-015 (T9): content-quality evals — the writer's voice, the pre-publish critic, the poll cap, fitting
// formats and examples in the creation chat, MANAGER's quality audit and live news slots. Real LLM, scratch DB,
// fixture web only, nothing sent anywhere. Written, not run: see evals/README.md for the command and the cost.

const KYIV = 'Europe/Kyiv';
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Every channel key this file uses (the runner resets editor rows by key; agent / profile rows are reset here). */
const VOICE = '@eval_voice';
const CRITIC = '@eval_critic';
const POLLCAP = '@eval_pollcap';
const BUILD_FMT = '@eval_itnews';
const BUILD_EX = '@eval_itnews_ex';
const MQ = '@eval_mq';
const LIVE = '@eval_live';
const KEYS = [VOICE, CRITIC, POLLCAP, BUILD_FMT, BUILD_EX, MQ, LIVE];

/** Profiles (format_prefs, caps) and their versions of the eval resources; agent rows go through resetAgents. */
async function resetProfiles(pool: Pool, keys: string[]): Promise<void> {
  const refs = keys.map((k) => `telegram:${k}`);
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = ANY($1::text[])`, [refs]).catch(() => {});
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs]);
}

async function resetQuality(pool: Pool, keys: string[]): Promise<void> {
  await resetAgents(pool, keys);
  await resetProfiles(pool, keys);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = ANY($1::text[])`, [keys]);
}

/** Leave the scratch DB as found (called once by the runner after all cases). */
export async function cleanupQualityEvals(pool: Pool): Promise<void> {
  await resetQuality(pool, KEYS);
}

/** The reader text of a written slot (preview → plain text, else the spec's text). */
function readerText(after: { renderedPreview?: string | null; postSpec?: unknown }): string {
  if (after.renderedPreview) return htmlToPlain(after.renderedPreview);
  const spec = after.postSpec as PostSpec | null | undefined;
  return spec?.body ? specText(spec) : '';
}

const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * HOUR);

// ── 1. executor-voice-plain ────────────────────────────────────────────────

/** A story that invites jokes; the resource is news with humour off, so the post must stay plain. */
export const ROBOT = {
  link: 'https://city-tech.example/news/delivery-robot-snow',
  image: 'https://city-tech.example/img/robot-snow.jpg',
  title: 'Kharkiv delivery robot gets stuck in snow, passers-by push it out',
  text: [
    'A delivery robot operated by the Kharkiv startup Kolo got stuck in a snowdrift on Sumska Street on Tuesday morning and was pushed out by two passers-by.',
    'The company says its 40 robots completed 12,000 deliveries in November, and about 3 percent of winter trips needed help from a person.',
    'Kolo plans to fit the robots with heated wheels and a new traction mode before next winter; the upgrade will cost about 2,500 euros per robot.',
    'The robots carry up to 20 kilograms and travel at 6 km/h on pavements.',
  ],
};
export const ROBOT_SOURCE = ROBOT.text.join('\n');

export const executorVoicePlain: EvalCase = {
  id: 'executor-voice-plain', role: 'executor', channel: VOICE,
  title: 'Новинний ресурс, humor: none: пост без жартів і сленгу, без штампів, без питань до читачів понад ліміт (0 для новин), lint ok (spec 034 FR-001–003, FR-005)',
  web: () => new FakeWeb({
    'https://city-tech.example/rss': rss('City Tech', [{ title: ROBOT.title, link: ROBOT.link, description: ROBOT.text[0], image: ROBOT.image }]),
    [ROBOT.link]: article({ title: ROBOT.title, image: ROBOT.image, paragraphs: ROBOT.text }),
  }),
  async execute(ctx) {
    await resetQuality(ctx.pool, [VOICE]);
    await createCard(ctx.pool, {
      channelKey: VOICE, title: 'Техно Харків', brief: 'Новини технологій і стартапів Харкова: коротко, точно, з посиланням на джерело.',
      formats: { text: 1, photo: 0.8 }, hashtags: ['харків', 'технології', 'стартапи'], hashtagMin: 0, hashtagMax: 2,
      sources: [{ id: 'city_rss', kind: 'rss', ref: 'https://city-tech.example/rss' }],
    });
    // The owner's voice settings: news (reader questions cap 0), no humour, no slang.
    await ctx.stack.profiles.patchFormat(`telegram:${VOICE}`, { humor: 'none', slang: false, content_kind: 'news' }, { by: 'owner' });
    const r = await runExecutor(ctx, VOICE, { format: 'photo', topic: 'Новина про харківського робота-курʼєра, який застряг у снігу', hints: ['city_rss'] });
    const card = (await ctx.stack.channels.get(VOICE))!;
    const spec = r.spec;
    const text = spec ? specText(spec) : '';
    const lint = spec ? lintPost(spec, card) : null;
    const slop = lint ? lint.warnings.filter((w) => isSlopWarning(w.code)) : [];
    const questions = readerQuestions(r.post || text);
    const critic = r.after.critic ?? null;
    return {
      runId: r.res.runId, extraRunIds: critic?.run_id ? [critic.run_id] : [], status: r.res.status, terminalTool: r.res.terminalTool, post: r.post,
      toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('wrote the post (shadowed)', r.after.status === 'shadowed' && !!spec, `slot=${r.after.status} ${r.after.error ?? ''}`),
        check('card has humour off and the news cap', card.humor !== 'light' && card.slang !== true && card.readerQuestionsMax === 0, `humor=${card.humor} slang=${card.slang} q=${card.readerQuestionsMax}`),
        check('no banned slop phrases', bannedHits(text).length === 0, bannedHits(text).join(', ')),
        check('no jokes / meme markers', humorHits(r.post || text).length === 0, humorHits(r.post || text).join(', ')),
        check('no slang', slangHits(r.post || text).length === 0, slangHits(r.post || text).join(', ')),
        check('reader questions ≤ cap (0 on news)', questions.length <= (card.readerQuestionsMax ?? 0), questions.join(' | ')),
        check('passes the lint (no errors)', !!lint?.ok, lint?.errors.map((e) => e.code).join(', ')),
        check('Ukrainian', isUkrainian(text)),
        check('numbers grounded in source', ungroundedNumbers(text, ROBOT_SOURCE).length === 0, ungroundedNumbers(text, ROBOT_SOURCE).join(', ')),
        check('no slop warnings (em dash, «!», rhetorical Q&A, moral closer, triples)', slop.length === 0, slop.map((w) => w.code).join(', '), true),
        check('critic passed it', critic?.verdict === 'pass', critic ? `${critic.verdict} ${critic.reason}: ${critic.notes}` : 'no verdict', true),
        check('no critic rewrite needed', !r.toolErrors.some((e) => e.includes('critic_revise')), r.toolErrors.join(', '), true),
      ],
      judge: spec ? { channelBrief: 'Новини технологій Харкова, нейтральний тон, без гумору', slotTopic: 'Робот-курʼєр застряг у снігу', sourceText: ROBOT_SOURCE, post: r.post } : undefined,
    };
  },
};

// ── 2–3. the critic on fixed posts ─────────────────────────────────────────

export const STORAGE = {
  url: 'https://energy-news.example/kyiv-region-battery-storage',
  title: 'Svitlo-Skhid switches on a 200 MW battery storage plant in Kyiv region',
  text: [
    'Energy company Svitlo-Skhid has connected a 200 MW / 400 MWh battery energy storage system to the grid near Bila Tserkva in Kyiv region.',
    'The plant can deliver its full power for two hours, enough to cover the evening peak demand of about 150,000 households.',
    'It consists of 96 containers with lithium iron phosphate cells and cost 110 million euros, partly financed by a loan from a European development bank.',
    'The grid operator says storage plants help balance the grid in the evening when solar output drops, but they do not replace generation lost to attacks.',
  ],
};
export const STORAGE_SOURCE = STORAGE.text.join('\n');

/** A clean, human news post grounded in STORAGE (no slop phrase, no slop warning). */
export const CLEAN_POST = {
  title: 'Під Білою Церквою запрацював накопичувач на 200 МВт',
  text: [
    'Під Білою Церквою запрацював накопичувач енергії на 200 МВт',
    'Компанія «Світло-Схід» підключила до мережі батарейну систему на 200 МВт і 400 МВт·год. Повну потужність вона видає дві години, цього вистачає на вечірній пік приблизно 150 000 домівок.',
    'Система складається з 96 контейнерів із літій-залізо-фосфатними батареями. Вона коштувала 110 млн євро, частину грошей позичив європейський банк розвитку.',
    'Оператор мережі пояснює, що такі накопичувачі вирівнюють навантаження ввечері, коли сонячні станції перестають працювати. Генерацію, втрачену через атаки, вони не замінюють.',
  ].join('\n\n'),
};

/**
 * The same news, deliberately AI-sounding: a pathos opener, a rhetorical question answered at once, an adjective
 * triple, dashes, exclamations and a moralising closer. No phrase from the lint's list, so only the critic (and the
 * lint's warnings) can stop it — as in production, where a listed phrase is a lint error before the critic runs.
 */
export const SLOP_POST = {
  title: 'Енергетика майбутнього вже тут',
  text: [
    'Енергетика майбутнього вже тут!',
    'Друзі, що відбувається з українською енергетикою? Вона змінюється просто на наших очах. Під Білою Церквою запрацював потужний, сучасний і надійний накопичувач енергії — справжній символ нової епохи.',
    'Чому це так важливо? Тому що кожен мегават — це світло у ваших оселях, тепло у ваших серцях і впевненість у завтрашньому дні. 96 контейнерів — це не просто батареї, це символ нашої сили.',
    'Тож бережімо енергію і віримо в краще, адже разом ми здатні на неможливе!',
  ].join('\n\n'),
};

/** Coherent and plainly written, but wrong against STORAGE: place, power, "generates", "the whole country", "this week". */
export const NONSENSE_POST = {
  title: 'Під Львовом запрацював накопичувач на 2000 МВт',
  text: [
    'Під Львовом запрацював накопичувач на 2000 МВт',
    'Компанія «Світло-Схід» запустила батарейну станцію, яка сама виробляє електрику цілодобово і без палива. Її потужності вистачить, щоб живити всю Україну навіть уночі.',
    'Станція складається з 96 контейнерів. Завдяки їй відключення світла в країні припиняться вже цього тижня, а сонячні електростанції стануть непотрібні.',
    'Оператор мережі вважає, що накопичувачі повністю замінюють генерацію, втрачену через атаки.',
  ].join('\n\n'),
};

const CRITIC_BRIEF = 'Енергетика України: новини мереж, генерації й накопичувачів — точно, нейтрально, з джерелом.';

/** The critic's card: news, humour and slang off, no required hashtags (the fixed posts have none). */
async function criticCard(ctx: CaseCtx): Promise<EditorCard> {
  await resetQuality(ctx.pool, [CRITIC]);
  await createCard(ctx.pool, {
    channelKey: CRITIC, title: 'Енергетика UA', brief: CRITIC_BRIEF,
    formats: { text: 1, photo: 0.6 }, hashtags: ['енергетика'], hashtagMin: 0, hashtagMax: 2,
  });
  await ctx.stack.profiles.patchFormat(`telegram:${CRITIC}`, { humor: 'none', slang: false, content_kind: 'news' }, { by: 'owner' });
  return (await ctx.stack.channels.get(CRITIC))!;
}

/** The PostSpec of a fixed post, with the source attached (what the executor would have written). */
export function fixedSpec(p: { title: string; text: string }): PostSpec {
  return { ...exampleSpec(p), source: { url: STORAGE.url, label: 'energy-news.example' } } as PostSpec;
}

/** The critic request the gate would build for a Telegram text post (slop warnings from the same lint). */
export function criticRequest(card: EditorCard, p: { title: string; text: string }): CriticRequest {
  const spec = fixedSpec(p);
  const lint = lintPost(spec, card);
  return {
    channelKey: card.channelKey, slotId: null, mode: 'shadow',
    card: { models: card.models, dailyBudgetUsd: card.dailyBudgetUsd, mode: card.mode },
    resourceRef: `telegram:${card.channelKey}`, platform: 'telegram', format: 'text',
    topic: 'Новий накопичувач енергії під Білою Церквою', angle: null,
    text: p.text, spec, voice: { humor: card.humor, slang: card.slang, emoji: card.emojiPref, readerQuestionsMax: card.readerQuestionsMax },
    brief: card.brief, source: { url: STORAGE.url, excerpt: STORAGE_SOURCE },
    slopWarnings: lint.warnings.filter((w) => isSlopWarning(w.code)).map((w) => ({ code: w.code, message: w.message })),
  };
}

const scoresOf = (c: StoredCritic | null) => (c?.scores ? Object.entries(c.scores).map(([k, v]) => `${k} ${v}`).join(', ') : '-');
/** One score of a verdict; NaN when the critic gave none (an `error` verdict), so every comparison is false. */
const sc = (c: StoredCritic | null, k: CriticScoreKey): number => c?.scores?.[k] ?? Number.NaN;

export const criticRejectsSlop: EvalCase = {
  id: 'critic-rejects-slop', role: 'checker', channel: CRITIC,
  title: 'Критик: AI-текст (пафос, риторичне питання з відповіддю, моралізаторський фінал) → revise/reject; чистий людський пост про ту саму новину → pass (spec 034 FR-004)',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const card = await criticCard(ctx);
    if (!ctx.stack.critic) return { runId: null, status: 'disabled', checks: [check('critic enabled (EDITOR_CRITIC is not off)', false)] };
    const slop = await ctx.stack.critic.review(criticRequest(card, SLOP_POST));
    const clean = await ctx.stack.critic.review(criticRequest(card, CLEAN_POST));
    const s = slop.ok ? slop.critic : null;
    const c = clean.ok ? clean.critic : null;
    return {
      runId: s?.run_id ?? null, extraRunIds: [c?.run_id ?? null], status: slop.ok && clean.ok ? 'ok' : 'critic_error',
      post: `SLOP → ${s?.verdict ?? (slop.ok ? '' : slop.error)} (${scoresOf(s)}): ${s?.notes ?? ''}\n\nCLEAN → ${c?.verdict ?? (clean.ok ? '' : clean.error)} (${scoresOf(c)}): ${c?.notes ?? ''}`,
      checks: [
        check('critic answered both posts', slop.ok && clean.ok, [slop.ok ? '' : slop.error, clean.ok ? '' : clean.error].filter(Boolean).join(' | ')),
        check('AI-sounding post: revise or reject', s?.verdict === 'revise' || s?.verdict === 'reject', `${s?.verdict} (${s?.reason})`),
        // The code verdict also counts the lint's slop warnings; this one is the model's own judgement.
        check('the model itself flags it (own verdict ≠ pass or ai_likeness ≤ 3)', !!s && (s.model_verdict !== 'pass' || sc(s, 'ai_likeness') <= 3), `model ${s?.model_verdict}, ai_likeness ${sc(s, 'ai_likeness')}`),
        check('clean human post: pass', c?.verdict === 'pass', `${c?.verdict} (${c?.reason}): ${c?.notes ?? ''}`),
        check('AI-likeness scored lower on the slop post', sc(s, 'ai_likeness') < sc(c, 'ai_likeness'), `${sc(s, 'ai_likeness')} vs ${sc(c, 'ai_likeness')}`, true),
        check('slop notes quote or name a concrete problem', !!s && s.notes.length >= 40, s?.notes ?? '', true),
        check('notes in Ukrainian', isUkrainian(`${s?.notes ?? ''} ${c?.notes ?? ''}`), undefined, true),
      ],
    };
  },
};

export const criticRejectsNonsense: EvalCase = {
  id: 'critic-rejects-nonsense', role: 'checker', channel: CRITIC,
  title: 'Критик: звʼязний, але хибний пост (місце, потужність, «виробляє», «вся Україна», «цього тижня») проти джерела → reject (sense ≤ 2 або grounding ≤ 2) (spec 034 FR-004)',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const card = await criticCard(ctx);
    if (!ctx.stack.critic) return { runId: null, status: 'disabled', checks: [check('critic enabled (EDITOR_CRITIC is not off)', false)] };
    const res = await ctx.stack.critic.review(criticRequest(card, NONSENSE_POST));
    const n = res.ok ? res.critic : null;
    return {
      runId: n?.run_id ?? null, status: res.ok ? 'ok' : 'critic_error',
      post: `NONSENSE → ${n?.verdict ?? (res.ok ? '' : res.error)} (${scoresOf(n)}): ${n?.notes ?? ''}`,
      checks: [
        check('critic answered', res.ok, res.ok ? undefined : res.error),
        check('verdict reject', n?.verdict === 'reject', `${n?.verdict} (${n?.reason})`),
        check('sense ≤ 2 or grounding ≤ 2', sc(n, 'sense') <= 2 || sc(n, 'grounding') <= 2, scoresOf(n)),
        check('grounding ≤ 2 (numbers and place contradict the source)', sc(n, 'grounding') <= 2, scoresOf(n), true),
        check('notes name a wrong fact (Львів / 2000 / виробляє / вся Україна / тижня)', !!n && /льв|2\s?000|вироб|генер|всю україн|вся україн|тижн|200\s?мвт|біл/iu.test(n.notes), n?.notes ?? '', true),
      ],
    };
  },
};

// ── 4. planner-poll-cap ────────────────────────────────────────────────────

/** 4 weeks where polls look best by views: the planner is tempted to plan another one. */
function pollHistory(): PostSeed[] {
  const out: PostSeed[] = [];
  for (let d = 1; d <= 28; d++) {
    out.push({ daysAgo: d, hour: 9, format: 'photo', title: `Ранкова новина ${d}`, views: 600 + (d % 4) * 25 });
    out.push({ daysAgo: d, hour: 14, format: 'text', title: `Денна новина ${d}`, views: 520 + (d % 3) * 30 });
    out.push({ daysAgo: d, hour: 19, format: d % 3 === 0 ? 'poll' : 'photo', title: d % 3 === 0 ? `Опитування ${d}` : `Вечірня новина ${d}`, views: d % 3 === 0 ? 1400 : 800, forwards: d % 3 === 0 ? 25 : 6 });
  }
  return out;
}

export const plannerPollCap: EvalCase = {
  id: 'planner-poll-cap', role: 'planner', channel: POLLCAP,
  title: 'Планувальник: poll у форматах, опитування вже було цього тижня (ліміт 1) → у фінальному плані немає poll/quiz; відмова валідатора — мʼякий провал (spec 034 FR-005)',
  web: () => new FakeWeb({ 'https://poll-news.example/rss': rss('Gadget News', [{ title: 'New foldable phones announced', link: 'https://poll-news.example/a', description: 'Three makers showed foldable phones this week.' }]) }),
  async execute(ctx) {
    await resetQuality(ctx.pool, [POLLCAP]);
    await createCard(ctx.pool, {
      channelKey: POLLCAP, title: 'Гаджети щодня', brief: 'Огляди й новини гаджетів: смартфони, ноутбуки, аксесуари.',
      formats: { photo: 1, text: 0.6, poll: 0.8, quiz: 0.5 }, hashtags: ['гаджети'], postsPerDayMin: 3, postsPerDayMax: 5, minGapMinutes: 90,
      sources: [{ id: 'gadget_rss', kind: 'rss', ref: 'https://poll-news.example/rss' }],
    });
    await seedPosts(ctx.pool, POLLCAP, pollHistory(), ctx.now);
    // The poll of this week: published 2 days ago (counts in the 7-day window of the cap).
    const twoDaysAgo = new Date(ctx.now.getTime() - 2 * DAY);
    const pastPlan = await ctx.stack.plans.createPlan(POLLCAP, localDate(twoDaysAgo, KYIV), 'eval: earlier this week', null, [{
      scheduledAt: zonedToUtc(localDate(twoDaysAgo, KYIV), '19:00', KYIV), format: 'poll', topic: 'Опитування: який складаний смартфон вам до вподоби',
      angle: null, sourceHints: [], isExperiment: false,
    }]);
    const [past] = await ctx.stack.plans.listSlots(POLLCAP, pastPlan);
    await ctx.stack.plans.updateSlot(past.id, { status: 'published' });
    const card = (await ctx.stack.channels.get(POLLCAP))!;
    const res = await ctx.stack.runner.runPlanner(card);
    const plan = await ctx.stack.plans.getActivePlan(POLLCAP, localDate(ctx.now, KYIV));
    const slots = plan ? await ctx.stack.plans.listSlots(POLLCAP, plan.id) : [];
    const steps = await stepsOf(ctx.pool, res.runId);
    const errs = toolErrors(steps);
    const polls = slots.filter((s) => s.format === 'poll' || s.format === 'quiz');
    const refusals = steps.filter((s) => s.type === 'tool' && s.tool_name === 'submit_plan' && JSON.stringify(s.output ?? '').includes('polls_per_week'));
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, toolErrors: errs, toolsUsed: steps.filter((s) => s.type === 'tool').map((s) => s.tool_name ?? '?'),
      post: plan ? `${plan.rationale}\n${slots.map((s) => `${s.scheduledAt.toISOString().slice(11, 16)}Z [${s.format}] ${s.topic}`).join('\n')}` : '',
      checks: [
        check('plan submitted', res.terminalTool === 'submit_plan' && !!plan, `${res.status} ${res.terminalTool ?? ''} ${res.error ?? ''}`),
        check('the card cap is the default 1 a week', card.pollsPerWeek === 1 || card.pollsPerWeek === undefined, String(card.pollsPerWeek)),
        check('no poll / quiz in the final plan (cap 1, already used)', polls.length === 0, polls.map((s) => `${s.format}: ${s.topic}`).join(' | ')),
        check('plan has slots', slots.length >= 1, String(slots.length)),
        check('no poll-cap refusal from the validator', refusals.length === 0, `${refusals.length} refusal(s)`, true),
        check('3–5 slots', slots.length >= 3 && slots.length <= 5, String(slots.length), true),
      ],
    };
  },
};

// ── 5–6. @ai0 creating a news agent: fitting formats, examples and warnings ──

const BUILD_MESSAGE = (key: string) => `@ai0 створи агента для мого каналу ${key}. Це канал коротких новин українського IT: 3–6 новин на день, `
  + '2–4 речення кожна, з посиланням на джерело. Аудиторія — розробники й менеджери 22–40 років. Мета — охоплення і ріст підписників. '
  + 'Тон нейтральний, без жартів і без політики. Назви агента «Стрічка».';
const BUILD_FOLLOW_UP = '@ai0 Виглядає добре. Що ще варто перевірити, перш ніж я застосую?';

/** One @ai0 conversation in a single chat: the first message, then (optionally) one follow-up. */
async function builderChat(ctx: CaseCtx, key: string, followUpUnless?: (actions: any[]) => boolean) {
  await resetQuality(ctx.pool, [key]);
  await ownChannel(ctx.pool, key, 'IT-стрічка');
  const chat = await ctx.stack.chat.createChat();
  const first = await ctx.stack.chat.sendMessage(chat.id, BUILD_MESSAGE(key));
  const actionsOf = async () => (await ctx.pool.query(`SELECT * FROM pending_actions WHERE chat_id = $1 ORDER BY created_at`, [chat.id])).rows;
  const afterFirst = await actionsOf();
  let second: typeof first | null = null;
  if (followUpUnless && !followUpUnless(afterFirst)) second = await ctx.stack.chat.sendMessage(chat.id, BUILD_FOLLOW_UP);
  const actions = second ? await actionsOf() : afterFirst;
  const runIds = [first.message.runId, second?.message.runId ?? null];
  const traces = await Promise.all(runIds.map((id) => trace(ctx, id ?? null)));
  return {
    first: first.message, second: second?.message ?? null, actions, afterFirst, runIds,
    toolsUsed: traces.flatMap((t) => t.toolsUsed), toolErrors: traces.flatMap((t) => t.toolErrors),
  };
}

const HEAVY_FOR_SHORT_NEWS = ['longread', 'carousel'];
const POLLS = ['poll', 'quiz'];

export const builderFittingFormats: EvalCase = {
  id: 'builder-fitting-formats', role: 'builder', channel: BUILD_FMT,
  title: '@ai0 створює агента для каналу коротких IT-новин → create_agent з ≤ 4 форматами з причинами, без poll/quiz, без longread/carousel (spec 034 FR-007, FR-009)',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const r = await builderChat(ctx, BUILD_FMT);
    const card = r.actions.find((a: any) => a.kind === 'create_agent');
    const p = card?.payload ?? {};
    const formats: Array<{ format: string; reason: string }> = Array.isArray(p.formats) ? p.formats : [];
    const names = formats.map((f) => String(f.format));
    const created = p.handle ? await ctx.stack.agents.getByHandle(String(p.handle)) : null;
    return {
      runId: r.first.runId, status: r.first.content ? 'ok' : 'empty', post: `${r.first.content}\n\nformats: ${JSON.stringify(formats)}`,
      toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('a create_agent card was proposed', !!card, r.actions.map((a: any) => a.kind).join(', ') || 'none'),
        check('formats chosen explicitly (1–4)', formats.length >= 1 && formats.length <= 4, `${formats.length}: ${names.join(', ')}`),
        check('every format has a reason (≥ 10 chars)', formats.length > 0 && formats.every((f) => String(f.reason ?? '').trim().length >= 10), formats.map((f) => `${f.format}: ${f.reason}`).join(' | ')),
        check('no poll / quiz', !names.some((f) => POLLS.includes(f)), names.join(', ')),
        check('no longread / carousel for short news', !names.some((f) => HEAVY_FOR_SHORT_NEWS.includes(f)), names.join(', ')),
        check('nothing created before Apply', !created, created?.handle),
        check('text is among the formats (short news)', names.includes('text'), names.join(', '), true),
        check('taboo stays a topic, not banned words', !(Array.isArray(p.banned_terms) && p.banned_terms.some((t: string) => /політ/iu.test(t))), JSON.stringify(p.banned_terms ?? null), true),
        check('humour off in the brief or tone (owner said no jokes)', /жарт|гумор|нейтральн/iu.test(`${p.brief ?? ''} ${p.profile?.tone ?? ''}`), `${p.profile?.tone ?? ''}`, true),
        check('answer in Ukrainian', isUkrainian(r.first.content)),
      ],
    };
  },
};

/** Warning text that names one of the bad-post patterns spec 034 cares about for news. */
const NEWS_PATTERN = /(клікбейт|заголов|джерел|неперевір|чутк|гумор|жарт|сленг|опитуван|питан|емодзі|штамп|пафос|вода|довг|переказ|повтор|реклам|політ|сенсац|оклик)/iu;

export const builderExamplesAndWarnings: EvalCase = {
  id: 'builder-examples-and-warnings', role: 'builder', channel: BUILD_EX,
  title: '@ai0 під час створення агента викликає propose_content_examples: 3 приклади, що проходять slop-lint, і 2–4 конкретні застереження (spec 034 FR-008)',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    // One follow-up turn is allowed when the first answer has no examples card yet.
    const r = await builderChat(ctx, BUILD_EX, (acts) => acts.some((a: any) => a.kind === 'content_examples'));
    const create = r.actions.find((a: any) => a.kind === 'create_agent');
    const exCard = [...r.actions].reverse().find((a: any) => a.kind === 'content_examples');
    const p = exCard?.payload ?? {};
    const examples: CardExample[] = Array.isArray(p.examples) ? p.examples : [];
    const warnings: CardWarning[] = Array.isArray(p.warnings) ? p.warnings : [];
    const ref = `telegram:${BUILD_EX}`;
    const lintCard = exampleCard(ref, await ctx.stack.channels.get(BUILD_EX));
    const lints = examples.map((e) => checkExample(e, lintCard));
    const texts = examples.map((e) => e.text);
    const slopHits = texts.flatMap((t) => bannedHits(t));
    const jokes = texts.flatMap((t) => [...humorHits(t), ...slangHits(t)]);
    const questions = texts.map((t) => readerQuestions(t).length);
    const createFormats = Array.isArray(create?.payload?.formats) ? create.payload.formats.map((f: any) => String(f.format)) : ['text', 'photo'];
    const pairs = texts.flatMap((a, i) => texts.slice(i + 1).map((b) => similarity(a, b)));
    const created = create?.payload?.handle ? await ctx.stack.agents.getByHandle(String(create.payload.handle)) : null;
    return {
      runId: r.first.runId, extraRunIds: r.runIds.slice(1), status: exCard ? 'ok' : 'no_examples',
      post: [
        ...examples.map((e, i) => `#${i + 1} [${e.format}] ${e.title}\n${e.text}\n(why: ${e.why})`),
        ...warnings.map((w, i) => `⚠ ${i + 1}. ${w.pattern}: ${w.why}\n   bad: ${w.bad_example}`),
      ].join('\n\n'),
      toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('a create_agent card was proposed', !!create, r.actions.map((a: any) => a.kind).join(', ') || 'none'),
        check('propose_content_examples called in the creation chat', !!exCard, r.toolsUsed.join(' → ')),
        check('in the same answer as create_agent', r.afterFirst.some((a: any) => a.kind === 'content_examples'), r.second ? 'needed a follow-up' : '', true),
        check('exactly 3 examples', examples.length === 3, String(examples.length)),
        check('examples pass the slop lint (resource card)', examples.length > 0 && lints.every((l) => l.ok), lints.map((l, i) => (l.ok ? '' : `#${i + 1}: ${l.problems.join('; ')}`)).filter(Boolean).join(' | ')),
        check('no banned slop phrases in examples', slopHits.length === 0, slopHits.join(', ')),
        check('no jokes or slang in examples', jokes.length === 0, jokes.join(', ')),
        check('reader questions ≤ 1 per example', questions.every((n) => n <= 1), questions.join(',')),
        check('examples in Ukrainian', examples.length > 0 && texts.every((t) => isUkrainian(t))),
        check('2–4 warnings', warnings.length >= 2 && warnings.length <= 4, String(warnings.length)),
        check('warnings are concrete (distinct patterns, a bad example ≥ 20 chars, a reason ≥ 10)',
          warnings.length >= 2 && new Set(warnings.map((w) => w.pattern.trim().toLowerCase())).size === warnings.length
            && warnings.every((w) => w.bad_example.trim().length >= 20 && w.why.trim().length >= 10),
          warnings.map((w) => `${w.pattern} (${w.bad_example.length})`).join(' | ')),
        check('nothing created before Apply', !created, created?.handle),
        check('no reader questions in news examples', questions.every((n) => n === 0), questions.join(','), true),
        check('example formats are the agreed ones', examples.every((e) => createFormats.includes(e.format)), `${examples.map((e) => e.format).join(',')} vs ${createFormats.join(',')}`, true),
        check('the three examples differ (similarity < 0.8)', pairs.every((x) => x < 0.8), pairs.map((x) => x.toFixed(2)).join(','), true),
        check('rendered as Telegram previews', examples.length > 0 && examples.every((e) => Array.isArray(e.render) && e.render.length > 0), undefined, true),
        check('≥ 2 warnings name a news-specific bad pattern', warnings.filter((w) => NEWS_PATTERN.test(`${w.pattern} ${w.why}`)).length >= 2, warnings.map((w) => w.pattern).join(' | '), true),
        check('examples accepted on the first call', !r.toolErrors.some((e) => e.includes('examples_rejected')), r.toolErrors.join(', '), true),
      ],
    };
  },
};

// ── 7. manager-flags-quality ───────────────────────────────────────────────

const MQ_REF = `telegram:${MQ}`;
export const MQ_SLOPPY = 'Друзі, давайте розберемося, чому ця новина змінить усе! А ви як думаєте?';
export const MQ_TWO_QUESTIONS = 'Нова місія до Європи стартує восени. А ви б полетіли? Як думаєте, вона знайде там життя?';

const criticRow = (verdict: 'pass' | 'revise' | 'reject', notes: string, at: Date, extra: Record<string, unknown> = {}) => ({
  verdict, notes, reason: verdict === 'pass' ? 'scores_ok' : verdict === 'reject' ? 'score_le_2: sense, voice' : 'score_le_3: ai_likeness', pass: 1,
  scores: { ai_likeness: verdict === 'pass' ? 4 : 2, sense: verdict === 'reject' ? 1 : 4, voice: verdict === 'reject' ? 2 : 3, grounding: 5, audience_asks: 4, format_fit: 4 },
  model_verdict: verdict, slop_warnings: [], model: 'eval', run_id: null, cost_usd: 0, at: at.toISOString(), ...extra,
});

/**
 * A week of sloppy quality on one resource (T4 "Notes for T9"): KPIs flat (no anomaly), ≥ 3 critic verdicts with a
 * reject and notes, 2 polls against the default cap 1, a waiting post with two reader questions, an owner rejection
 * with a reason and an owner edit (with its memory note), sloppy sample texts. Returns the slot ids that matter.
 */
async function sloppyWeek(ctx: CaseCtx): Promise<{ orchId: string; manager: Agent; rejected: string[] }> {
  await resetQuality(ctx.pool, [MQ]);
  await ownChannel(ctx.pool, MQ, 'Космос щодня');
  await createCard(ctx.pool, {
    channelKey: MQ, title: 'Космос щодня', brief: 'Космічні новини і факти простою мовою для широкої аудиторії.',
    formats: { text: 1, photo: 0.6, poll: 0.5 }, hashtags: ['космос', 'nasa'], postsPerDayMin: 1, postsPerDayMax: 4,
  });
  await ctx.pool.query(`UPDATE editor_channels SET mode = 'approve' WHERE channel_key = $1`, [MQ]);
  // Flat KPIs: 5 weeks of posts around 1,000 views (no anomaly, so KPIs give no reason to act).
  const posts: PostSeed[] = [];
  for (let d = 2; d <= 35; d++) posts.push({ daysAgo: d, hour: 12, format: d % 3 ? 'photo' : 'text', title: `Пост ${d}`, views: 1000 + Math.round(Math.sin(d * 3.7) * 60), forwards: 5, reactions: 20 });
  await seedPosts(ctx.pool, MQ, posts, ctx.now);
  await ctx.stack.registrySync.run();
  const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', MQ_REF))!;
  await ctx.pool.query(`UPDATE agents SET mode = 'live' WHERE id = $1`, [orch.id]);
  await ctx.stack.networkRepo.insertPlaybook({
    agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'eval',
    body: PlaybookSchema.parse({ platforms: [{ resource_ref: MQ_REF, role: 'core', formats: { text: 1, photo: 0.6, poll: 0.5 }, per_day: { min: 1, max: 4 } }] }),
  });
  const planId = (await ctx.pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, 'eval week') RETURNING id`, [MQ, localDate(ctx.now, KYIV)])).rows[0].id;
  const add = async (o: { hoursAgo: number; format?: string; status: string; text: string; critic?: unknown; error?: string; approved?: boolean; edited?: boolean; reason?: string }) => {
    const at = ago(ctx.now, o.hoursAgo);
    const spec = { format: o.format ?? 'text', title: o.text.slice(0, 60), body: [{ type: 'p', text: o.text }] };
    const { rows } = await ctx.pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec, rendered_preview, critic, error,
                                 approved_at, approved_by, owner_edited, reject_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN $3::timestamptz END, CASE WHEN $11 THEN 'owner' END, $12, $13, $3)
       RETURNING id`,
      [planId, MQ, at, o.format ?? 'text', o.text.slice(0, 80), o.status, JSON.stringify(spec), o.text, o.critic ? JSON.stringify(o.critic) : null,
        o.error ?? null, !!o.approved, !!o.edited, o.reason ?? null]);
    return rows[0].id as string;
  };
  await add({ hoursAgo: 130, status: 'published', text: 'NASA показала нові знімки туманності Карина.', critic: criticRow('pass', 'Чисто, по суті.', ago(ctx.now, 130)) });
  await add({ hoursAgo: 100, status: 'published', format: 'photo', text: 'Неймовірний, захопливий і вражаючий знімок Вебба відкриває нову сторінку в історії космосу!',
    critic: criticRow('pass', 'Після переписування прийнятно.', ago(ctx.now, 100), { history: [{ verdict: 'revise', notes: 'Тріада прикметників і пафос у вступі', pass: 1 }] }) });
  const criticRejected = await add({ hoursAgo: 80, status: 'skipped', error: 'critic_rejected: reject (sense 1): безглуздо', text: 'Космос — це як піца: чим більше, тим смачніше, лол.',
    critic: criticRow('reject', 'Безглуздий текст і жарт при вимкненому гуморі.', ago(ctx.now, 80)) });
  await add({ hoursAgo: 72, status: 'published', format: 'poll', text: 'Опитування: яка планета вам найцікавіша?', critic: criticRow('pass', 'Ок.', ago(ctx.now, 72)) });
  await add({ hoursAgo: 30, status: 'published', format: 'poll', text: 'Опитування: чи полетіли б ви на Марс?', critic: criticRow('pass', 'Ок.', ago(ctx.now, 30)) });
  const ownerRejected = await add({ hoursAgo: 20, status: 'skipped', error: 'rejected by owner', reason: 'Штампи, пафос і зайве питання до читачів', text: MQ_SLOPPY,
    critic: criticRow('pass', 'Прийнятно.', ago(ctx.now, 20)) });
  const edited = await add({ hoursAgo: 12, status: 'published', approved: true, edited: true, text: 'Марсохід знайшов шарувату породу в кратері Єзеро.', critic: criticRow('pass', 'Ок.', ago(ctx.now, 12)) });
  await ctx.pool.query(`INSERT INTO editor_channel_memory (channel_key, kind, text, evidence, created_by) VALUES ($1, 'rule', $2, $3, 'owner')`,
    [MQ, 'Власник відредагував пост «Марс» перед апрувом: прибрав «Друзі, давайте розберемося» і питання до читачів',
      JSON.stringify({ source: 'approval', action: 'edit', slotId: edited, resourceRef: null, topic: 'Марс' })]);
  await add({ hoursAgo: 2, status: 'awaiting_approval', text: MQ_TWO_QUESTIONS,
    critic: criticRow('revise', 'Два питання до читачів при ліміті 1.', ago(ctx.now, 2), { final: true }) });
  const manager = (await ctx.stack.agents.findTop('manager', 'system', null))!;
  await ctx.pool.query(`UPDATE agents SET mode = 'live' WHERE id = $1`, [manager.id]);
  return { orchId: orch.id, manager: { ...manager, mode: 'live' }, rejected: [criticRejected, ownerRejected] };
}

const QUALITY_KINDS = ['voice_fix', 'format_mix'];

export const managerFlagsQuality: EvalCase = {
  id: 'manager-flags-quality', role: 'manager', channel: MQ,
  title: 'MANAGER: тиждень зі штампами, відмовами критика, 2 опитуваннями при ліміті 1, двома питаннями до читачів, відхиленням і правкою власника (KPI рівні) → voice_fix / format_mix або continue з quality_check «issue» + нотатка; «ok» = провал (spec 034 FR-006)',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const { orchId, manager, rejected } = await sloppyWeek(ctx);
    const startedAt = new Date(Date.now() - 1000);
    let res: any;
    try {
      res = await ctx.stack.manager.run(manager);
    } finally {
      await ctx.pool.query(`UPDATE agents SET mode = 'off' WHERE id = $1`, [manager.id]);
    }
    const { rows: rev } = await ctx.pool.query(`SELECT verdict, summary, quality_check FROM manager_reviews WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 1`, [startedAt]);
    const review = rev[0] ?? null;
    const qc: Array<{ resource_ref: string; status: string; evidence?: string; issues?: string[]; note?: string }> = Array.isArray(review?.quality_check) ? review.quality_check : [];
    const mine = qc.find((x) => x.resource_ref === MQ_REF) ?? null;
    const dirs = (await ctx.stack.directives.list({ toAgentId: orchId, limit: 20 })).filter((d) => d.createdAt >= startedAt);
    const quality = dirs.filter((d) => QUALITY_KINDS.includes(d.kind));
    const issueWithNote = mine?.status === 'issue' && String(mine.note ?? '').trim().length >= 20;
    const t = await trace(ctx, res?.runId ?? null);
    const refusals = t.toolErrors.filter((e) => /quality_(check_missing|flags_ignored|issue_unaddressed)/.test(e));
    const voice = quality.find((d) => d.kind === 'voice_fix');
    const mix = quality.find((d) => d.kind === 'format_mix');
    const badIds = Array.isArray(voice?.params?.bad_slot_ids) ? (voice!.params.bad_slot_ids as string[]) : [];
    const mp = (mix?.params ?? {}) as { weights?: Record<string, number>; drop?: string[]; polls_per_week?: number };
    const lowersPolls = !!mix && ((mp.weights?.poll ?? 1) < 0.5 || (mp.drop ?? []).includes('poll') || (mp.polls_per_week ?? 99) <= 1);
    return {
      runId: res?.runId ?? null, status: res?.status ?? res?.skipped ?? 'none', terminalTool: res?.terminalTool, ...t,
      post: [
        `verdict: ${review?.verdict ?? '-'} — ${review?.summary ?? ''}`,
        `quality_check(${MQ_REF}): ${mine ? `${mine.status} · ${mine.evidence ?? ''} · issues ${JSON.stringify(mine.issues ?? [])} · note ${mine.note ?? '-'}` : 'missing'}`,
        ...dirs.map((d) => `${d.binding}/${d.kind}: ${d.body} ${JSON.stringify(d.params)}`),
      ].join('\n'),
      checks: [
        check('the run was not skipped', !res?.skipped, res?.skipped),
        check('a review was stored', !!review, review?.verdict),
        check('the flagged resource is never marked ok', mine?.status !== 'ok', mine ? `${mine.status}: ${mine.note ?? ''}` : 'missing'),
        check('acted on quality: voice_fix / format_mix filed, or quality_check «issue» with a note',
          quality.length >= 1 || issueWithNote, `${quality.map((d) => d.kind).join(', ') || 'no quality directive'} · qc ${mine?.status ?? 'missing'}`),
        check('a quality directive was filed (voice_fix or format_mix)', quality.length >= 1, dirs.map((d) => d.kind).join(', ') || 'none', true),
        check('filed as advice (quality metrics carry no anomaly)', quality.every((d) => d.binding === 'advice'), quality.map((d) => `${d.kind}:${d.binding}`).join(', '), true),
        check('voice_fix quotes a rejected post (bad_slot_ids)', !voice || badIds.some((id) => rejected.includes(id)), badIds.join(', '), true),
        check('format_mix lowers polls (weight, drop or polls_per_week)', !mix || lowersPolls, JSON.stringify(mp), true),
        check('quality_check accepted without refusals', refusals.length === 0, refusals.join(' | '), true),
        check('quality_check cites evidence with a number or a quote', !!mine && /\d|«|"/.test(mine.evidence ?? ''), mine?.evidence ?? '', true),
        check('summary in Ukrainian', isUkrainian(review?.summary ?? ''), undefined, true),
      ],
    };
  },
};

// ── 8. executor-live-news-fresh ────────────────────────────────────────────

const LIVE_FEED = 'https://ua-it-news.example/rss';
const SLOW_FEED = 'https://ua-it-news.example/rss-weekly';
export const LIVE_ITEMS = {
  posted:  { title: 'Укренерго запустило онлайн-карту відключень для всіх областей', link: 'https://ua-it-news.example/news/outage-map', hours: 0.5,
    text: ['Укренерго запустило онлайн-карту відключень, яка показує графіки для всіх 24 областей.', 'Карта оновлюється кожні 15 хвилин.'] },
  fresh:   { title: 'Київський стартап Robotica отримав 3 млн доларів на роботів для розмінування', link: 'https://ua-it-news.example/news/robotica-demining', hours: 1.5,
    text: ['Київський стартап Robotica залучив 3 млн доларів посівних інвестицій від двох європейських фондів.', 'Компанія робить гусеничних роботів, які перевіряють поля на міни зі швидкістю до 2 гектарів на день.', 'Перші 10 роботів передадуть ДСНС у березні.'] },
  older:   { title: 'Сервіс Lunka запустив доставку ліків дронами у Вінниці', link: 'https://ua-it-news.example/news/lunka-drones', hours: 4.5,
    text: ['Сервіс Lunka почав доставляти ліки дронами у Вінниці: замовлення приходить за 20 хвилин.', 'Поки дрони літають у 3 райони міста.'] },
  stale:   { title: 'Харківський ІТ-кластер провів хакатон для школярів', link: 'https://ua-it-news.example/news/kharkiv-hackathon', hours: 30,
    text: ['Харківський ІТ-кластер провів хакатон для 120 школярів.', 'Переможці отримали стажування в місцевих компаніях.'] },
  stale2:  { title: 'Львівська ІТ-школа відкрила безкоштовний курс з тестування', link: 'https://ua-it-news.example/news/lviv-qa-course', hours: 20,
    text: ['Львівська ІТ-школа відкрила безкоштовний курс з тестування на 8 тижнів.'] },
  stale3:  { title: 'Одеський стартап показав застосунок для обліку зерна', link: 'https://ua-it-news.example/news/odesa-grain', hours: 40,
    text: ['Одеський стартап показав застосунок для обліку зерна на елеваторах.'] },
} as const;
type LiveItem = typeof LIVE_ITEMS[keyof typeof LIVE_ITEMS];

/** The fixture feeds dated against the case clock: the mixed feed and the one with nothing fresh and unposted. */
export function liveWeb(now: Date): FakeWeb {
  const item = (i: LiveItem) => ({ title: i.title, link: i.link, description: i.text[0], date: ago(now, i.hours).toUTCString() });
  const pages: Record<string, string> = {
    [LIVE_FEED]: rss('UA IT News', [LIVE_ITEMS.posted, LIVE_ITEMS.fresh, LIVE_ITEMS.older, LIVE_ITEMS.stale].map(item)),
    [SLOW_FEED]: rss('UA IT Weekly', [LIVE_ITEMS.posted, LIVE_ITEMS.stale2, LIVE_ITEMS.stale3].map(item)),
  };
  for (const i of Object.values(LIVE_ITEMS)) pages[i.link] = article({ title: i.title, paragraphs: [...i.text] });
  return new FakeWeb(pages);
}

/** A live slot as the planner makes it (no fixed topic), claimed as running — what the scheduler hands the executor. */
async function liveSlots(ctx: CaseCtx, specs: Array<{ sources: string[]; brief: string }>) {
  const at = new Date(ctx.now.getTime() - 60_000);
  const planId = await ctx.stack.plans.createPlan(LIVE, localDate(ctx.now, KYIV), 'eval: live news slots', null, specs.map((s, i) => ({
    scheduledAt: new Date(at.getTime() - i * 60_000), format: 'text', topic: 'Свіжа новина з ua-it-news.example', angle: null, sourceHints: [],
    isExperiment: false, topicMode: 'live' as const, live: { sources: s.sources, brief: s.brief, max_age_hours: 6, origin: 'planner' as const },
  })));
  return ctx.stack.plans.listSlots(LIVE, planId);
}

async function runClaimed(ctx: CaseCtx, slotId: string) {
  await ctx.pool.query(`UPDATE editor_slots SET status = 'running', attempts = 1 WHERE id = $1`, [slotId]);
  const slot = (await ctx.stack.plans.getSlot(slotId))!;
  const card = (await ctx.stack.channels.get(LIVE))!;
  const calls = ctx.stack.llm.calls;
  const res = await ctx.stack.runner.runExecutor(slot, card);
  return { res, after: (await ctx.stack.plans.getSlot(slotId))!, llmCalls: ctx.stack.llm.calls - calls };
}

export const executorLiveNewsFresh: EvalCase = {
  id: 'executor-live-news-fresh', role: 'executor', channel: LIVE,
  title: 'Live-слот новин: фейкова стрічка (свіжі, старі, вже опублікована) → пост про найсвіжішу неопубліковану; лише старі/опубліковані → skip no_fresh_item без LLM (spec 034 FR-010)',
  web: (now) => liveWeb(now),
  async execute(ctx) {
    await resetQuality(ctx.pool, [LIVE]);
    await createCard(ctx.pool, {
      channelKey: LIVE, mode: 'live', title: 'IT-стрічка', brief: 'Короткі новини українського IT: 2–4 речення, з посиланням на джерело.',
      formats: { text: 1, photo: 0.5 }, hashtags: ['it', 'новини'], hashtagMin: 0, hashtagMax: 2, postsPerDayMax: 8, minGapMinutes: 30,
      sources: [{ id: 'it_rss', kind: 'rss', ref: LIVE_FEED }, { id: 'it_weekly', kind: 'rss', ref: SLOW_FEED }],
    });
    await ctx.stack.profiles.patchFormat(`telegram:${LIVE}`, { content_kind: 'news', humor: 'none' }, { by: 'owner' });
    // Already posted today at 08:00: the freshest item of both feeds.
    await seedPosts(ctx.pool, LIVE, [{ daysAgo: 0, hour: 8, format: 'text', title: LIVE_ITEMS.posted.title, views: 900 }], ctx.now);
    const [slotFresh, slotStale] = await liveSlots(ctx, [
      { sources: ['it_rss'], brief: 'Найсвіжіша новина українського IT зі стрічки' },
      { sources: ['it_weekly'], brief: 'Свіжа новина з тижневої стрічки' },
    ]);
    // B first: nothing fresh and unposted in the weekly feed → skipped by code, no LLM call.
    const b = await runClaimed(ctx, slotStale.id);
    // A: the mixed feed → the freshest unposted item (not the posted one, not the stale one).
    const a = await runClaimed(ctx, slotFresh.id);
    const spec = (a.after.postSpec ?? null) as PostSpec | null;
    const url = spec?.source?.url ?? null;
    const text = readerText(a.after);
    const source = LIVE_ITEMS.fresh.text.join('\n');
    const steps = await stepsOf(ctx.pool, a.res.runId);
    return {
      runId: a.res.runId, extraRunIds: a.after.critic?.run_id ? [a.after.critic.run_id] : [], status: a.res.status, terminalTool: a.res.terminalTool, post: text,
      toolErrors: toolErrors(steps), toolsUsed: steps.filter((x) => x.type === 'tool').map((x) => x.tool_name ?? '?'),
      checks: [
        check('fresh feed: published (fake Telegram)', a.after.status === 'published', `slot=${a.after.status} ${a.after.error ?? ''}`),
        check('the post cites the freshest unposted item', url === LIVE_ITEMS.fresh.link, url ?? 'no source'),
        check('never the already-posted item', url !== LIVE_ITEMS.posted.link, url ?? ''),
        check('never a stale item (> 6 h)', url !== LIVE_ITEMS.stale.link, url ?? ''),
        check('sent once', ctx.stack.sent.length === 1, `sends=${ctx.stack.sent.length}`),
        check('no banned slop phrases', bannedHits(text).length === 0, bannedHits(text).join(', ')),
        check('numbers grounded in the chosen item', ungroundedNumbers(text, source).length === 0, ungroundedNumbers(text, source).join(', ')),
        check('Ukrainian', isUkrainian(text)),
        check('stale feed: skipped with no_fresh_item', b.after.status === 'skipped' && String(b.after.error ?? '').startsWith('no_fresh_item'), `${b.after.status} ${b.after.error ?? ''}`),
        check('stale feed: no LLM call', b.llmCalls === 0 && !b.res.runId, `calls=${b.llmCalls} run=${b.res.runId ?? '-'}`),
        check('no reader questions (news)', readerQuestions(text).length === 0, readerQuestions(text).join(' | '), true),
        check('not the older fresh item either', url !== LIVE_ITEMS.older.link, url ?? '', true),
      ],
      judge: spec ? { channelBrief: 'Короткі новини українського IT', slotTopic: 'Найсвіжіша новина зі стрічки', sourceText: source, post: text } : undefined,
    };
  },
};

export const QUALITY_CASES: EvalCase[] = [
  executorVoicePlain, criticRejectsSlop, criticRejectsNonsense, plannerPollCap, builderFittingFormats, builderExamplesAndWarnings,
  managerFlagsQuality, executorLiveNewsFresh,
];
