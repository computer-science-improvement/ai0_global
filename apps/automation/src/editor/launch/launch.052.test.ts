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
import { LaunchService, REFERENCE_WAIT_MS, type LaunchDeps } from './launch.service';
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

function service(o: { turns?: ConstructorParameters<typeof FakeLlm>[0]; card?: EditorCard | null; bot?: LaunchBotState; refuse?: Record<string, string>; now?: () => Date } = {}) {
  const now = o.now ?? (() => NOW);
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
    botCheck: async () => o.bot ?? { state: 'no_access', detail: '@ai0_bot is not an administrator yet', bot: '@ai0_bot', chatTitle: 'Кава вдома', chatAbout: 'Про каву' },
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
    },
    network: async () => [{ key: '@tea_home', title: 'Чай вдома', topic: 'Чай' }],
    state: async () => ({ card, agent: agent(), profile: null, locks: [], playbook: null, voice: null }),
    loop,
    model: async () => resolveModel('onboarder', () => undefined),
    now,
  };
  return { svc: new LaunchService(d), repo, sets, calls, llm };
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
