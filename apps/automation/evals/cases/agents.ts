import type { Pool } from 'pg';
import type { CaseCtx, EvalCase } from '../lib/case';
import { FakeWeb, article } from '../lib/fake-web';
import { check, isUkrainian, stepsOf, toolErrors } from '../lib/graders';
import { createCard, PostSeed, seedPosts } from '../lib/seed';
import { localDate, zonedToUtc } from '../../src/editor/roles/time';
import { validateHandle } from '../../src/editor/agents/agent.types';
import { PlaybookSchema } from '../../src/editor/network/playbook';
import { ResourceProfileSchema } from '../../src/editor/agents/resource-profile';
import { similarity } from '../../src/editor/post/similarity';

// Specs 017–022: the @ai0 builder, channel agents in the chat, playbooks, the idea reviewer,
// the network planner, native platform posts and the MANAGER — real LLM, scratch DB, nothing published.

const KYIV = 'Europe/Kyiv';
const GROUP = 'Eval мережа';

/** Remove agent-platform state of eval channels (scratch DB only). */
async function resetAgents(pool: Pool, keys: string[]): Promise<void> {
  const refs = keys.map((k) => `telegram:${k}`);
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = ANY($1::text[])`, [refs]);
  const ids = rows.map((r) => r.id);
  // Spec 024: decisions and their derived slots of the eval agents (children included).
  await pool.query(`DELETE FROM content_decisions WHERE agent_id = ANY($1::uuid[]) OR agent_id IN (SELECT id FROM agents WHERE parent_id = ANY($1::uuid[]))`, [ids]);
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM content_ideas WHERE agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM agents WHERE scope_id = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM pending_actions WHERE payload->>'resource_ref' = ANY($1::text[]) OR payload->>'handle' LIKE 'eval%'`, [refs]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = ANY($1::text[]) OR resource_ref LIKE 'instagram:%' OR resource_ref LIKE 'threads:%' OR resource_ref LIKE 'facebook:%'`, [refs]);
  await pool.query(`DELETE FROM platform_posts WHERE caption LIKE '%#%' AND resource_ref LIKE 'instagram:%'`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_channel_memory WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = ANY($1::text[])`, [keys]);
  await pool.query(`DELETE FROM meta_accounts WHERE account_id LIKE 'eval-%'`);
  await pool.query(`DELETE FROM meta_account_groups WHERE name = $1`, [GROUP]);
  await pool.query(`DELETE FROM manager_reviews WHERE created_at > now() - interval '1 day'`);
}

async function ownChannel(pool: Pool, key: string, title: string, groupId: string | null = null): Promise<void> {
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine, kind, group_id) VALUES ($1, $2, $3, true, 'public', $4)`,
    [key, key.slice(1), title, groupId]);
}

/** A network: Telegram anchor + an Instagram account in one group. Returns the IG resource ref. Modes as of spec 024 (migration 061). */
async function network(pool: Pool, key: string, mode: 'legacy_duplicate' | 'independent'): Promise<{ groupId: string; ig: string }> {
  const groupId = (await pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', $2) RETURNING id`, [GROUP, mode])).rows[0].id;
  await ownChannel(pool, key, 'Космос щодня', groupId);
  const ig = (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, display_name, group_id, last_verified_at)
     VALUES ('instagram', 'eval-ig', 'EVAL_NONE', 'eval-target', 'space_daily_ig', 'Космос щодня (IG)', $1, now()) RETURNING id`, [groupId])).rows[0].id;
  return { groupId, ig: `instagram:${ig}` };
}

const SPACE_CARD = (key: string) => ({
  channelKey: key, title: 'Космос щодня', brief: 'Космічні новини і факти простою мовою для широкої аудиторії.',
  formats: { longread: 0.5, photo: 0.5, carousel: 0.4 }, hashtags: ['космос', 'nasa', 'астрономія'], postsPerDayMin: 1, postsPerDayMax: 4,
});

async function trace(ctx: CaseCtx, runId: string | null) {
  const steps = await stepsOf(ctx.pool, runId);
  return { toolErrors: toolErrors(steps), toolsUsed: steps.filter((x) => x.type === 'tool').map((x) => x.tool_name ?? '?') };
}

async function sendAgentChat(ctx: CaseCtx, text: string) {
  const chat = await ctx.stack.chat.createChat();
  const { message } = await ctx.stack.chat.sendMessage(chat.id, text);
  const { rows } = await ctx.pool.query(`SELECT * FROM pending_actions WHERE chat_id = $1 ORDER BY created_at`, [chat.id]);
  return { message, actions: rows, ...(await trace(ctx, message.runId)) };
}

// ── A1: @ai0 onboarding ─────────────────────────────────────────────────────

const TRAVEL = '@eval_travel';
export const builderOnboarding: EvalCase = {
  id: 'builder-onboarding', role: 'builder', channel: TRAVEL,
  title: '@ai0: «створи агента для мого каналу» з описом → картка create_agent з профілем, нічого не створено без Apply',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    await resetAgents(ctx.pool, [TRAVEL]);
    await ownChannel(ctx.pool, TRAVEL, 'Мандри вихідного дня');
    const r = await sendAgentChat(ctx, `@ai0 створи агента для мого каналу ${TRAVEL}. Тема — подорожі Україною на вихідні, аудиторія — люди 25–45 років. Цілі — ріст підписників і охоплення. Тон дружній, без політики. Назви агентку «Мандрівниця».`);
    const card = r.actions.find((a: any) => a.kind === 'create_agent');
    const p = card?.payload ?? {};
    const created = await ctx.stack.agents.getByHandle(String(p.handle ?? 'none'));
    return {
      runId: r.message.runId, status: r.message.content ? 'ok' : 'empty', post: r.message.content, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('a create_agent card was proposed', !!card, r.actions.map((a: any) => a.kind).join(', ') || 'none'),
        check('card targets the channel', p.resource_ref === `telegram:${TRAVEL}`, p.resource_ref),
        check('handle is valid', !!p.handle && validateHandle(String(p.handle)) === null, p.handle),
        check('profile topic is from the owner (travel)', /подорож|мандр/i.test(String(p.profile?.topic ?? '')), p.profile?.topic),
        check('taboo includes politics', (p.profile?.taboo ?? []).some((t: string) => /політ/i.test(t)), JSON.stringify(p.profile?.taboo)),
        check('goals include growth', (p.profile?.goals ?? []).includes('growth'), JSON.stringify(p.profile?.goals)),
        check('nothing created before Apply', !created, created?.handle),
        check('inspected the resource first', r.toolsUsed.includes('inspect_resource'), r.toolsUsed.join(' → '), true),
        check('answer in Ukrainian', isUkrainian(r.message.content)),
        check('never asks for tokens', !/токен|парол|api key|ключ api/i.test(r.message.content), undefined),
      ],
    };
  },
};

// ── A2: @handle explains a decision ─────────────────────────────────────────

const EXPLAIN = '@eval_explain';
export const mentionExplain: EvalCase = {
  id: 'mention-explain', role: 'composer', channel: EXPLAIN,
  title: '@agent «чому вчора пропустив слот о 19:00?» → відповідь з причиною з історії (explain_decision), без вигадок і публікацій',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    await resetAgents(ctx.pool, [EXPLAIN]);
    await ownChannel(ctx.pool, EXPLAIN, 'Космос щодня');
    await createCard(ctx.pool, SPACE_CARD(EXPLAIN));
    await ctx.stack.registrySync.run();
    const handle = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${EXPLAIN}`))!.handle;
    const yesterday = localDate(new Date(ctx.now.getTime() - 86_400_000), KYIV);
    const plan = (await ctx.pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, 'Три пости про Місяць') RETURNING id`, [EXPLAIN, yesterday])).rows[0].id;
    await ctx.pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, error) VALUES
         ($1, $2, $3, 'photo', 'Нове фото кратера Тихо', 'published', NULL),
         ($1, $2, $4, 'longread', 'Історія місії Артеміда', 'skipped', 'skipped by agent: джерело вже публікувалось 3 дні тому, нового матеріалу немає')`,
      [plan, EXPLAIN, zonedToUtc(yesterday, '10:00', KYIV), zonedToUtc(yesterday, '19:00', KYIV)]);
    const r = await sendAgentChat(ctx, `@${handle} чому вчора пропустив слот о 19:00?`);
    return {
      runId: r.message.runId, status: r.message.content ? 'ok' : 'empty', post: r.message.content, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('used explain_decision', r.toolsUsed.includes('explain_decision'), r.toolsUsed.join(' → ')),
        check('names the real reason (source already published)', /джерел|вже публікува|нового матеріалу|повтор/i.test(r.message.content), r.message.content.slice(0, 300)),
        check('nothing published', ctx.stack.sent.length === 0),
        check('answer in Ukrainian', isUkrainian(r.message.content)),
      ],
    };
  },
};

