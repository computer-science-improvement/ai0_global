/**
 * Spec 052 T1: `/launch` parsing, the refusals, the preparation worker (card, references as steering sets, one analysis),
 * the plan checks, redo and discard. The model is scripted (FakeLlm); channels are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { makeCard } from '../post/testing/fixtures';
import type { Agent } from '../agents/agent.types';
import type { EditorCard } from '../card';
import type { SteeringSet } from '../steering/steering.types';
import { parseLaunchArgs, parseSlash, runSlash, type SlashDeps } from '../chat/slash-commands';
import { checkLaunch, SUBMIT_LAUNCH_TOOL, SubmitLaunchInput } from './launch-analysis';
import { launchActions, launchSummary } from './launch-artifact';
import { BOT_RECHECK_MS, LaunchService, REFERENCE_WAIT_MS, type LaunchDeps } from './launch.service';
import { launchSource } from './launch-cards';
import type { LaunchRepository } from './launch.repository';
import type { LaunchBotState } from './launch.types';
import { MemoryLaunchRepo, validLaunch } from './testing/launch-fixtures';

const KEY = '@coffee_home';
const BRIEF = 'Канал про домашню каву для початківців: рецепти, техніка, недороге обладнання, без снобізму.';
const NOW = new Date('2026-10-20T09:00:00Z');

const agent = (): Agent => ({
  id: 'a-coffee', kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${KEY}`, parentId: null, name: 'Coffee', handle: 'coffee_home', emoji: null,
  description: null, mode: 'off', status: 'active', pausedUntil: null, model: null, reasoningEffort: null, schedule: {},
  dailyBudgetUsd: null, shadowUntil: null, createdBy: 'sync', createdAt: NOW, updatedAt: NOW,
});

const set = (id: string, source: string, status: SteeringSet['status'], p: Partial<SteeringSet> = {}): SteeringSet => ({
  id, targetRef: `telegram:${KEY}`, channelKey: KEY, sourceRef: source, sourceTitle: `Title of ${source}`, status, reason: null, retryAt: null,
  posts: [{ key: 'r1', msgId: 1, postedAt: NOW.toISOString(), text: 'Сьогодні варимо еспресо: 18 грамів кави, 36 грамів напою, 28 секунд екстракції і жодних компромісів з помелом', mediaType: null, views: 100, reactions: 3, forwards: 1, comments: 0 }],
  metrics: null, summary: 'Короткі пости з цифрами', rules: [{ id: 's1', kind: 'structure', text: 'Короткі пости з цифрами', enabled: true }] as any,
  runId: null, costUsd: 0.01, createdBy: 'launch', createdAt: NOW, updatedAt: NOW, activatedAt: null, ...p,
});

const NO_BOT: LaunchBotState = { state: 'no_access', detail: '@ai0_bot is not an administrator yet', bot: '@ai0_bot', chatTitle: 'Кава вдома', chatAbout: 'Про каву' };
const BOT_OK: LaunchBotState = { state: 'ok', detail: '@ai0_bot can post', bot: '@ai0_bot', chatTitle: 'Кава вдома', chatAbout: 'Про каву' };

function service(o: {
  turns?: ConstructorParameters<typeof FakeLlm>[0]; card?: EditorCard | null; bot?: LaunchBotState; refuse?: Record<string, string>; now?: () => Date;
  failStep?: 'playbook';
} = {}) {
  const now = o.now ?? (() => NOW);
  const box = { bot: o.bot ?? NO_BOT, tracked: null as { isMine: boolean; subs: number | null } | null, published: 0, ideas: 0 };
  const repo = new MemoryLaunchRepo(now);
  const sets = new Map<string, SteeringSet>();
  const calls: unknown[][] = [];
  let card: EditorCard | null = o.card === undefined ? null : o.card;
  const llm = new FakeLlm(o.turns ?? []);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const d: LaunchDeps = {
    repo: repo as unknown as LaunchRepository,
    card: async () => card,
    prepareChannel: async (key, title) => { calls.push(['prepare', key, title]); card = card ?? makeCard({ channelKey: key, mode: 'off', title: title ?? key }); return agent(); },
    botCheck: async () => { calls.push(['bot']); return box.bot; },
    steering: {
      createSet: async (body) => {
        calls.push(['steer', body.source]);
        const why = o.refuse?.[body.source.replace(/^telegram:/, '')];
        if (why) return { ok: false, error: 'invalid_source', details: why };
        const s = set(`set-${sets.size + 1}`, `telegram:${body.source.replace(/^telegram:/, '')}`, 'queued');
        sets.set(s.id, s);
        return { ok: true, set: s };
      },
      set: async (id) => sets.get(id) ?? null,
      discard: async (id) => { calls.push(['discard', id]); const s = sets.get(id); if (s) sets.set(id, { ...s, status: 'discarded' }); },
      activate: async (id) => { calls.push(['activate', id]); const s = sets.get(id); if (s) sets.set(id, { ...s, status: 'active' }); },
    },
    network: async () => [{ key: '@tea_home', title: 'Чай вдома', topic: 'Чай' }],
    state: async () => ({ card, agent: agent(), profile: null, locks: [], playbook: null, voice: null }),
    loop,
    model: async () => resolveModel('onboarder', () => undefined),
    tracked: async () => box.tracked,
    trackOwn: async (key) => { calls.push(['trackOwn', key]); box.tracked = { isMine: true, subs: 12 }; },
    published: async () => box.published,
    platforms: async () => [],
    writers: {
      upsertCard: async (key, patch) => { calls.push(['card', key, patch]); },
      setProfile: async () => { calls.push(['profile']); },
      patchFormat: async () => { calls.push(['format']); return null; },
      putPlaybook: async () => { if (o.failStep === 'playbook') throw new Error('playbook_invalid: platforms[0]'); calls.push(['playbook']); },
      putVoiceSkill: async (_h, v) => { calls.push(['voice', v.body]); },
    },
    ideas: { count: async () => box.ideas, add: async (i) => { box.ideas++; calls.push(['idea', i.title, i.originRef, i.variants[0].resource_ref]); } },
    setMode: async (key, mode) => { calls.push(['mode', key, mode]); if (card) card = { ...card, mode }; },
    planAhead: async (key) => { calls.push(['plan', key]); },
    now,
  };
  return { svc: new LaunchService(d), repo, sets, calls, llm, box };
}

const run = async (svc: LaunchService) => { await svc.tick(); await svc.idle(); };

// ── parsing ──────────────────────────────────────────────────────────────────

test('parse: the first handle is the new channel, the handles after it are references, the rest is the brief', () => {
  assert.deepEqual(parseLaunchArgs('@coffee_home @coffee_ref t.me/barista_ua — Канал про каву\nдля початківців'), {
    target: '@coffee_home', references: ['@coffee_ref', 't.me/barista_ua'], brief: 'Канал про каву\nдля початківців',
  });
  assert.deepEqual(parseLaunchArgs('@coffee_home: Канал про каву'), null, 'a colon glued to the handle is not a handle');
  assert.deepEqual(parseLaunchArgs('@coffee_home, @ref_one, Канал'), { target: '@coffee_home', references: ['@ref_one'], brief: 'Канал' });
  assert.equal(parseLaunchArgs('Канал про каву'), null);
  const cmd = parseSlash('/launch @coffee_home Бриф\nз двох рядків')!;
  assert.equal(cmd.name, 'launch');
  assert.equal(cmd.rest, '@coffee_home Бриф\nз двох рядків');
});

test('slash: /launch answers with the launch chip; refusals are one line; an open launch returns its chip', async () => {
  const calls: unknown[] = [];
  const d: SlashDeps = {
    setup: async () => ({ ok: false, error: 'x' }), steer: async () => ({ ok: false, error: 'x' }), list: async () => [],
    launch: async (q) => {
      calls.push(q);
      if (q.target === '@open_one') return { ok: false, error: 'already_open', details: 'x', chip: { type: 'launch', id: 'l0', title: 'Launch · @open_one', status: 'ready' } };
      if (q.brief.length < 30) return { ok: false, error: 'brief_too_short' };
      return { ok: true, chip: { type: 'launch', id: 'l1', title: `Launch · ${q.target}`, status: 'queued' } };
    },
  };
  const ctx = { agent: null, channel: null };
  const ok = await runSlash(parseSlash(`/launch ${KEY} @coffee_ref ${BRIEF}`)!, ctx, d);
  assert.match(ok.content, /Launch of @coffee_home queued\. The reference is read first/);
  assert.deepEqual(ok.artifacts, [{ type: 'launch', id: 'l1', title: 'Launch · @coffee_home', status: 'queued' }]);
  assert.deepEqual(calls[0], { target: KEY, references: ['@coffee_ref'], brief: BRIEF });
  const short = await runSlash(parseSlash(`/launch ${KEY} коротко`)!, ctx, d);
  assert.match(short.content, /at least 30 characters/);
  const open = await runSlash(parseSlash(`/launch @open_one ${BRIEF}`)!, ctx, d);
  assert.equal(open.artifacts[0].id, 'l0');
  const bad = await runSlash(parseSlash('/launch про каву')!, ctx, d);
  assert.match(bad.content, /^Usage: \/launch @new_channel/);
});

// ── create ───────────────────────────────────────────────────────────────────

test('create: refusals are data; a valid launch is queued with its references', async () => {
  const { svc, repo } = service();
  const r = (body: unknown) => svc.createLaunch(body);
  assert.equal((await r({ target: 'not a handle', brief: BRIEF }) as any).error, 'invalid_target');
  assert.equal((await r({ target: KEY, brief: 'коротко' }) as any).error, 'brief_too_short');
  assert.equal((await r({ target: KEY, brief: BRIEF, references: ['t.me/+abc'] }) as any).error, 'invalid_reference');
  assert.equal((await r({ target: KEY, brief: BRIEF, references: ['https://t.me/coffee_home'] }) as any).error, 'same_channel');
  assert.equal((await r({ target: KEY, brief: BRIEF, references: ['@ref_one', '@ref_two', '@ref_three', '@ref_four'] }) as any).error, 'too_many_references');
  const ok = await r({ target: 't.me/coffee_home', brief: BRIEF, references: ['@coffee_ref', 'telegram:@coffee_ref', 't.me/barista_ua'] });
  assert.ok(ok.ok);
  assert.equal(repo.rows[0].channelKey, KEY);
  assert.deepEqual(repo.rows[0].refs.map((x) => x.ref), ['telegram:@coffee_ref', 'telegram:@barista_ua'], 'duplicates collapse');
  const again = await r({ target: KEY, brief: BRIEF });
  assert.equal((again as any).error, 'already_open');
  assert.equal((again as any).launch.id, repo.rows[0].id);
  await svc.idle();
});

test('create: a channel already in approval or live is refused (that is /setup)', async () => {
  const { svc } = service({ card: makeCard({ channelKey: KEY, mode: 'approve' }) });
  const r = await svc.createLaunch({ target: KEY, brief: BRIEF });
  assert.equal((r as any).error, 'already_running');
});

// ── worker ───────────────────────────────────────────────────────────────────

test('worker: card and agent in off with the Telegram title, references as steering sets, then one analysis → ready', async () => {
  const bad = { ...validLaunch(), first_week: { ideas: validLaunch().first_week.ideas.map((x) => ({ ...x, intro: false })) } };
  const { svc, repo, sets, calls, llm } = service({
    turns: [{ calls: [{ name: SUBMIT_LAUNCH_TOOL, args: bad }] }, { calls: [{ name: SUBMIT_LAUNCH_TOOL, args: validLaunch() }] }],
    refuse: { '@private_one': 'This is an invite link' },
  });
  await svc.createLaunch({ target: KEY, brief: BRIEF, references: ['@coffee_ref', '@private_one'] });
  await svc.idle();
  let l = repo.rows[0];
  assert.equal(l.status, 'preparing');
  assert.deepEqual(calls.filter((c) => c[0] === 'prepare'), [['prepare', KEY, 'Кава вдома']]);
  assert.equal(l.title, 'Кава вдома');
  assert.equal(l.botState?.state, 'no_access');
  assert.deepEqual(l.refs.map((r) => [r.ref, r.status]), [['telegram:@coffee_ref', 'queued'], ['telegram:@private_one', 'skipped']]);
  assert.equal(llm.requests.length, 0, 'no analysis while a reference is being read');

  await run(svc);
  assert.equal(repo.rows[0].status, 'preparing', 'still waiting');
  sets.set('set-1', set('set-1', 'telegram:@coffee_ref', 'ready'));
  await run(svc);
  l = repo.rows[0];
  assert.equal(l.status, 'ready', l.reason ?? '');
  assert.equal(SubmitLaunchInput.parse(l.plan).first_week.ideas[0].intro, true);
  assert.equal(llm.requests.length, 2);
  const prompt = JSON.stringify(llm.requests[0].messages);
  assert.match(prompt, /Короткі пости з цифрами/, 'the reference rules are in the prompt');
  assert.match(prompt, /@private_one \(This is an invite link\)/);
  assert.match(prompt, /@tea_home «Чай вдома»: Чай/, 'the network channels are in the prompt');
  assert.match(JSON.stringify(llm.requests[1].messages.at(-1)), /потрібна рівно одна ідея intro/);
  assert.ok(l.costUsd > 0);
});

test('worker: without references the analysis runs at once; a run without a valid plan fails with the reason', async () => {
  const { svc, repo } = service({ turns: [{ text: 'не можу' }] });
  await svc.createLaunch({ target: KEY, brief: BRIEF });
  await svc.idle();
  const l = repo.rows[0];
  assert.equal(l.status, 'failed');
  assert.match(l.reason ?? '', /without a valid plan/);
});

test('worker: references not read within an hour are skipped and the plan comes from the brief', async () => {
  let t = NOW;
  const { svc, repo } = service({ turns: [{ calls: [{ name: SUBMIT_LAUNCH_TOOL, args: { ...validLaunch(), references: [] } }] }], now: () => t });
  await svc.createLaunch({ target: KEY, brief: BRIEF, references: ['@coffee_ref'] });
  await svc.idle();
  t = new Date(NOW.getTime() + REFERENCE_WAIT_MS + 60_000);
  await run(svc);
  const l = repo.rows[0];
  assert.equal(l.status, 'ready', l.reason ?? '');
  assert.equal(l.refs[0].status, 'skipped');
  assert.match(l.refs[0].reason ?? '', /not read within an hour/);
});

// ── checks ───────────────────────────────────────────────────────────────────

test('checks: shares, polls without the brief asking, intro on day 1, days, unknown references, copied text', async () => {
  const ref = { ref: 'telegram:@coffee_ref', title: null, summary: null, rules: [], metrics: null, texts: [set('x', 'telegram:@coffee_ref', 'ready').posts[0].text] };
  const ctx = { brief: BRIEF, references: [ref] };
  assert.deepEqual(await checkLaunch(validLaunch(), ctx), []);
  const v = validLaunch();
  const errs = await checkLaunch({
    ...v,
    format_mix: { formats: { text: 0.5, poll: 0.5 } },
    series_pillars: { ...v.series_pillars, pillars: [{ name: 'А', share: 50 }, { name: 'Б', share: 20 }, { name: 'В', share: 10 }] },
    first_week: { ideas: v.first_week.ideas.map((x, i) => ({ ...x, day: i === 0 ? 2 : 2, format: 'text' as const })) },
    references: [{ ref: 'telegram:@unknown_ref', takeaway: 'щось корисне звідти' }],
    voice: { ...v.voice, rules: [...v.voice.rules.slice(0, 4), 'Сьогодні варимо еспресо: 18 грамів кави, 36 грамів напою, 28 секунд екстракції і жодних компромісів'] },
  }, ctx);
  const all = errs.join('\n');
  assert.match(all, /pillars: частки мають давати 100 ± 5, зараз 80/);
  assert.match(all, /format_mix: poll — лише/);
  assert.match(all, /intro\) — у день 1/);
  assert.match(all, /щонайменше на 4 різні дні/);
  assert.match(all, /references: telegram:@unknown_ref/);
  assert.match(all, /voice\.rules\[4\]: \d+ символів поспіль повторюють пост референсу/);
  assert.deepEqual(await checkLaunch({ ...v, format_mix: { formats: { text: 0.5, poll: 0.5 } }, first_week: { ideas: v.first_week.ideas.map((x) => ({ ...x, format: 'text' as const })) }, series_pillars: { ...v.series_pillars, series: [] } }, { ...ctx, brief: `${BRIEF} Щотижня опитування.` }), []);
});

// ── redo / discard / artifact ────────────────────────────────────────────────

test('redo: a ready or failed launch is queued again with a new brief; a skipped reference is read again', async () => {
  const { svc, repo } = service({ turns: [{ text: 'ні' }] , refuse: { '@private_one': 'invite link' } });
  await svc.createLaunch({ target: KEY, brief: BRIEF, references: ['@private_one'] });
  await svc.idle();
  assert.equal(repo.rows[0].status, 'failed');
  await assert.rejects(svc.redo(repo.rows[0].id, { brief: 'коротко' }), /invalid_body|Bad Request/);
  const { launch } = await svc.redo(repo.rows[0].id, { brief: `${BRIEF} Новий акцент на френч-пресі.` });
  assert.equal(launch.status, 'queued');
  assert.match(launch.brief, /френч-пресі/);
  assert.deepEqual(launch.refs.map((r) => [r.status, r.setId]), [['queued', null]]);
  await svc.idle();
});

test('discard: before Start the launch and its unfinished reference sets are discarded; the card stays', async () => {
  const { svc, repo, calls } = service();
  await svc.createLaunch({ target: KEY, brief: BRIEF, references: ['@coffee_ref'] });
  await svc.idle();
  const { launch } = await svc.discard(repo.rows[0].id);
  assert.equal(launch.status, 'discarded');
  assert.deepEqual(calls.filter((c) => c[0] === 'discard'), [['discard', 'set-1']]);
  await assert.rejects(svc.discard(repo.rows[0].id), /not_open|Conflict/);
});

test('artifact: actions follow the status; the summary says what happens next', () => {
  const keys = (status: string, startRequested = false) => launchActions({ id: 'l1', status }, { startRequested }).map((a) => a.key);
  assert.deepEqual(keys('queued'), ['discard']);
  assert.deepEqual(keys('ready'), ['start', 'check', 'redo', 'discard']);
  assert.deepEqual(keys('ready', true), ['check', 'redo', 'discard']);
  assert.deepEqual(keys('failed'), ['redo', 'discard']);
  assert.deepEqual(keys('running'), ['go_live', 'discard']);
  assert.deepEqual(keys('graduated'), []);
  const base = { refs: [{ ref: 'telegram:@coffee_ref', setId: null, status: 'ready', reason: null, title: null }], reason: null, startedAt: null, startRequested: true } as any;
  assert.equal(launchSummary({ ...base, status: 'ready' }), 'starts when the bot is an admin · @coffee_ref');
});

// ── T2: the checklist and Start ──────────────────────────────────────────────

/** A launch with one reference read and a valid plan (status ready). */
async function readyLaunch(o: Parameters<typeof service>[0] = {}) {
  const t = service({ turns: [{ calls: [{ name: SUBMIT_LAUNCH_TOOL, args: validLaunch() }] }], ...o });
  await t.svc.createLaunch({ target: KEY, brief: BRIEF, references: ['@coffee_ref'] });
  await t.svc.idle();
  t.sets.set('set-1', set('set-1', 'telegram:@coffee_ref', 'ready'));
  await run(t.svc);
  assert.equal(t.repo.rows[0].status, 'ready', t.repo.rows[0].reason ?? '');
  return t;
}

