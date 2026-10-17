/**
 * Spec 045: steering — the reference reader, the copy measure, the analysis checks, the prompt blocks, the publish guard
 * and the service's queue and lifecycle. The model is scripted (FakeLlm); channels and posts are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { makeCard } from '../post/testing/fixtures';
import { SkillLibrary } from '../skills/skill-library';
import { buildSystemPrompt } from '../roles/prompts';
import { criticUserPrompt, type CriticRequest } from '../critic/critic.service';
import type { HistoryMessage } from '../setup/setup-posts';
import { commonRunChars, longestSharedRun } from './common-run';
import { checkSteering, ruleTextProblems, SUBMIT_STEERING_TOOL, SubmitSteeringInput, toRules, type SteeringTarget } from './steering-analysis';
import { checkSteeringCopy } from './steering-guard';
import { steeringSection } from './steering-prompt';
import { parseSourceRef, telegramReader, toSourcePosts } from './steering-source';
import { SteeringService, targetOf } from './steering.service';
import type { SteeringRepository } from './steering.repository';
import { PENDING_STATUSES, type SourcePost, type SteeringSet, type SteeringStatus } from './steering.types';

const TARGET = 'telegram:@pdr_mine';
const SOURCE = 'telegram:@ref_channel';

const LONG_POST = 'Міф: якщо горить жовтий, можна проскочити перехрестя, бо він означає лише попередження для водіїв, які ще далеко від стоп-лінії.';

function messages(n: number): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 100 + i, date: new Date(Date.UTC(2026, 9, 1 + i, 9, 0)), text: i === n - 1 ? LONG_POST : `Пост ${i}: ще один корисний розбір теми номер ${i}.`,
    hasMedia: i % 3 === 0, mediaType: i % 3 === 0 ? 'photo' : null, views: 1000 + i * 10, forwards: i, replies: 2, reactionsTotal: 5 + i, reactions: null,
  }));
}

function sourcePosts(n = 8): SourcePost[] {
  return toSourcePosts(messages(n));
}

const validInput = () => ({
  summary: 'Референс тримає короткі пости-розвінчання з чітким першим рядком і питанням до читача наприкінці.',
  rules: [
    { kind: 'hook', text: 'Починай пост із поширеної хибної думки водіїв, а другим рядком — коротке «насправді».', evidence: { post_ids: ['r1', 'r2'], note: 'обидва найпопулярніші пости так починаються' }, conflict: null },
    { kind: 'series', text: 'Раз на тиждень — рубрика розвінчання міфів про правила дорожнього руху.', evidence: { post_ids: ['r1', 'r3'], note: 'повторюється щотижня' }, conflict: null },
    { kind: 'formatting', text: 'Додавай багато емодзі в кожен абзац.', evidence: { post_ids: ['r4'], note: 'емодзі в кожному рядку' }, conflict: { with: 'format_prefs: emoji', note: 'канал без емодзі' } },
  ],
});

// ── reading ──────────────────────────────────────────────────────────────────

test('source: @name, t.me links and telegram refs parse; invite links and junk are refused', () => {
  assert.deepEqual(parseSourceRef('@ref_channel'), { ref: SOURCE });
  assert.deepEqual(parseSourceRef('ref_channel'), { ref: SOURCE });
  assert.deepEqual(parseSourceRef('https://t.me/ref_channel/123'), { ref: SOURCE });
  assert.deepEqual(parseSourceRef('t.me/s/ref_channel'), { ref: SOURCE });
  assert.deepEqual(parseSourceRef('telegram:@ref_channel'), { ref: SOURCE });
  assert.equal((parseSourceRef('https://t.me/+AbCdEf') as any).error, 'invalid_source');
  assert.equal((parseSourceRef('t.me/joinchat/xyz') as any).error, 'invalid_source');
  assert.equal((parseSourceRef('not a channel') as any).error, 'invalid_source');
  assert.deepEqual(targetOf('@pdr_mine'), { ref: TARGET, key: '@pdr_mine' });
  assert.equal(targetOf('-100123'), null);
});

test('source: the last 20 usable posts, newest first, keyed r1…; service messages are dropped', () => {
  const msgs = [...messages(25), { ...messages(1)[0], id: 999, text: '  ', hasMedia: false, date: new Date(Date.UTC(2026, 10, 1)) }];
  const posts = toSourcePosts(msgs);
  assert.equal(posts.length, 20);
  assert.equal(posts[0].key, 'r1');
  assert.equal(posts[0].msgId, 124, 'newest usable first (the empty newer one is dropped)');
  assert.equal(posts[19].msgId, 105);
  assert.equal(posts.find((p) => p.msgId === 121)?.mediaType, 'photo');
});

test('reader: no access, too few posts, ok with title; flood propagates', async () => {
  const off = telegramReader({});
  assert.equal((await off.read(SOURCE)).status, 'no_access');
  const priv = telegramReader({ readHistory: async () => ({ access: 'not_subscribed', messages: [] }) });
  assert.match((await priv.read(SOURCE) as any).reason, /must be public/);
  const few = telegramReader({ readHistory: async () => ({ access: 'ok', messages: messages(3) }) });
  assert.equal((await few.read(SOURCE)).status, 'too_few_posts');
  const seen: string[] = [];
  const ok = telegramReader({
    readHistory: async (t, limit) => { seen.push(`${t}:${limit}`); return { access: 'ok', messages: messages(8) }; },
    fullChannel: async () => ({ title: 'Ref', about: 'about', subsCount: 5000 }),
  });
  const r = await ok.read(SOURCE);
  assert.equal(r.status, 'ok');
  assert.deepEqual(seen, ['ref_channel:50']);
  assert.equal(r.status === 'ok' && r.info.title, 'Ref');
  const flood = telegramReader({ readHistory: async () => { throw Object.assign(new Error('flood'), { floodWaitSeconds: 30 }); } });
  await assert.rejects(flood.read(SOURCE), /flood/);
});

// ── copy measure ─────────────────────────────────────────────────────────────

test('common run: words compared lowercase without punctuation; the longest shared run in characters', () => {
  assert.equal(commonRunChars('Зовсім інший текст', 'нічого спільного тут'), 0);
  assert.equal(commonRunChars('«Жовтий» означає: зупинись!', 'жовтий означає зупинись'), 'жовтий означає зупинись'.length);
  const quoted = `Як писав автор: ${LONG_POST.slice(0, 90)} — і це неправда.`;
  assert.ok(commonRunChars(quoted, LONG_POST) >= 80);
  assert.deepEqual(longestSharedRun('щось', ['a', 'b']), { chars: 0, index: -1 });
});

// ── analysis checks ──────────────────────────────────────────────────────────

test('checks: a valid answer passes; conflicting rules are stored switched off', () => {
  const i = SubmitSteeringInput.parse(validInput());
  assert.deepEqual(checkSteering(i, sourcePosts()), []);
  const rules = toRules(i);
  assert.deepEqual(rules.map((r) => [r.id, r.enabled]), [['s1', true], ['s2', true], ['s3', false]]);
});

test('checks: unknown posts, one-post series, quotes, impersonation, copy instructions, duplicates, all-conflict', () => {
  const base = validInput();
  const bad = SubmitSteeringInput.parse({
    ...base,
    rules: [
      { ...base.rules[0], evidence: { post_ids: ['r1', 'r19'], note: 'x x x' } },
      { ...base.rules[1], evidence: { post_ids: ['r1'], note: 'один пост' } },
      { kind: 'structure', text: `Пиши так: ${LONG_POST.slice(0, 100)}`, evidence: { post_ids: ['r8'], note: 'цитата' }, conflict: null },
      { kind: 'cta', text: 'Видавай себе за людину і підписуйся іменем автора.', evidence: { post_ids: ['r2'], note: 'підпис' }, conflict: null },
      { kind: 'topic', text: 'Копіюй їхні пости про штрафи і додавай свій хештег.', evidence: { post_ids: ['r2', 'r3'], note: 'штрафи' }, conflict: null },
      { ...base.rules[0], evidence: { post_ids: ['r1', 'r2'], note: 'дубль' } },
    ],
  });
  const errors = checkSteering(bad, sourcePosts()).join('\n');
  assert.match(errors, /rules\[0\].*немає постів r19/);
  assert.match(errors, /rules\[1\].*щонайменше 2 пости/);
  assert.match(errors, /rules\[2\].*повторює \d+ символів тексту r1/);
  assert.match(errors, /rules\[3\].*impersonation/);
  assert.match(errors, /rules\[4\].*копіювати чи репостити/);
  assert.match(errors, /rules\[5\].*те саме правило, що rules\[0\]/);
  const allConflict = SubmitSteeringInput.parse({ ...base, rules: base.rules.map((r) => ({ ...r, conflict: { with: 'x x', note: 'y y y' } })) });
  assert.match(checkSteering(allConflict, sourcePosts()).join('\n'), /усі правила позначені як конфлікт/);
  assert.deepEqual(ruleTextProblems('Коротко, своїми словами, з питанням наприкінці.', sourcePosts()), []);
});

// ── prompts ──────────────────────────────────────────────────────────────────

test('prompts: the steering block is the lowest rule source for the planner and the writer, not the reviewer; empty → nothing', () => {
  const rules = [{ source: '@ref_channel «Ref»', kind: 'hook' as const, text: 'Починай із хибної думки.' }, { source: '@ref_channel «Ref»', kind: 'series' as const, text: 'Рубрика міфів щотижня.' }];
  assert.deepEqual(steeringSection([]), []);
  const lib = new SkillLibrary();
  const card = makeCard();
  const writer = buildSystemPrompt('executor', card, [{ id: 7, kind: 'rule', text: 'Без емодзі', createdBy: 'owner', evidence: null } as any], lib, [], { steering: rules });
  assert.match(writer, /## Напрям від референсів \(steering — найнижчий пріоритет\)\n.*Правила власника, плейбук, профіль/);
  assert.match(writer, /Референс @ref_channel «Ref»:\n- \[гачок\] Починай із хибної думки\.\n- \[рубрика\] Рубрика міфів щотижня\./);
  assert.ok(writer.indexOf('## Правила власника') < writer.indexOf('## Напрям від референсів'), 'owner rules come first');
  assert.match(buildSystemPrompt('planner', card, [], lib, [], { steering: rules }), /## Напрям від референсів/);
  assert.ok(!buildSystemPrompt('reviewer', card, [], lib, [], { steering: rules }).includes('Напрям від референсів'));
  assert.ok(!buildSystemPrompt('executor', card, [], lib, []).includes('Напрям від референсів'));
});

test('critic: steering is advice for format_fit, never a reason to reject', () => {
  const r = {
    resourceRef: TARGET, platform: 'telegram', format: 'text', text: 'Пост', spec: {}, voice: { humor: 'off', slang: 'off' }, source: null, slopWarnings: [],
    steering: [{ source: '@ref_channel', kind: 'hook', text: 'Починай із хибної думки.' }],
  } as unknown as CriticRequest;
  const p = criticUserPrompt(r);
  assert.match(p, /### Напрям від референсів \(steering, найнижчий пріоритет\)\nРеференс @ref_channel:\n- \[гачок\] Починай із хибної думки\./);
  assert.match(p, /порада для format_fit/);
  assert.ok(!criticUserPrompt({ ...r, steering: [] } as CriticRequest).includes('Напрям від референсів'));
});

// ── publish guard ────────────────────────────────────────────────────────────

test('guard: a post repeating 80+ characters of an active reference post is refused; own words pass', async () => {
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /status = 'active'/);
      return { rows: params[0] === TARGET ? [{ source_ref: SOURCE, posts: sourcePosts() }] : [] };
    },
  } as any;
  const hit = await checkSteeringCopy(pool, TARGET, `Заголовок\n${LONG_POST}`);
  assert.equal(hit?.error, 'steering_copy');
  assert.match(hit!.details, /r1 референсу @ref_channel/);
  assert.equal(await checkSteeringCopy(pool, TARGET, 'Жовтий сигнал — не дозвіл їхати: ось що каже пункт 8.7.3 ПДР.'), null);
  assert.equal(await checkSteeringCopy(pool, 'telegram:@other', LONG_POST), null, 'no active sets → no check');
});

// ── service ──────────────────────────────────────────────────────────────────

class MemoryRepo {
  rows: SteeringSet[] = [];
  private n = 0;
  async pending(t: string, s: string) { return this.rows.find((r) => r.targetRef === t && r.sourceRef === s && (PENDING_STATUSES as readonly string[]).includes(r.status)) ?? null; }
  async enqueue(i: { targetRef: string; channelKey: string | null; sourceRef: string; createdBy: string }) {
    const open = await this.pending(i.targetRef, i.sourceRef);
    if (open) return { set: open, created: false };
    const set: SteeringSet = {
      id: `00000000-0000-0000-0000-00000000000${++this.n}`, targetRef: i.targetRef, channelKey: i.channelKey, sourceRef: i.sourceRef, sourceTitle: null,
      status: 'queued', reason: null, retryAt: null, posts: [], metrics: null, summary: null, rules: [], runId: null, costUsd: 0,
      createdBy: i.createdBy, createdAt: new Date(Date.now() + this.n), updatedAt: new Date(), activatedAt: null,
    };
    this.rows.push(set);
    return { set, created: true };
  }
  async get(id: string) { return this.rows.find((r) => r.id === id) ?? null; }
  async list() { return [...this.rows].reverse(); }
  async activeFor(t: string) { return this.rows.filter((r) => r.targetRef === t && r.status === 'active'); }
  async claimNext(now: Date) {
    const r = this.rows.find((x) => x.status === 'queued' && (!x.retryAt || x.retryAt <= now));
    if (r) r.status = 'collecting';
    return r ?? null;
  }
  async requeueStuck() { return 0; }
  async update(id: string, p: Record<string, unknown>, o: { from?: readonly SteeringStatus[] } = {}) {
    const r = this.rows.find((x) => x.id === id)!;
    if (o.from && !o.from.includes(r.status)) return null;
    Object.assign(r, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    return r;
  }
  async activate(id: string, max: number) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return { error: 'not_found' as const };
    if (r.status !== 'ready' && r.status !== 'paused') return { error: 'not_ready' as const };
    if (this.rows.filter((x) => x.targetRef === r.targetRef && x.status === 'active' && x.sourceRef !== r.sourceRef).length >= max) return { error: 'too_many_active' as const };
    for (const o of this.rows) {
      if (o.id !== id && o.targetRef === r.targetRef && o.sourceRef === r.sourceRef && (o.status === 'active' || o.status === 'paused')) {
        o.status = 'superseded'; o.posts = o.posts.map((p) => ({ ...p, text: '' }));
      }
    }
    r.status = 'active'; r.activatedAt = new Date();
    return { set: r };
  }
  async estimateUsd() { return 0.05; }
}

const target = (p: Partial<SteeringTarget> = {}): SteeringTarget => ({
  ref: TARGET, title: 'ПДР моє', brief: 'Канал про правила дорожнього руху', profile: null,
  ownerRules: [{ id: 12, text: 'Без емодзі' }], playbook: null, formatPrefs: 'Емодзі: немає (закріплено власником)', locks: ['emoji'], ...p,
});

function steeringService(o: { turns: any[]; read?: (ref: string) => Promise<any>; noCard?: boolean }) {
  const repo = new MemoryRepo();
  const llm = new FakeLlm(o.turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const svc = new SteeringService({
    repo: repo as unknown as SteeringRepository,
    readers: { telegram: { platform: 'telegram', read: o.read ?? (async () => ({ status: 'ok', info: { title: 'Ref', about: null, subscribers: 5000 }, posts: sourcePosts() })) } },
    isOwn: async (key) => key === '@pdr_mine' || key === '@pdr_other',
    target: async () => ({ card: o.noCard ? null : makeCard({ channelKey: '@pdr_mine' }), agent: null, target: target() }),
    loop, model: async () => resolveModel('onboarder', () => undefined),
  });
  return { svc, repo, llm };
}

test('create: refusals are data; a twin returns the open set', async () => {
  const { svc } = steeringService({ turns: [] });
  assert.equal((await svc.createSet({ target: '@pdr_mine', source: 'https://t.me/+abc' })).ok, false);
  assert.deepEqual((await svc.createSet({ target: '@stranger', source: '@ref_channel' }) as any).error, 'not_own_channel');
  assert.equal((await svc.createSet({ target: '@pdr_mine', source: '@pdr_mine' }) as any).error, 'same_channel');
  assert.equal((await steeringService({ turns: [], noCard: true }).svc.createSet({ target: '@pdr_mine', source: '@ref_channel' }) as any).error, 'no_card');
  const svc2 = steeringService({ turns: [], read: () => new Promise(() => {}) }).svc;
  const first = await svc2.createSet({ target: '@pdr_mine', source: '@ref_channel' });
  assert.ok(first.ok);
  const twin = await svc2.createSet({ target: 'telegram:@pdr_mine', source: 't.me/ref_channel' });
  assert.equal((twin as any).error, 'already_open');
  assert.equal((twin as any).set.id, (first as any).set.id);
  await assert.rejects(svc2.create({ target: '@pdr_mine', source: '@ref_channel' }), (e: any) => e.getResponse().error === 'already_open');
});

test('run: the model fixes the checklist once; the set is ready with conflicting rules off; the prompt carries both channels', async () => {
  const bad = { ...validInput(), rules: [{ ...validInput().rules[1], evidence: { post_ids: ['r1'], note: 'один' } }, ...validInput().rules.slice(0, 1), validInput().rules[2]] };
  const { svc, repo, llm } = steeringService({ turns: [{ calls: [{ name: SUBMIT_STEERING_TOOL, args: bad }] }, { calls: [{ name: SUBMIT_STEERING_TOOL, args: validInput() }] }] });
  await svc.create({ target: '@pdr_mine', source: '@ref_channel' });
  await svc.idle();
  const s = repo.rows[0];
  assert.equal(s.status, 'ready', s.reason ?? '');
  assert.equal(s.sourceTitle, 'Ref');
  assert.equal(s.posts.length, 8);
  assert.ok(s.metrics);
  assert.deepEqual(s.rules.map((r) => r.enabled), [true, true, false]);
  assert.equal(llm.requests.length, 2);
  assert.match(JSON.stringify(llm.requests[1].messages.at(-1)), /steering_invalid.*щонайменше 2 пости/);
  const user = JSON.stringify(llm.requests[0].messages);
  assert.match(user, /# Наш канал/);
  assert.match(user, /#12 Без емодзі/);
  assert.match(user, /# Референс @ref_channel — «Ref», 5000 підписників/);
  assert.match(user, /### r1 /);
  assert.deepEqual(llm.requests[0].tools?.map((t) => t.name), [SUBMIT_STEERING_TOOL]);
});

test('run: no access and too few posts never call the model; FLOOD_WAIT re-queues with a retry time', async () => {
  const none = steeringService({ turns: [], read: async () => ({ status: 'no_access', info: null, posts: [], reason: 'must be public' }) });
  await none.svc.create({ target: '@pdr_mine', source: '@ref_channel' });
  await none.svc.idle();
  assert.equal(none.repo.rows[0].status, 'no_access');
  assert.equal(none.llm.requests.length, 0);
  const few = steeringService({ turns: [], read: async () => ({ status: 'too_few_posts', info: null, posts: sourcePosts(3), reason: '3 posts' }) });
  await few.svc.create({ target: '@pdr_mine', source: '@ref_channel' });
  await few.svc.idle();
  assert.equal(few.repo.rows[0].status, 'too_few_posts');
  assert.ok(few.repo.rows[0].posts.every((p) => p.text === ''), 'closed sets keep no third-party text');
  const flood = steeringService({ turns: [], read: async () => { throw Object.assign(new Error('flood'), { floodWaitSeconds: 30 }); } });
  await flood.svc.create({ target: '@pdr_mine', source: '@ref_channel' });
  await flood.svc.idle();
  assert.equal(flood.repo.rows[0].status, 'queued');
  assert.ok(flood.repo.rows[0].retryAt!.getTime() > Date.now() + 20_000);
});

test('lifecycle: activate, edit and switch rules, pause / resume, re-analyze supersedes, discard drops the texts', async () => {
  const turn = { calls: [{ name: SUBMIT_STEERING_TOOL, args: validInput() }] };
  const { svc, repo } = steeringService({ turns: [turn, turn] });
  const { set } = await svc.create({ target: '@pdr_mine', source: '@ref_channel' });
  await svc.idle();
  await assert.rejects(svc.patchRule(set.id, 's3', { enabled: true }), (e: any) => e.getResponse().error === 'rule_conflict');
  await assert.rejects(svc.patchRule(set.id, 's1', { text: `Пиши: ${LONG_POST.slice(0, 90)}` }), (e: any) => e.getResponse().error === 'rule_invalid');
  const edited = await svc.patchRule(set.id, 's1', { text: 'Перший рядок — хибна думка, другий — коротке «насправді».', enabled: false });
  assert.deepEqual([edited.set!.rules[0].edited, edited.set!.rules[0].enabled], [true, false]);
  assert.equal((await svc.activate(set.id)).set.status, 'active');
  assert.equal((await svc.pause(set.id)).set!.status, 'paused');
  assert.equal((await svc.resume(set.id)).set.status, 'active');
  const again = await svc.reanalyze(set.id);
  await svc.idle();
  assert.equal(repo.rows[0].status, 'active', 'the old set stays until the new one is activated');
  await svc.activate(again.set.id);
  assert.equal(repo.rows[0].status, 'superseded');
  assert.ok(repo.rows[0].posts.every((p) => p.text === ''));
  const gone = await svc.discard(again.set.id);
  assert.equal(gone.set!.status, 'discarded');
  assert.ok(gone.set!.posts.every((p) => p.text === ''));
  const listed = (await svc.list('@pdr_mine')).sets[0];
  assert.equal(listed.rulesTotal, 3);
  assert.equal(listed.conflicts, 1);
  const one = await svc.get(set.id);
  assert.match(one.posts[0].link!, /^https:\/\/t\.me\/ref_channel\/\d+$/);
});

test('lifecycle: a channel follows at most three references', async () => {
  const turn = { calls: [{ name: SUBMIT_STEERING_TOOL, args: validInput() }] };
  const { svc } = steeringService({ turns: [turn, turn, turn, turn] });
  const ids: string[] = [];
  for (const src of ['@ref_one', '@ref_two', '@ref_three', '@ref_four']) {
    ids.push((await svc.create({ target: '@pdr_mine', source: src })).set.id);
    await svc.idle();
  }
  for (const id of ids.slice(0, 3)) await svc.activate(id);
  await assert.rejects(svc.activate(ids[3]), (e: any) => e.getResponse().error === 'too_many_active');
  assert.deepEqual(await svc.activeSummary(TARGET), { active: 3, sources: ['@ref_one', '@ref_two', '@ref_three'] });
});