// ── A3: brief → playbook ────────────────────────────────────────────────────

const NET = '@eval_net';
export const playbookFromBrief: EvalCase = {
  id: 'playbook-from-brief', role: 'orchestrator', channel: NET,
  title: 'Бриф «TG — лонгріди, IG — каруселі в TG» → плейбук на затвердження: секції обох ресурсів, лише доступні формати',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    await resetAgents(ctx.pool, [NET]);
    const { ig } = await network(ctx.pool, NET, 'legacy_duplicate');
    await createCard(ctx.pool, SPACE_CARD(NET));
    await ctx.stack.registrySync.run();
    const card = (await ctx.stack.channels.get(NET))!;
    const brief = 'Telegram — головний: новини космосу і лонгріди. Instagram — каруселі з фактами, які ведуть у Telegram, 1–2 на день. Без астрології.';
    const res = await ctx.stack.network.runPlaybookBuild(card, brief);
    const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${NET}`))!;
    const pb = await ctx.stack.networkRepo.pendingPlaybook(orch.id);
    const body = pb ? PlaybookSchema.safeParse(pb.body) : null;
    const tg = pb?.body.platforms.find((s) => s.resource_ref === `telegram:${NET}`);
    const igs = pb?.body.platforms.find((s) => s.resource_ref === ig);
    return {
      runId: res?.runId ?? null, status: res?.status ?? 'none', terminalTool: res?.terminalTool, post: pb ? JSON.stringify(pb.body).slice(0, 1500) : '',
      ...(await trace(ctx, res?.runId ?? null)),
      checks: [
        check('submitted a playbook', res?.terminalTool === 'submit_playbook', `${res?.status} ${res?.error ?? ''}`),
        check('first version waits for the owner', pb?.status === 'pending_owner', pb?.status),
        check('valid playbook', !!body?.success),
        check('Telegram section is core', tg?.role === 'core', tg?.role),
        check('Instagram section exists with Instagram formats only', !!igs && Object.keys(igs.formats).every((f) => f.startsWith('ig_')), JSON.stringify(igs?.formats)),
        check('Instagram ≤ 2 per day (brief)', !!igs && igs.per_day.max <= 2, JSON.stringify(igs?.per_day), true),
        check('Instagram funnels to Telegram', !!igs && igs.role.startsWith('funnel_to:telegram:'), igs?.role, true),
        check('owner rule carried over', (pb?.body.rules ?? []).some((r) => /астролог/i.test(r)), JSON.stringify(pb?.body.rules), true),
        check('rationale in Ukrainian', !!pb?.rationale && isUkrainian(pb.rationale)),
      ],
    };
  },
};

// ── A4: idea reviewer ───────────────────────────────────────────────────────

const IDEAS = '@eval_ideas';
const ideaWeb = () => new FakeWeb({
  'https://ideas.example/jwst-trappist': article({
    title: 'JWST measures the atmosphere of TRAPPIST-1 b', image: 'https://ideas.example/img/trappist.jpg',
    paragraphs: [
      'The James Webb Space Telescope measured thermal emission from TRAPPIST-1 b, the innermost of seven Earth-size planets orbiting a red dwarf 40 light-years away.',
      'The dayside temperature of about 230 °C suggests the planet has no thick atmosphere that would carry heat to its night side.',
      'Red dwarfs flare often, and astronomers want to know whether any of the TRAPPIST-1 planets can keep an atmosphere; the outer planets e, f and g lie in the habitable zone.',
    ],
  }),
});
export const ideaReview: EvalCase = {
  id: 'idea-review', role: 'idea_reviewer', channel: IDEAS,
  title: 'Рецензент ідей: дубль нещодавнього поста і ідея без джерел → reject; перевірювана нова ідея → accept',
  web: ideaWeb,
  async execute(ctx) {
    await resetAgents(ctx.pool, [IDEAS]);
    await ownChannel(ctx.pool, IDEAS, 'Космос щодня');
    await createCard(ctx.pool, SPACE_CARD(IDEAS));
    await seedPosts(ctx.pool, IDEAS, [{ daysAgo: 2, hour: 12, format: 'longread', title: 'Кільця Сатурна зникнуть через 300 мільйонів років', views: 2400 }], ctx.now);
    await ctx.stack.registrySync.run();
    const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${IDEAS}`))!;
    const exp = new Date(ctx.now.getTime() + 3 * 86_400_000);
    const v = [{ resource_ref: `telegram:${IDEAS}`, format: 'longread' }];
    const dup = await ctx.stack.networkRepo.addIdea({ agentId: orch.id, title: 'Кільця Сатурна зникнуть через 300 млн років', angle: 'чому кільця тоншають', sources: ['https://nasa.gov/saturn-rings'], variants: v, why: 'Сатурн популярний', origin: 'orchestrator', expiresAt: exp });
    const unsourced = await ctx.stack.networkRepo.addIdea({ agentId: orch.id, title: 'Інопланетяни вже серед нас: 7 доказів', angle: 'сенсаційно', sources: [], variants: v, why: 'кліки', origin: 'orchestrator', expiresAt: exp });
    const good = await ctx.stack.networkRepo.addIdea({ agentId: orch.id, title: 'Webb не знайшов атмосфери у TRAPPIST-1 b', angle: 'що це означає для пошуку життя', sources: ['https://ideas.example/jwst-trappist'], variants: v, why: 'нова новина, висока цікавість', origin: 'orchestrator', expiresAt: exp });
    const card = (await ctx.stack.channels.get(IDEAS))!;
    const res = await ctx.stack.network.runIdeaReview(card);
    const st = async (id: string) => (await ctx.stack.networkRepo.idea(id))!;
    const [a, b, c] = [await st(dup.id), await st(unsourced.id), await st(good.id)];
    return {
      runId: res?.runId ?? null, status: res?.status ?? 'none', terminalTool: res?.terminalTool, ...(await trace(ctx, res?.runId ?? null)),
      post: [a, b, c].map((x) => `${x.title}: ${x.status} — ${x.review?.comment ?? ''}`).join('\n'),
      checks: [
        check('duplicate rejected', a.status === 'rejected', `${a.status} ${a.review?.comment ?? ''}`),
        check('duplicate reason code', a.review?.reason_code === 'duplicate', a.review?.reason_code, true),
        check('unsourced sensational idea rejected', b.status === 'rejected', `${b.status} ${b.review?.comment ?? ''}`),
        check('verifiable new idea accepted', c.status === 'accepted', `${c.status} ${c.review?.comment ?? ''}`),
        check('finished the review', res?.terminalTool === 'finish_idea_review', res?.status, true),
      ],
    };
  },
};

