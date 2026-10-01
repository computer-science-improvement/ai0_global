import type { Pool } from 'pg';
import type { CaseCtx, EvalCase } from '../lib/case';
import { FakeWeb, article } from '../lib/fake-web';
import { check, isUkrainian, stepsOf, toolErrors } from '../lib/graders';
import { createCard, PostSeed, seedPosts } from '../lib/seed';
import { localDate, zonedToUtc } from '../../src/editor/roles/time';
import { validateHandle } from '../../src/editor/agents/agent.types';
import { PlaybookSchema } from '../../src/editor/network/playbook';
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
  await pool.query(`DELETE FROM agent_directives WHERE to_agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM content_ideas WHERE agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM agents WHERE scope_id = ANY($1::text[])`, [refs]);
  await pool.query(`DELETE FROM pending_actions WHERE payload->>'resource_ref' = ANY($1::text[]) OR payload->>'handle' LIKE 'eval%'`, [refs]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = ANY($1::text[]) OR resource_ref LIKE 'instagram:%'`, [refs]);
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

/** A network: Telegram anchor + an Instagram account in one group. Returns the IG resource ref. */
async function network(pool: Pool, key: string, mode: 'mirror' | 'orchestrated'): Promise<{ groupId: string; ig: string }> {
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
    const { ig } = await network(ctx.pool, NET, 'mirror');
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
  const { ig } = await network(ctx.pool, NP, 'orchestrated');
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
  return { ig, orch, idea, card: (await ctx.stack.channels.get(NP))! };
}

export const networkPlanStaggered: EvalCase = {
  id: 'network-plan-staggered', role: 'planner', channel: NP,
  title: 'План мережі: прийнята ідея → нативні варіанти на TG і IG, Telegram першим, ≥ 90 хв між ними',
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
    const gap = tg && igSlot ? (new Date(igSlot.scheduled_at).getTime() - new Date(tg.scheduled_at).getTime()) / 60_000 : null;
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, ...(await trace(ctx, res.runId)),
      post: rows.map((r) => `${new Date(r.scheduled_at).toISOString().slice(11, 16)} ${r.resource_ref ?? 'telegram'} ${r.format} ${r.idea_id ? '(idea)' : ''}`).join('\n'),
      checks: [
        check('submitted a network plan', res.terminalTool === 'submit_network_plan', `${res.status} ${res.error ?? ''}`),
        check('the idea has a Telegram variant', !!tg),
        check('the idea has an Instagram variant', !!igSlot),
        check('Telegram goes first, ≥ 90 min before Instagram', gap != null && gap >= 90, `gap ${gap} min`),
        check('Instagram slot uses ig_carousel', igSlot?.format === 'ig_carousel', igSlot?.format),
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
  await resetAgents(pool, [TRAVEL, EXPLAIN, NET, IDEAS, NP, MGR]);
}

export const AGENT_CASES: EvalCase[] = [
  builderOnboarding, mentionExplain, playbookFromBrief, ideaReview, networkPlanStaggered, platformNativeVariant, managerStableContinue, managerDropDirective,
];