test('checklist: what the owner does and what code does, with live states', async () => {
  const { svc, repo } = await readyLaunch();
  const steps = (await svc.view(repo.rows[0])).checklist;
  const st = Object.fromEntries(steps.map((x) => [x.key, x.state]));
  assert.deepEqual(st, {
    bot_admin: 'needs_you', tracked: 'waiting', references: 'done', plan: 'done', start: 'needs_you',
    first_posts: 'waiting', cross_promo: 'waiting', platforms: 'optional', graduation: 'waiting',
  });
  const bot = steps.find((x) => x.key === 'bot_admin')!;
  assert.equal(bot.who, 'owner');
  assert.match(bot.title, /Add @ai0_bot to @coffee_home as an administrator/);
  assert.equal(bot.link, 'https://t.me/coffee_home');
});

test('start: with the bot not an admin the Start is remembered; the tick that sees the bot starts it', async () => {
  let t = NOW;
  const { svc, repo, calls, box } = await readyLaunch({ now: () => t });
  const id = repo.rows[0].id;
  const r = await svc.start(id);
  assert.equal(r.started, false);
  assert.equal(r.waitingFor, 'bot_admin');
  assert.equal(repo.rows[0].startRequested, true);
  assert.equal(repo.rows[0].status, 'ready');
  assert.ok(!calls.some((c) => c[0] === 'mode'), 'nothing applied yet');

  box.bot = BOT_OK;
  const before = calls.filter((c) => c[0] === 'bot').length;
  t = new Date(NOW.getTime() + 30_000);
  await run(svc);
  assert.equal(calls.filter((c) => c[0] === 'bot').length, before, 'the bot is not asked again within two minutes');
  t = new Date(NOW.getTime() + BOT_RECHECK_MS + 1_000);
  await run(svc);
  const l = repo.rows[0];
  assert.equal(l.status, 'running', l.reason ?? '');
  assert.equal(l.startRequested, false);
  assert.equal(l.subsAtStart, 12);
  assert.deepEqual(calls.filter((c) => c[0] === 'trackOwn'), [['trackOwn', KEY]]);
  const order = calls.map((c) => c[0]).filter((k) => ['profile', 'card', 'format', 'playbook', 'voice', 'activate', 'idea', 'mode'].includes(k as string));
  assert.deepEqual([...new Set(order)], ['profile', 'card', 'format', 'playbook', 'voice', 'activate', 'idea', 'mode']);
  assert.deepEqual(calls.find((c) => c[0] === 'activate'), ['activate', 'set-1']);
  assert.deepEqual(calls.find((c) => c[0] === 'mode'), ['mode', KEY, 'approve']);
  const card = calls.find((c) => c[0] === 'card')![2] as Record<string, unknown>;
  assert.equal(card.brief, validLaunch().brief_profile.brief);
  assert.deepEqual(card.formats, validLaunch().format_mix.formats);
  assert.equal(card.postsPerDayMax, validLaunch().schedule.posts_per_day_max);
  const ideas = calls.filter((c) => c[0] === 'idea');
  assert.equal(ideas.length, validLaunch().first_week.ideas.length);
  assert.equal(ideas[0][1], validLaunch().first_week.ideas.find((i) => i.intro)!.title, 'the day-1 intro comes first');
  assert.equal(ideas[0][2], `launch:${l.id}`);
  assert.equal(ideas[0][3], `telegram:${KEY}`);
  assert.match(String(calls.find((c) => c[0] === 'voice')![1]), /^# Голос каналу @coffee_home/);
  await svc.idle();
  assert.deepEqual(calls.filter((c) => c[0] === 'plan'), [['plan', KEY]]);
});

test('start: with the bot an admin the launch runs at once; a second Start changes nothing', async () => {
  const { svc, repo, calls } = await readyLaunch({ bot: BOT_OK });
  const id = repo.rows[0].id;
  const r = await svc.start(id);
  assert.equal(r.started, true);
  assert.equal(r.launch.status, 'running');
  assert.ok(r.launch.checklist.find((x) => x.key === 'start')!.state === 'done');
  const n = calls.length;
  const again = await svc.start(id);
  assert.equal(again.started, true);
  assert.equal(calls.length, n);
  await svc.idle();
});

test('start: a failing step stops the Start, keeps the launch ready and says which step', async () => {
  const { svc, repo, calls } = await readyLaunch({ bot: BOT_OK, failStep: 'playbook' });
  await assert.rejects(svc.start(repo.rows[0].id), /Conflict|start_failed/);
  const l = repo.rows[0];
  assert.equal(l.status, 'ready');
  assert.match(l.reason ?? '', /^start: playbook: playbook_invalid/);
  assert.ok(!calls.some((c) => c[0] === 'mode'));
  await assert.rejects(service().svc.start('nope'), /launch_not_found|Not Found/);
});

test('check: asks the Bot API now; a remembered Start then runs', async () => {
  const { svc, repo, box } = await readyLaunch();
  const id = repo.rows[0].id;
  await svc.start(id);
  box.bot = BOT_OK;
  const { launch } = await svc.check(id);
  assert.equal(launch.status, 'running');
  assert.equal(launch.bot?.state, 'ok');
  assert.equal(launch.checklist.find((x) => x.key === 'tracked')!.state, 'done');
  await svc.idle();
});

test('owner bot: a ready plan waits for Start; a Start waiting for the bot asks for the admin rights', async () => {
  const { svc, repo, box } = await readyLaunch();
  const l = repo.rows[0];
  const rows = [{ id: l.id, channel_key: KEY, summary: 'Кавовий канал для початківців', start_requested: false, bot_state: NO_BOT, updated_at: NOW }];
  const src = launchSource({ pool: { query: async () => ({ rows }) } as any, launches: svc });
  let [card] = await src.waiting(NOW);
  assert.equal(card.refId, `${l.id}:start`);
  assert.deepEqual(card.buttons.map((b) => b.key), ['start', 'check', 'open']);
  assert.equal(card.buttons[0].confirm, 'Так, запустити');
  assert.match(card.body ?? '', /Додайте @ai0_bot в @coffee_home адміністратором/);
  assert.equal(card.path, `/app/artifacts?type=launch&open=launch:${l.id}`);

  assert.match(await src.act(card.refId, 'start'), /Старт прийнято/);
  rows[0].start_requested = true;
  [card] = await src.waiting(NOW);
  assert.equal(card.refId, `${l.id}:bot`);
  assert.deepEqual(card.buttons.map((b) => b.key), ['check', 'open']);
  await assert.rejects(src.act(card.refId, 'check'), /Додайте @ai0_bot в @coffee_home/);
  box.bot = BOT_OK;
  assert.match(await src.act(card.refId, 'check'), /запуск стартував/);
  assert.equal(repo.rows[0].status, 'running');
  await svc.idle();
});