// ── A5 + A6: network day plan and a native Instagram post ───────────────────

const NP = '@eval_np';
async function orchestratedNetwork(ctx: CaseCtx) {
  await resetAgents(ctx.pool, [NP]);
  const { ig, groupId } = await network(ctx.pool, NP, 'independent');
  await createCard(ctx.pool, { ...SPACE_CARD(NP), postsPerDayMin: 1, postsPerDayMax: 3 });
  await ctx.stack.registrySync.run();
  const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${NP}`))!;
  await ctx.stack.networkRepo.insertPlaybook({
    agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'eval',
    body: PlaybookSchema.parse({
      platforms: [
        { resource_ref: `telegram:${NP}`, role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 1, max: 3 }, best_hours: [12, 19] },
        { resource_ref: ig, role: `funnel_to:telegram:${NP}`, formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, best_hours: [14, 20], hashtag_policy: { vocab: ['космос', 'астрономія', 'наука'], min: 3, max: 5 }, cta: 'Більше — у Telegram, посилання в біо' },
      ],
    }),
  });
  const idea = await ctx.stack.networkRepo.addIdea({
    agentId: orch.id, title: 'Webb не знайшов атмосфери у TRAPPIST-1 b', angle: 'що це означає для пошуку життя біля червоних карликів',
    sources: ['https://ideas.example/jwst-trappist'], why: 'свіжа новина JWST', origin: 'orchestrator', expiresAt: new Date(ctx.now.getTime() + 3 * 86_400_000), status: 'accepted',
    variants: [{ resource_ref: `telegram:${NP}`, format: 'longread' }, { resource_ref: ig, format: 'ig_carousel', note: '6 слайдів з фактами' }],
  });
  return { ig, groupId, orch, idea, card: (await ctx.stack.channels.get(NP))! };
}

export const networkPlanStaggered: EvalCase = {
  id: 'network-plan-staggered', role: 'planner', channel: NP,
  title: 'План мережі: прийнята ідея → рішення на кожен ресурс (TG і IG) з причиною (spec 024)',
  web: ideaWeb,
  async execute(ctx) {
    const { ig, idea, card } = await orchestratedNetwork(ctx);
    const res = await ctx.stack.runner.runPlanner(card);
    const day = localDate(ctx.now, KYIV);
    const { rows } = await ctx.pool.query(
      `SELECT s.resource_ref, s.scheduled_at, s.format, s.idea_id FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE p.channel_key = $1 AND p.plan_date = $2 AND p.status = 'active' ORDER BY s.scheduled_at`, [NP, day]);
    const forIdea = rows.filter((r) => r.idea_id === idea.id);
    const tg = forIdea.find((r) => !r.resource_ref);
    const igSlot = forIdea.find((r) => r.resource_ref === ig);
    const { rows: decisions } = await ctx.pool.query(`SELECT resource_ref, decision, reason FROM content_decisions WHERE idea_id = $1`, [idea.id]);
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, ...(await trace(ctx, res.runId)),
      post: rows.map((r) => `${new Date(r.scheduled_at).toISOString().slice(11, 16)} ${r.resource_ref ?? 'telegram'} ${r.format} ${r.idea_id ? '(idea)' : ''}`).join('\n'),
      checks: [
        check('submitted a network plan', res.terminalTool === 'submit_network_plan', `${res.status} ${res.error ?? ''}`),
        check('the idea is planned somewhere', !!tg || !!igSlot),
        check('one decision per resource (TG and IG)', decisions.length === 2 && new Set(decisions.map((d) => d.resource_ref)).size === 2, decisions.map((d) => `${d.resource_ref}:${d.decision}`).join(', ')),
        check('every decision has a reason', decisions.every((d) => String(d.reason ?? '').length >= 10)),
        check('an Instagram slot uses an Instagram format', !igSlot || String(igSlot.format).startsWith('ig_'), igSlot?.format),
        check('idea marked planned', (await ctx.stack.networkRepo.idea(idea.id))!.status === 'planned'),
      ],
    };
  },
};

export const platformNativeVariant: EvalCase = {
  id: 'platform-native-variant', role: 'executor', channel: NP,
  title: 'Виконавець Instagram: нативна карусель зі слайдами, хештеги зі словника, без посилань у підписі — у shadow',
  web: ideaWeb,
  async execute(ctx) {
    const { ig, idea, card } = await orchestratedNetwork(ctx);
    const planId = await ctx.stack.plans.createNetworkPlan(NP, localDate(ctx.now, KYIV), 'eval', null, [
      { resourceRef: ig, scheduledAt: new Date(ctx.now.getTime() - 60_000), format: 'ig_carousel', topic: idea.title, angle: idea.angle, ideaId: idea.id, sourceHints: ['https://ideas.example/jwst-trappist'] },
    ]);
    const { rows } = await ctx.pool.query(`UPDATE editor_slots SET status = 'running', attempts = 1 WHERE plan_id = $1 RETURNING id`, [planId]);
    const slot = (await ctx.stack.plans.getSlot(rows[0].id))!;
    const res = await ctx.stack.runner.runExecutor(slot, card);
    const post = (await ctx.stack.platformPosts.recent(ig, 1))[0];
    const spec = (await ctx.pool.query(`SELECT spec FROM platform_posts WHERE id = $1`, [post?.id ?? 0])).rows[0]?.spec;
    const tags = (post?.caption ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [];
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, post: post?.caption ?? '', ...(await trace(ctx, res.runId)),
      checks: [
        check('published natively (shadow)', res.terminalTool === 'publish_platform_post' && post?.status === 'shadowed', `${res.status} ${res.error ?? ''}`),
        check('slot shadowed', (await ctx.stack.plans.getSlot(slot.id))!.status === 'shadowed'),
        check('a carousel with 2–10 slides', Array.isArray(spec?.slides) && spec.slides.length >= 2 && spec.slides.length <= 10, `${spec?.slides?.length}`),
        check('no URL in the Instagram caption', !/https?:\/\//.test(post?.caption ?? '')),
        check('3–5 hashtags', tags.length >= 3 && tags.length <= 5, tags.join(' '), true),
        check('caption in Ukrainian', isUkrainian(post?.caption ?? '')),
        check('read the source', (await trace(ctx, res.runId)).toolsUsed.includes('web_fetch'), undefined, true),
        check('nothing published to Telegram', ctx.stack.sent.length === 0),
        check('not a Telegram-style copy of the idea title', similarity(post?.caption ?? '', idea.title) < 0.8, undefined, true),
      ],
    };
  },
};

// ── spec 024 T8: agent-owned formatting per resource ──────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}/u;
export const executorFormatPrefs: EvalCase = {
  id: 'executor-format-prefs', role: 'executor', channel: NP,
  title: 'Дубль одного поста на два ресурси з різними format_prefs → по-різному оформлені пости (spec 024 T8)',
  web: ideaWeb,
  async execute(ctx) {
    const { ig, groupId, card } = await orchestratedNetwork(ctx);
    const th = `threads:${(await ctx.pool.query(
      `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, group_id, last_verified_at)
       VALUES ('threads', 'eval-th', 'EVAL_NONE', 'eval-target', 'space_daily_th', $1, now()) RETURNING id`, [groupId])).rows[0].id}`;
    await ctx.stack.profiles.patchFormat(ig, { emoji: 'none', hashtags: { count: 5, fixed: ['космос'] }, links: 'bio', length: { target: 400, max: 800 } }, { by: 'owner', replace: true });
    await ctx.stack.profiles.patchFormat(th, { emoji: 'rich', hashtags: { count: 0, fixed: [] }, length: { target: 180, max: 300 }, tone: 'розмовний, з питанням наприкінці' }, { by: 'owner', replace: true });
    const day = localDate(ctx.now, KYIV);
    const at = new Date(ctx.now.getTime() - 60_000);
    const base = { scheduledAt: at, angle: null, ideaId: null, sourceHints: [] };
    const planId = await ctx.stack.plans.createNetworkPlan(NP, day, 'eval', null, [
      { ...base, resourceRef: `telegram:${NP}`, format: 'photo', topic: 'Webb і TRAPPIST-1 b', treatment: 'unique' },
      { ...base, resourceRef: ig, format: 'ig_photo', topic: 'Webb і TRAPPIST-1 b', treatment: 'duplicate', fromIndex: 0, treatmentReason: 'Та сама аудиторія, фото пасує' },
      { ...base, resourceRef: th, format: 'th_text', topic: 'Webb і TRAPPIST-1 b', treatment: 'duplicate', fromIndex: 0, treatmentReason: 'Коротка новина для Threads' },
    ]);
    const slots = await ctx.stack.plans.listSlots(NP, planId);
    const src = slots.find((s) => !s.resourceRef)!;
    await ctx.stack.plans.updateSlot(src.id, { status: 'shadowed', postSpec: {
      format: 'photo', title: 'Webb не знайшов атмосфери у TRAPPIST-1 b', origin: 'external',
      body: [{ type: 'lead', text: 'Webb не знайшов атмосфери у TRAPPIST-1 b' }, { type: 'p', text: 'Інфрачервоні виміри показують голу скелясту планету: тепло з денного боку не розходиться. Для пошуку життя біля червоних карликів це поганий знак, але не вирок.' }],
      media: [{ url: 'https://ideas.example/trappist.jpg' }], placement: 'above', hashtags: ['космос', 'webb'], buttons: [],
      source: { url: 'https://ideas.example/jwst-trappist', label: 'NASA' },
    } });
    const out: Record<string, { caption: string; runId: string | null }> = {};
    for (const ref of [ig, th]) {
      const s = slots.find((x) => x.resourceRef === ref)!;
      await ctx.pool.query(`UPDATE editor_slots SET status = 'running', attempts = 1 WHERE id = $1`, [s.id]);
      const res = await ctx.stack.runner.runExecutor({ ...s, status: 'running' }, card);
      out[ref] = { caption: (await ctx.stack.platformPosts.recent(ref, 1))[0]?.caption ?? '', runId: res.runId };
    }
    const tags = (c: string) => (c.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
    const a = out[ig].caption;
    const b = out[th].caption;
    return {
      runId: out[ig].runId, status: 'ok', post: `IG:\n${a}\n\nThreads:\n${b}`,
      checks: [
        check('both duplicates written (shadow)', !!a && !!b),
        check('Instagram: no emoji (format_prefs emoji=none)', !EMOJI_RE.test(a), a.slice(0, 80)),
        check('Instagram: 4–6 hashtags incl. #космос', tags(a) >= 4 && tags(a) <= 6 && /#космос/i.test(a), String(tags(a)), true),
        check('Instagram: no raw link in the caption', !/https?:\/\//.test(a)),
        check('Threads: emoji used (emoji=rich)', EMOJI_RE.test(b), b.slice(0, 80), true),
        check('Threads: no hashtags (count 0)', tags(b) === 0, String(tags(b))),
        check('Threads: ≤ 300 characters', b.length <= 300, String(b.length)),
        check('the two posts are formatted differently', similarity(a, b) < 0.8),
        check('one short run per duplicate', (await stepsOf(ctx.pool, out[ig].runId)).length <= 12 && (await stepsOf(ctx.pool, out[th].runId)).length <= 12),
      ],
    };
  },
};

// ── spec 024 T7: per-resource decisions ───────────────────────────────────

/** Another member of a network group (one account per platform per group). Returns its resource ref. */
async function member(pool: Pool, groupId: string, platform: 'instagram' | 'threads' | 'facebook', accountId: string, username: string): Promise<string> {
  const id = (await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id, username, display_name, group_id, last_verified_at)
     VALUES ($1, $2, 'EVAL_NONE', 'eval-target', $3, $3, $4, now()) RETURNING id`, [platform, accountId, username, groupId])).rows[0].id;
  return `${platform}:${id}`;
}

const profile = (p: { topic: string; who: string; goals: string[]; taboo?: string[]; tone?: string }) => ResourceProfileSchema.parse({
  topic: p.topic, audience: { who: p.who }, language: 'uk', goals: p.goals, taboo: p.taboo ?? [], tone: p.tone,
});

/** A reason names a profile, playbook or KPI signal (FR-012), not "it is better". */
const SIGNAL = /(профіл|аудитор|молод|студент|старш|45\+|обговор|розмов|плейбук|секці|формат|карусел|лонгрід|частот|per_day|ліміт|KPI|охоплен|перегляд|реакці|залучен|переход|growth|engagement|transitions|ціль|цілі|тем[аиуі]|табу|коротк|довг)/iu;

async function decisionsOf(pool: Pool, ideaId: string) {
  const { rows } = await pool.query(`SELECT resource_ref, decision, reason, reason_code, slot_id FROM content_decisions WHERE idea_id = $1 ORDER BY resource_ref`, [ideaId]);
  return rows as Array<{ resource_ref: string; decision: string; reason: string; reason_code: string | null; slot_id: string | null }>;
}

const MD = '@eval_md';
export const plannerMixedDecisions: EvalCase = {
  id: 'planner-mixed-decisions', role: 'planner', channel: MD,
  title: 'Мережа з 4 ресурсів з різними профілями → щонайменше 2 різні рішення, кожна причина називає сигнал профілю / плейбука / KPI (spec 024)',
  web: ideaWeb,
  async execute(ctx) {
    await resetAgents(ctx.pool, [MD]);
    const { groupId, ig } = await network(ctx.pool, MD, 'independent');
    const th = await member(ctx.pool, groupId, 'threads', 'eval-md-th', 'space_talks');
    const fb = await member(ctx.pool, groupId, 'facebook', 'eval-md-fb', 'space_news_fb');
    await createCard(ctx.pool, { ...SPACE_CARD(MD), postsPerDayMin: 1, postsPerDayMax: 3 });
    await ctx.stack.registrySync.run();
    const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${MD}`))!;
    await ctx.stack.profiles.setProfile(ig, profile({ topic: 'Космос у картинках: факти-каруселі', who: 'студенти й молодь 16–24, гортають стрічку', goals: ['growth'] }), 'owner');
    await ctx.stack.profiles.setProfile(th, profile({ topic: 'Короткі розмови про науку й новини космосу', who: 'дорослі 25–35, що люблять обговорення', goals: ['engagement'], tone: 'розмовний, коротко' }), 'owner');
    await ctx.stack.profiles.setProfile(fb, profile({ topic: 'Новини науки для старшої аудиторії', who: 'читачі 45+, люблять докладні тексти', goals: ['transitions'], taboo: ['меми', 'сленг'] }), 'owner');
    await ctx.stack.networkRepo.insertPlaybook({
      agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'eval',
      body: PlaybookSchema.parse({
        platforms: [
          { resource_ref: `telegram:${MD}`, role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 1, max: 3 }, best_hours: [12, 19] },
          { resource_ref: ig, role: 'discovery', formats: { ig_carousel: 1 }, per_day: { min: 0, max: 2 }, best_hours: [14, 20], hashtag_policy: { vocab: ['космос', 'наука'], min: 3, max: 5 } },
          { resource_ref: th, role: 'community', formats: { th_text: 1 }, per_day: { min: 0, max: 3 }, best_hours: [13, 21] },
          { resource_ref: fb, role: `funnel_to:telegram:${MD}`, formats: { fb_text: 0.5, fb_photo: 0.5 }, per_day: { min: 0, max: 1 }, best_hours: [18] },
        ],
      }),
    });
    const idea = await ctx.stack.networkRepo.addIdea({
      agentId: orch.id, title: 'Webb не знайшов атмосфери у TRAPPIST-1 b', angle: 'що це означає для пошуку життя біля червоних карликів',
      sources: ['https://ideas.example/jwst-trappist'], why: 'свіжа новина JWST', origin: 'orchestrator', expiresAt: new Date(ctx.now.getTime() + 3 * 86_400_000), status: 'accepted',
      variants: [{ resource_ref: `telegram:${MD}`, format: 'longread' }, { resource_ref: ig, format: 'ig_carousel' }],
    });
    const card = (await ctx.stack.channels.get(MD))!;
    const res = await ctx.stack.runner.runPlanner(card);
    const decisions = await decisionsOf(ctx.pool, idea.id);
    const { rows: slots } = await ctx.pool.query(
      `SELECT s.id, s.resource_ref, s.treatment, s.derived_from_slot_id, src.treatment AS src_treatment, src.idea_id AS src_idea
         FROM editor_slots s LEFT JOIN editor_slots src ON src.id = s.derived_from_slot_id WHERE s.idea_id = $1`, [idea.id]);
    const derived = slots.filter((x) => x.treatment === 'duplicate' || x.treatment === 'adapt');
    const kinds = new Set(decisions.map((d) => d.decision));
    const fbSlot = slots.find((x) => x.resource_ref === fb);
    const igSlot = slots.find((x) => x.resource_ref === ig);
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, ...(await trace(ctx, res.runId)),
      post: decisions.map((d) => `${d.resource_ref} ${d.decision}${d.reason_code ? ` [${d.reason_code}]` : ''}: ${d.reason}`).join('\n'),
      checks: [
        check('submitted a network plan', res.terminalTool === 'submit_network_plan', `${res.status} ${res.error ?? ''}`),
        check('one decision per resource (4)', decisions.length === 4 && new Set(decisions.map((d) => d.resource_ref)).size === 4, decisions.map((d) => `${d.resource_ref}:${d.decision}`).join(', ')),
        check('at least two distinct treatments', kinds.size >= 2, [...kinds].join(', ')),
        check('every reason cites a profile / playbook / KPI signal', decisions.length > 0 && decisions.every((d) => d.reason.length >= 10 && SIGNAL.test(d.reason)),
          decisions.filter((d) => !SIGNAL.test(d.reason)).map((d) => d.reason).join(' | ')),
        check('duplicate / adapt slots point at a unique source of the same idea', derived.every((x) => x.derived_from_slot_id && x.src_treatment === 'unique' && x.src_idea === idea.id),
          derived.map((x) => `${x.resource_ref}:${x.treatment}←${x.src_treatment}`).join(', ')),
        check('Facebook (45+) does not get the student carousel duplicated as is', !(fbSlot?.treatment === 'duplicate' && igSlot && fbSlot.derived_from_slot_id === igSlot.id), undefined, true),
      ],
    };
  },
};

const SKIP = '@eval_skip';
const recipeWeb = () => new FakeWeb({
  'https://ideas.example/borshch': article({
    title: 'Borscht with roasted beets', image: 'https://ideas.example/img/borshch.jpg',
    paragraphs: [
      'Roasting the beets for 50 minutes at 200 °C before they go into the pot keeps the colour deep red and adds a sweet note.',
      'For six portions you need 2 litres of broth, 3 beets, half a cabbage, 3 potatoes, a carrot, an onion and 2 tablespoons of tomato paste.',
      'Add a spoon of vinegar at the end and let the borscht rest for 20 minutes before serving.',
    ],
  }),
});
export const plannerSkipOfftopic: EvalCase = {
  id: 'planner-skip-offtopic', role: 'planner', channel: SKIP,
  title: 'Рецепт → Telegram-канал рецептів отримує пост, а Instagram, у профілі якого їжа під табу, — skip з причиною (spec 024)',
  web: recipeWeb,
  async execute(ctx) {
    await resetAgents(ctx.pool, [SKIP]);
    const { ig } = await network(ctx.pool, SKIP, 'independent');
    await createCard(ctx.pool, {
      channelKey: SKIP, title: 'Смачно вдома', brief: 'Рецепти домашньої кухні: прості страви на щодень.',
      formats: { photo: 0.6, longread: 0.4 }, hashtags: ['рецепти', 'кухня'], postsPerDayMin: 1, postsPerDayMax: 3,
    });
    await ctx.stack.registrySync.run();
    const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${SKIP}`))!;
    await ctx.stack.profiles.setProfile(ig, profile({
      topic: 'Домашні тренування і фітнес: вправи, техніка, мотивація', who: 'жінки 25–40, тренуються вдома', goals: ['growth', 'engagement'],
      taboo: ['їжа', 'рецепти', 'кулінарія', 'дієти'],
    }), 'owner');
    await ctx.stack.networkRepo.insertPlaybook({
      agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'eval',
      body: PlaybookSchema.parse({
        platforms: [
          { resource_ref: `telegram:${SKIP}`, role: 'core', formats: { photo: 0.6, longread: 0.4 }, per_day: { min: 1, max: 3 }, best_hours: [12, 18] },
          { resource_ref: ig, role: 'discovery', formats: { ig_photo: 0.5, ig_carousel: 0.5 }, per_day: { min: 0, max: 2 }, best_hours: [9, 19], hashtag_policy: { vocab: ['фітнес', 'тренування'], min: 3, max: 5 } },
        ],
      }),
    });
    const idea = await ctx.stack.networkRepo.addIdea({
      agentId: orch.id, title: 'Борщ із печеними буряками: рецепт на 6 порцій', angle: 'печені буряки — глибокий колір і солодкість',
      sources: ['https://ideas.example/borshch'], why: 'сезон буряків, рецепти супів добре заходять', origin: 'orchestrator',
      expiresAt: new Date(ctx.now.getTime() + 3 * 86_400_000), status: 'accepted',
      // The variant tempts the planner to post it on Instagram too; it is a hint, not a requirement.
      variants: [{ resource_ref: `telegram:${SKIP}`, format: 'photo' }, { resource_ref: ig, format: 'ig_photo', note: 'фото борщу' }],
    });
    const card = (await ctx.stack.channels.get(SKIP))!;
    const res = await ctx.stack.runner.runPlanner(card);
    const decisions = await decisionsOf(ctx.pool, idea.id);
    const igDecision = decisions.find((d) => d.resource_ref === ig);
    const tgDecision = decisions.find((d) => d.resource_ref === `telegram:${SKIP}`);
    const { rows: igSlots } = await ctx.pool.query(`SELECT id FROM editor_slots WHERE idea_id = $1 AND resource_ref = $2`, [idea.id, ig]);
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, ...(await trace(ctx, res.runId)),
      post: decisions.map((d) => `${d.resource_ref} ${d.decision}${d.reason_code ? ` [${d.reason_code}]` : ''}: ${d.reason}`).join('\n'),
      checks: [
        check('submitted a network plan', res.terminalTool === 'submit_network_plan', `${res.status} ${res.error ?? ''}`),
        check('Instagram (fitness, food is taboo) is skipped', igDecision?.decision === 'skip', igDecision ? `${igDecision.decision}: ${igDecision.reason}` : 'no decision'),
        check('no Instagram slot for the recipe', igSlots.length === 0, String(igSlots.length)),
        check('the skip reason names the profile', !!igDecision && /(профіл|табу|фітнес|тренуван|їж|кулінар|рецепт|тем[аиуі]|аудитор)/iu.test(igDecision.reason), igDecision?.reason),
        check('reason code off_topic', igDecision?.reason_code === 'off_topic', igDecision?.reason_code ?? 'none', true),
        check('Telegram (recipes) gets the recipe as a unique post', tgDecision?.decision === 'unique' && !!tgDecision.slot_id, tgDecision ? `${tgDecision.decision}` : 'no decision'),
      ],
    };
  },
};

const RP = '@eval_rp';
export const orchestratorRepurposeHit: EvalCase = {
  id: 'orchestrator-repurpose-hit', role: 'orchestrator', channel: RP,
  title: 'Пост Telegram із верхніх 10 % за переглядами (вчора) → repurpose_post duplicate у Threads (spec 024)',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    await resetAgents(ctx.pool, [RP]);
    const groupId = (await ctx.pool.query(`INSERT INTO meta_account_groups (name, source_platform, mode) VALUES ($1, 'telegram', 'independent') RETURNING id`, [GROUP])).rows[0].id;
    await ownChannel(ctx.pool, RP, 'Космос щодня', groupId);
    const th = await member(ctx.pool, groupId, 'threads', 'eval-rp-th', 'space_daily_th');
    await createCard(ctx.pool, { ...SPACE_CARD(RP), postsPerDayMin: 1, postsPerDayMax: 3 });
    await ctx.stack.registrySync.run();
    const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${RP}`))!;
    await ctx.stack.profiles.setProfile(th, profile({ topic: 'Короткі новини космосу для обговорення', who: 'дорослі 20–35, що читають новини науки', goals: ['engagement', 'transitions'] }), 'owner');
    await ctx.stack.networkRepo.insertPlaybook({
      agentId: orch.id, status: 'active', brief: null, createdBy: 'owner', rationale: 'eval',
      body: PlaybookSchema.parse({
        platforms: [
          { resource_ref: `telegram:${RP}`, role: 'core', formats: { photo: 0.6, longread: 0.4 }, per_day: { min: 1, max: 3 }, best_hours: [10, 19] },
          { resource_ref: th, role: `funnel_to:telegram:${RP}`, formats: { th_text: 1 }, per_day: { min: 0, max: 3 }, best_hours: [13, 21] },
        ],
      }),
    });
    // 30 ordinary posts around 1,000 views and yesterday's hit with 4,200 — the top decile, within 72 h.
    const posts: PostSeed[] = [];
    for (let d = 2; d <= 31; d++) posts.push({ daysAgo: d, hour: 12, format: d % 3 ? 'photo' : 'longread', title: `Новина космосу ${d}`, views: 950 + Math.round(Math.sin(d * 2.3) * 80), forwards: 4, reactions: 18 });
    const HIT = 'Webb знайшов ознаки водяної пари на K2-18 b';
    posts.push({ daysAgo: 1, hour: 10, format: 'photo', title: HIT, views: 4200, forwards: 60, reactions: 310, tags: ['космос', 'webb'] });
    await seedPosts(ctx.pool, RP, posts, ctx.now);
    const hit = (await ctx.pool.query(`SELECT id FROM published_posts WHERE channel_id = $1 AND title = $2`, [RP, HIT])).rows[0].id as number;
    const startedAt = new Date();
    const card = (await ctx.stack.channels.get(RP))!;
    const res = await ctx.stack.network.runOrchestrator(card);
    const t = await trace(ctx, res?.runId ?? null);
    const { rows: decisions } = await ctx.pool.query(
      `SELECT resource_ref, decision, reason, source_key, slot_id FROM content_decisions WHERE resource_ref = $1 AND created_at >= $2`, [th, startedAt]);
    const fromHit = decisions.filter((d) => d.source_key === `tg:${hit}`);
    const { rows: slots } = await ctx.pool.query(
      `SELECT s.id, s.treatment FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE p.channel_key = $1 AND s.resource_ref = $2 AND s.treatment IS NOT NULL`, [RP, th]);
    return {
      runId: res?.runId ?? null, status: res?.status ?? 'none', terminalTool: res?.terminalTool, ...t,
      post: decisions.map((d) => `${d.source_key ?? d.slot_id} → ${d.resource_ref} ${d.decision}: ${d.reason}`).join('\n'),
      checks: [
        check('called repurpose_post', t.toolsUsed.includes('repurpose_post'), t.toolsUsed.join(', ')),
        check('the top-decile post is the source', fromHit.length >= 1, decisions.map((d) => d.source_key).join(', ') || 'no decisions'),
        check('duplicate to Threads', fromHit.some((d) => d.decision === 'duplicate'), fromHit.map((d) => d.decision).join(', ')),
        check('a derived Threads slot is planned', slots.some((x) => x.treatment === 'duplicate'), slots.map((x) => x.treatment).join(', ')),
        check('the reason cites the KPI', fromHit.some((d) => /(перегляд|охоплен|KPI|топ|найкращ|реакці|репост|4\s?200|×|разів|вище)/iu.test(d.reason)), fromHit.map((d) => d.reason).join(' | '), true),
        check('ordinary posts are not repurposed', decisions.every((d) => d.source_key === `tg:${hit}`), decisions.map((d) => d.source_key).join(', '), true),
        check('no tool errors', t.toolErrors.length === 0, t.toolErrors.join(' | '), true),
      ],
    };
  },
};

// ── A7 + A8: MANAGER ───────────────────────────────────────────────────────

const MGR = '@eval_mgr';
async function managerSetup(ctx: CaseCtx, drop: boolean) {
  await resetAgents(ctx.pool, [MGR, EXPLAIN, NET, IDEAS, NP, TRAVEL]);
  await ownChannel(ctx.pool, MGR, 'Космос щодня');
  await createCard(ctx.pool, { ...SPACE_CARD(MGR), mode: 'live' });
  const posts: PostSeed[] = [];
  for (let d = 2; d <= 35; d++) {
    const noise = Math.round(Math.sin(d * 3.7) * 60);
    posts.push({ daysAgo: d, hour: 12, format: d % 3 ? 'photo' : 'longread', title: `Пост ${d}`, views: (drop && d <= 8 ? 520 : 1000) + noise, forwards: 5, reactions: 20 });
  }
  await seedPosts(ctx.pool, MGR, posts, ctx.now);
  await ctx.stack.registrySync.run();
  await ctx.pool.query(`UPDATE agents SET mode = 'live' WHERE scope_id = $1 AND parent_id IS NULL`, [`telegram:${MGR}`]);
  const m = (await ctx.stack.agents.findTop('manager', 'system', null))!;
  await ctx.pool.query(`UPDATE agents SET mode = 'live' WHERE id = $1`, [m.id]);
  return { ...m, mode: 'live' as const };
}
async function managerAfter(ctx: CaseCtx, m: { id: string }) {
  await ctx.pool.query(`UPDATE agents SET mode = 'off' WHERE id = $1`, [m.id]);
}

export const managerStableContinue: EvalCase = {
  id: 'manager-stable-continue', role: 'manager', channel: MGR,
  title: 'MANAGER: стабільна мережа → «продовжуйте» без директив',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const m = await managerSetup(ctx, false);
    const res: any = await ctx.stack.manager.run(m);
    const { rows: rev } = await ctx.pool.query(`SELECT verdict, summary FROM manager_reviews ORDER BY created_at DESC LIMIT 1`);
    const dirs = await ctx.stack.directives.list({ limit: 20 });
    await managerAfter(ctx, m);
    return {
      runId: res.runId ?? null, status: res.status ?? res.skipped, terminalTool: res.terminalTool, post: rev[0]?.summary ?? '', ...(await trace(ctx, res.runId ?? null)),
      checks: [
        check('verdict continue', rev[0]?.verdict === 'continue', rev[0]?.verdict),
        check('no directives filed', dirs.filter((x) => x.createdAt.getTime() > Date.now() - 600_000).length === 0, `${dirs.length}`),
        check('summary in Ukrainian', isUkrainian(rev[0]?.summary ?? '')),
      ],
    };
  },
};

export const managerDropDirective: EvalCase = {
  id: 'manager-drop-directive', role: 'manager', channel: MGR,
  title: 'MANAGER: перегляди на пост упали на ~50% → директива оркестратору з цифрами й очікуваним ефектом',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const m = await managerSetup(ctx, true);
    const res: any = await ctx.stack.manager.run(m);
    const { rows: rev } = await ctx.pool.query(`SELECT verdict, summary FROM manager_reviews ORDER BY created_at DESC LIMIT 1`);
    const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${MGR}`))!;
    const dirs = await ctx.stack.directives.list({ toAgentId: orch.id, limit: 10 });
    await managerAfter(ctx, m);
    const d = dirs[0];
    return {
      runId: res.runId ?? null, status: res.status ?? res.skipped, terminalTool: res.terminalTool, post: d ? `${d.kind}: ${d.body}\n${d.rationale}` : rev[0]?.summary ?? '',
      ...(await trace(ctx, res.runId ?? null)),
      checks: [
        check('verdict directives', rev[0]?.verdict === 'directives', rev[0]?.verdict),
        check('a directive to the channel orchestrator', dirs.length >= 1 && dirs.length <= 3, `${dirs.length}`),
        check('cites numbers', !!d && JSON.stringify(d.evidence ?? {}).match(/\d/) !== null),
        check('expected effect set (unless advice/task)', !!d && (d.kind === 'advice' || d.kind === 'task' || !!d.expected), d?.kind, true),
        check('rationale in Ukrainian', !!d && isUkrainian(d.rationale)),
      ],
    };
  },
};

/** Leave the scratch DB as found (the runner's real-DB guard counts meta accounts). */
export async function cleanupAgentEvals(pool: Pool): Promise<void> {
  await resetAgents(pool, [TRAVEL, EXPLAIN, NET, IDEAS, NP, MGR, MD, SKIP, RP]);
}

export const AGENT_CASES: EvalCase[] = [
  builderOnboarding, mentionExplain, playbookFromBrief, ideaReview, networkPlanStaggered, platformNativeVariant, executorFormatPrefs,
  plannerMixedDecisions, plannerSkipOfftopic, orchestratorRepurposeHit, managerStableContinue, managerDropDirective,
];
