/**
 * Spec 042: channel setup from history — metrics in code, the onboarder's checks, Apply by section, the queue, and the post
 * collector's top-up. The model is scripted (FakeLlm); posts and channels are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { makeCard } from '../post/testing/fixtures';
import type { Agent } from '../agents/agent.types';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import { computeMetrics, openingKey } from './setup-metrics';
import { allowedFormats, checkSetup, noTextNote, onboarderUserPrompt, SUBMIT_SETUP_TOOL } from './setup-analysis';
import { applySections, driftedSections, formatPatch, mergePlaybook, sectionBaseline, type ApplyWriters, type ChannelState } from './setup-apply';
import { collectPosts } from './setup-posts';
import { ChannelSetupService } from './setup.service';
import type { ChannelSetupRepository, SetupProposal } from './setup.repository';
import { samplePosts, SIGNATURE, validSetup } from './testing/setup-fixtures';

const KEY = '@tips_ua';
const REF = `telegram:${KEY}`;

const agent = (p: Partial<Agent> = {}): Agent => ({
  id: 'a-tips', kind: 'orchestrator', scope: 'resource', scopeId: REF, parentId: null, name: 'Tips', handle: 'tips', emoji: null,
  description: null, mode: 'approve', status: 'active', pausedUntil: null, model: null, reasoningEffort: null, schedule: {},
  dailyBudgetUsd: null, shadowUntil: null, createdBy: 'sync', createdAt: new Date(), updatedAt: new Date(), ...p,
});

// ── metrics ──────────────────────────────────────────────────────────────────

test('metrics: cadence, peak hours, mix, signature, hashtags, address and rubric candidates from the posts', () => {
  const m = computeMetrics(samplePosts(), 'Europe/Kyiv');
  assert.equal(m.posts, 8);
  assert.equal(m.activeDays, 4, 'every 12 hours from 12:05 Kyiv: two posts a day over four days');
  assert.deepEqual(m.formatMix, { text: 0.63, photo: 0.38 });
  assert.equal(m.signature, SIGNATURE);
  assert.deepEqual(m.hashtags.vocabulary, ['безпека']);
  assert.ok(m.address.vy > 0 && m.address.ty === 0);
  assert.deepEqual(m.rubrics.find((r) => r.label === '📌 порада дня'), { label: '📌 порада дня', posts: ['p1', 'p3', 'p5'] });
  assert.equal(openingKey('📌 Порада дня: x'), '📌 порада дня');
  assert.equal(openingKey('Огляд тижня — три новини'), 'огляд тижня');
  assert.equal(openingKey('Нова версія застосунку вже доступна: що змінилось'), 'нова версія застосунку', 'a long lead-in is not a label');
  assert.equal(m.topPosts[0], 'p4', 'p4: 40 comments');
  assert.ok(m.peakHours.length >= 1);
  assert.ok(m.cta > 0);
});

test('metrics: the opening key groups a rubric by its first three words', () => {
  const posts = samplePosts().map((p, i) => (i % 2 ? p : { ...p, text: `📌 Порада дня\n${p.text}` }));
  const m = computeMetrics(posts, 'Europe/Kyiv');
  assert.deepEqual(m.rubrics[0], { label: '📌 порада дня', posts: ['p1', 'p3', 'p5', 'p7'] });
});

// ── the onboarder's checks ───────────────────────────────────────────────────

test('checks: a valid answer passes; formats seen in the posts only', async () => {
  const posts = samplePosts();
  const metrics = computeMetrics(posts, 'Europe/Kyiv');
  assert.deepEqual([...allowedFormats(metrics.formatMix)].sort(), ['album', 'photo', 'text']);
  assert.deepEqual(await checkSetup(validSetup(), { posts, metrics }), []);
});

test('checks: unknown posts, a one-post rubric, shares, unseen formats and invented quotes come back as a checklist', async () => {
  const posts = samplePosts();
  const bad = validSetup();
  bad.brief_profile.evidence.post_ids = ['p1', 'p42'];
  bad.series_pillars.series = [{ name: 'Відео тижня', cadence: 'weekly:fri@18:00', format: 'video', brief: 'Відео про безпеку раз на тиждень.', post_ids: ['p2'] }];
  bad.series_pillars.pillars = [{ name: 'A', share: 50 }, { name: 'B', share: 20 }, { name: 'C', share: 10 }];
  bad.format_mix.formats = { text: 0.5, video: 0.5 };
  bad.examples_voice.voice.quotes = ['зберігайте паролі в менеджері', 'ми завжди поруч з вами'];
  const errors = await checkSetup(bad, { posts, metrics: computeMetrics(posts, 'Europe/Kyiv') });
  const all = errors.join('\n');
  assert.match(all, /brief_profile\.evidence: немає постів p42/);
  assert.match(all, /рубрика «Відео тижня»: .*щонайменше 2 пости/);
  assert.match(all, /pillars: частки мають давати 100 ± 5, зараз 80/);
  assert.match(all, /format_mix: формати video у постах не трапляються/);
  assert.match(all, /quotes\[1\]: «ми завжди поруч з вами» — такого тексту в постах немає/);
  assert.doesNotMatch(all, /quotes\[0\]/, 'a verbatim quote passes');
});

// ── Apply helpers ────────────────────────────────────────────────────────────

test('format patch: locked fields are kept, the style merges with the stored one', () => {
  const { patch, kept } = formatPatch(validSetup(), ['emoji'], { glossary: { ban: ['x'] } });
  assert.deepEqual(kept, ['emoji']);
  assert.equal(patch.emoji, undefined);
  assert.deepEqual(patch.style, { glossary: { ban: ['x'] }, address: 'vy' });
  assert.equal(patch.signature, SIGNATURE);
});

test('playbook: a channel without one gets a core section; the owner-locked series stays; examples are the posts verbatim', () => {
  const card = makeCard({ channelKey: KEY, formats: { text: 1, photo: 1 } });
  const i = validSetup();
  const fresh = mergePlaybook(null, REF, card, { formatMix: { text: 0.6, photo: 0.4 }, schedule: { min: 1, max: 2, bestHours: [12, 9] }, series: i.series_pillars, examples: [{ text: 'Текст поста p1', format: 'text' }] });
  assert.equal(PlaybookSchema.safeParse(fresh).success, true);
  assert.deepEqual(fresh.platforms[0], { ...fresh.platforms[0], resource_ref: REF, role: 'core', formats: { text: 0.6, photo: 0.4 }, per_day: { min: 1, max: 2 }, best_hours: [9, 12] });
  assert.deepEqual(fresh.series.map((s) => [s.name, s.locked, s.origin]), [['Порада дня', true, 'owner']]);
  assert.deepEqual(fresh.examples, [{ format: 'text', text: 'Текст поста p1', verdict: 'good', note: 'From the channel history (setup from history)', resource_ref: REF }]);

  const current: Playbook = PlaybookSchema.parse({
    platforms: [{ resource_ref: REF, role: 'core', formats: { text: 1 }, per_day: { min: 2, max: 4 } }],
    series: [
      { name: 'Порада дня', cadence: 'daily@10:00', resource_ref: REF, format: 'text', brief: 'Власникова версія рубрики.', locked: true, origin: 'owner' },
      { name: 'Старе', cadence: 'daily@20:00', resource_ref: REF, format: 'text', brief: 'Рубрика агента, яку замінить пропозиція.' },
    ],
    examples: [{ format: 'text', text: 'Поганий приклад з клікбейтом', verdict: 'bad', resource_ref: REF }],
  });
  const merged = mergePlaybook(current, REF, card, { series: i.series_pillars });
  assert.deepEqual(merged.series.map((s) => [s.name, s.cadence]), [['Порада дня', 'daily@10:00']], 'the locked owner series wins over the proposal; the agent one goes');
  assert.deepEqual(merged.platforms[0].per_day, { min: 2, max: 4 }, 'schedule not chosen: per day stays');
  assert.equal(merged.examples.length, 1, 'examples not chosen: they stay');
});

function writersSpy(over: Partial<ApplyWriters> = {}) {
  const calls: Array<[string, unknown]> = [];
  const w: ApplyWriters = {
    upsertCard: async (k, p) => { calls.push(['upsertCard', p]); },
    getCard: async () => makeCard({ channelKey: KEY, mode: 'off' }),
    ensureAgent: async () => { calls.push(['ensureAgent', KEY]); return agent({ mode: 'off' }); },
    setProfile: async (ref, p) => { calls.push(['setProfile', p]); },
    patchFormat: async (ref, p) => { calls.push(['patchFormat', p]); return { ok: true }; },
    onBrief: async () => { calls.push(['onBrief', null]); },
    putPlaybook: async (h, body) => { calls.push(['putPlaybook', body]); },
    putVoiceSkill: async (h, s) => { calls.push(['putVoiceSkill', s]); },
    ...over,
  };
  return { w, calls };
}

const state = (p: Partial<ChannelState> = {}): ChannelState => ({
  card: makeCard({ channelKey: KEY, brief: 'Старий бриф', formats: { text: 1, photo: 1 } }), agent: agent(),
  profile: null, locks: ['emoji'], playbook: null, voice: null, ...p,
});

test('apply all: sections in order through the writers; the playbook is written once and the brief rebuild is skipped', async () => {
  const { w, calls } = writersSpy();
  const out = await applySections(w, { channelKey: KEY, ref: REF, title: 'Tips', input: validSetup(), posts: samplePosts(), sections: ['examples_voice', 'brief_profile', 'formatting', 'format_mix', 'series_pillars', 'schedule'], state: state() });
  assert.equal(out.failed, null);
  assert.deepEqual(out.applied, ['brief_profile', 'formatting', 'format_mix', 'series_pillars', 'schedule', 'examples_voice']);
  assert.deepEqual(calls.map((c) => c[0]), ['setProfile', 'upsertCard', 'patchFormat', 'upsertCard', 'upsertCard', 'upsertCard', 'putPlaybook', 'putVoiceSkill']);
  assert.equal(out.rebuilt, false);
  assert.deepEqual(out.kept, ['emoji']);
  const pb = calls.find((c) => c[0] === 'putPlaybook')![1] as Playbook;
  assert.equal(pb.examples[0].text, samplePosts()[0].text.trim(), 'example text copied from the post');
  assert.deepEqual(pb.platforms[0].best_hours, [9, 12]);
  const voice = calls.find((c) => c[0] === 'putVoiceSkill')![1] as { body: string };
  assert.match(voice.body, /> зберігайте паролі в менеджері/);
});

test('apply: a brief alone rebuilds the playbook as before; a new channel gets its card in mode off and an agent first', async () => {
  const one = writersSpy();
  const r1 = await applySections(one.w, { channelKey: KEY, ref: REF, title: null, input: validSetup(), posts: samplePosts(), sections: ['brief_profile'], state: state() });
  assert.equal(r1.rebuilt, true);
  assert.deepEqual(one.calls.map((c) => c[0]), ['setProfile', 'upsertCard', 'onBrief']);

  const two = writersSpy();
  const r2 = await applySections(two.w, { channelKey: KEY, ref: REF, title: 'Tips', input: validSetup(), posts: samplePosts(), sections: ['format_mix'], state: state({ card: null, agent: null }) });
  assert.deepEqual(two.calls.slice(0, 2), [['upsertCard', { mode: 'off', title: 'Tips' }], ['ensureAgent', KEY]]);
  assert.deepEqual(r2.applied, ['format_mix']);
});

test('apply: a failing section stops the rest and says which', async () => {
  const { w, calls } = writersSpy({ patchFormat: async () => ({ error: 'invalid_patch', details: 'length' }) });
  const out = await applySections(w, { channelKey: KEY, ref: REF, title: null, input: validSetup(), posts: samplePosts(), sections: ['brief_profile', 'formatting', 'format_mix'], state: state() });
  assert.deepEqual(out.applied, ['brief_profile']);
  assert.equal(out.failed?.section, 'formatting');
  assert.match(out.failed!.error, /invalid_patch/);
  assert.ok(!calls.some((c) => c[0] === 'upsertCard' && (c[1] as any).formats), 'format_mix was not written');
});

test('drift: a section changed since the analysis is reported', () => {
  const before = sectionBaseline(state(), REF);
  const now = sectionBaseline(state({ card: makeCard({ channelKey: KEY, brief: 'Новий бриф власника', formats: { text: 1, photo: 1 } }) }), REF);
  assert.deepEqual(driftedSections(before as any, now, ['brief_profile', 'format_mix']), ['brief_profile']);
});

// ── the queue and the onboarder run ──────────────────────────────────────────

class MemoryRepo {
  rows: SetupProposal[] = [];
  async enqueue(channelKey: string, createdBy = 'owner') {
    for (const r of this.rows) if (r.channelKey === channelKey && ['queued', 'collecting', 'analyzing', 'ready'].includes(r.status)) r.status = 'superseded';
    const p: SetupProposal = {
      id: `00000000-0000-4000-9000-${String(this.rows.length + 1).padStart(12, '0')}`, channelKey, resourceRef: `telegram:${channelKey}`, agentId: null,
      status: 'queued', reason: null, retryAt: null, postIds: [], metrics: null, sections: null, sectionStatus: {}, baseline: null, runId: null,
      costUsd: 0, createdBy, createdAt: new Date(), updatedAt: new Date(), appliedAt: null,
    };
    this.rows.push(p);
    return p;
  }
  async get(id: string) { return this.rows.find((r) => r.id === id) ?? null; }
  async list() { return this.rows; }
  async latestByChannel() { return new Map(this.rows.map((r) => [r.channelKey, r])); }
  async claimNext(now: Date) {
    const r = this.rows.find((x) => x.status === 'queued' && (!x.retryAt || x.retryAt <= now));
    if (r) r.status = 'collecting';
    return r ?? null;
  }
  async requeueStuck() { return 0; }
  async update(id: string, p: Record<string, unknown>) {
    const r = this.rows.find((x) => x.id === id)!;
    Object.assign(r, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
    return r;
  }
}

function setupService(o: { turns: any[]; collect?: (k: string) => Promise<any>; st?: () => ChannelState; writers?: ApplyWriters }) {
  const repo = new MemoryRepo();
  const llm = new FakeLlm(o.turns);
  const posts = samplePosts();
  const tracked = { id: 'tc-1', channelKey: KEY, username: 'tips_ua', tgChatId: null, title: 'Tips', about: 'Поради', subsCount: 1200, isMine: true, trackingStatus: 'ok' };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM tracked_channels')) return { rows: params[0] === KEY ? [{ id: 'tc-1', channel_key: KEY, is_mine: true, tracking_status: 'ok' }] : [] };
      if (sql.includes('FROM tracked_posts WHERE id = ANY')) {
        return { rows: posts.map((p) => ({ id: p.id, tg_message_id: p.msgId, text: p.text, has_media: p.hasMedia, media_type: p.mediaType, posted_at: p.postedAt, views: p.views, forwards: p.forwards, reactions_total: p.reactionsTotal, comments_count: p.comments })) };
      }
      return { rows: [] };
    },
  };
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  let st = o.st ?? (() => state());
  const svc = new ChannelSetupService({
    pool: pool as any, repo: repo as unknown as ChannelSetupRepository, loop,
    collect: o.collect ?? (async () => ({ status: 'ok', channel: tracked, posts, toppedUp: 0 })),
    model: async () => resolveModel('onboarder', () => undefined),
    state: async () => st(),
    writers: o.writers ?? writersSpy().w,
  });
  return { svc, repo, llm, setState: (f: () => ChannelState) => { st = f; } };
}

const drain = (svc: ChannelSetupService, _repo?: MemoryRepo) => svc.idle();

test('run: the onboarder fixes the checklist once, the proposal is ready with six pending sections', async () => {
  const bad = { ...validSetup(), format_mix: { formats: { video: 1 }, evidence: { post_ids: [], note: 'відео' } } };
  const { svc, repo, llm } = setupService({ turns: [{ calls: [{ name: SUBMIT_SETUP_TOOL, args: bad }] }, { calls: [{ name: SUBMIT_SETUP_TOOL, args: validSetup() }] }] });
  const { queued, refused } = await svc.analyze({ channelKeys: [KEY, '@someone_else'] });
  assert.equal(queued.length, 1);
  assert.deepEqual(refused, [{ channelKey: '@someone_else', error: 'not_own_channel' }]);
  await drain(svc, repo);
  const p = repo.rows[0];
  assert.equal(p.status, 'ready', p.reason ?? '');
  assert.equal(p.postIds.length, 8);
  assert.deepEqual(Object.values(p.sectionStatus), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(llm.requests.length, 2);
  const retry = JSON.stringify(llm.requests[1].messages.at(-1));
  assert.match(retry, /setup_invalid/);
  assert.match(retry, /1\. format_mix: формати video/);
  assert.match(JSON.stringify(llm.requests[0].messages), /📌 Порада дня/, 'the posts are in the prompt');
  assert.deepEqual(llm.requests[0].tools?.map((t) => t.name), [SUBMIT_SETUP_TOOL]);
});

test('run: no access and too few posts never call the model; FLOOD_WAIT puts the proposal back with a retry time', async () => {
  const none = setupService({ turns: [], collect: async () => ({ status: 'no_access', channel: null, posts: [], reason: 'Add the tracking account to the channel' }) });
  await none.svc.analyze({ channelKeys: [KEY] });
  await drain(none.svc, none.repo);
  assert.equal(none.repo.rows[0].status, 'no_access');
  assert.equal(none.llm.requests.length, 0);

  const flood = setupService({ turns: [], collect: async () => { throw Object.assign(new Error('flood'), { floodWaitSeconds: 30 }); } });
  await flood.svc.analyze({ channelKeys: [KEY] });
  await drain(flood.svc);
  assert.equal(flood.repo.rows[0].status, 'queued');
  assert.ok(flood.repo.rows[0].retryAt && flood.repo.rows[0].retryAt.getTime() > Date.now() + 20_000);
  assert.equal(await flood.repo.claimNext(new Date()), null, 'not before the retry time');
});

test('apply through the service: all sections, then nothing left; a re-run supersedes an open proposal', async () => {
  const spy = writersSpy();
  const { svc, repo } = setupService({ turns: [{ calls: [{ name: SUBMIT_SETUP_TOOL, args: validSetup() }] }], writers: spy.w });
  await svc.analyze({ channelKeys: [KEY] });
  await drain(svc, repo);
  const id = repo.rows[0].id;
  const r = await svc.apply(id, { sections: ['brief_profile', 'formatting', 'format_mix', 'series_pillars', 'schedule', 'examples_voice'] });
  assert.equal(r.failed, null);
  assert.equal(r.proposal?.status, 'applied');
  await assert.rejects(svc.apply(id, { sections: ['brief_profile'] }), (e: any) => e.getResponse?.().error === 'not_open');

  const again = setupService({ turns: [{ calls: [{ name: SUBMIT_SETUP_TOOL, args: validSetup() }] }] });
  await again.svc.analyze({ channelKeys: [KEY] });
  await drain(again.svc, again.repo);
  await again.svc.analyze({ channelKeys: [KEY] });
  assert.equal(again.repo.rows[0].status, 'superseded');
  assert.ok(['queued', 'collecting'].includes(again.repo.rows[1].status), 'the new run is open (the worker may have claimed it)');
  await drain(again.svc);
});

test('apply through the service: a section the owner changed since the analysis is refused, the rest applies', async () => {
  const spy = writersSpy();
  const { svc, repo, setState } = setupService({ turns: [{ calls: [{ name: SUBMIT_SETUP_TOOL, args: validSetup() }] }], writers: spy.w });
  await svc.analyze({ channelKeys: [KEY] });
  await drain(svc, repo);
  setState(() => state({ card: makeCard({ channelKey: KEY, brief: 'Власник переписав бриф', formats: { text: 1, photo: 1 } }) }));
  const view = await svc.get(repo.rows[0].id);
  assert.deepEqual(view.drift, ['brief_profile']);
  assert.deepEqual(view.kept, ['emoji']);
  assert.equal((view.current?.brief_profile as { brief: string }).brief, 'Власник переписав бриф');
  assert.equal(view.posts.length, 8);
  assert.equal(view.posts[0].link, 'https://t.me/tips_ua/999');
  const r = await svc.apply(repo.rows[0].id, { sections: ['brief_profile', 'format_mix'] });
  assert.deepEqual(r.changedSinceAnalysis, ['brief_profile']);
  assert.deepEqual(r.applied, ['format_mix']);
  assert.equal(r.proposal?.status, 'partially_applied');
  assert.equal(r.proposal?.sectionStatus.brief_profile, 'pending');

  // The owner applies the changed section anyway: the override replaces the newer change and closes the proposal's last section.
  const o = await svc.apply(repo.rows[0].id, { sections: ['brief_profile'], override: ['brief_profile'] });
  assert.deepEqual(o.changedSinceAnalysis, []);
  assert.deepEqual(o.applied, ['brief_profile']);
  assert.equal(o.proposal?.sectionStatus.brief_profile, 'applied');
});

// ── post collection ──────────────────────────────────────────────────────────

test('posts: fewer than 20 stored → one live read, upserted, then read again; no access is told apart from no posts', async () => {
  const stored: any[] = samplePosts().slice(0, 3).map((p) => ({ id: p.id, tg_message_id: p.msgId, text: p.text, has_media: false, media_type: null, posted_at: p.postedAt, views: 1, forwards: 0, reactions_total: 0, comments_count: 0 }));
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM tracked_channels')) return { rows: [{ id: 'tc-1', channel_key: KEY, username: 'tips_ua', tg_chat_id: null, is_mine: true, tracking_status: 'ok' }] };
      if (sql.startsWith('SELECT id, tg_message_id')) return { rows: [...stored].sort((a, b) => b.posted_at - a.posted_at) };
      if (sql.includes('INSERT INTO tracked_posts')) {
        if (!stored.some((r) => r.tg_message_id === params[1])) stored.push({ id: `new-${params[1]}`, tg_message_id: params[1], text: params[2], has_media: params[3], media_type: params[4], posted_at: params[5], views: params[6], forwards: params[7], reactions_total: params[8], comments_count: params[10] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const messages = Array.from({ length: 10 }, (_, k) => ({ id: 2000 + k, date: new Date(Date.parse('2026-10-16T08:00:00Z') - k * 3_600_000), text: `Пост ${k}`, hasMedia: false, mediaType: null, views: 10, forwards: 0, replies: 0, reactionsTotal: 1, reactions: null }));
  let reads = 0;
  const ok = await collectPosts({ pool: pool as any, readHistory: async (target, limit) => { reads++; assert.equal(target, 'tips_ua'); assert.equal(limit, 50); return { access: 'ok', messages }; } }, KEY);
  assert.equal(ok.status, 'ok');
  assert.equal(reads, 1);
  assert.equal(ok.posts.length, 13);
  assert.equal(ok.posts[0].key, 'p1');

  const denied = await collectPosts({ pool: pool as any, readHistory: async () => ({ access: 'not_subscribed', messages: [] }) }, KEY);
  assert.equal(denied.status, 'no_access');
  const few = await collectPosts({ pool: { query: async (sql: string) => (sql.includes('FROM tracked_channels') ? { rows: [{ id: 'tc-1', channel_key: KEY, is_mine: true, tracking_status: 'ok' }] } : { rows: [] }) } as any, readHistory: async () => ({ access: 'ok', messages: messages.slice(0, 2) }) }, KEY);
  assert.equal(few.status, 'too_few_posts');
});

// ── spec 041 FR-008 (T8): text-only metrics, insufficient data / span ────────

test('041 metrics: medians and shares count only posts with text; the prompt says how many have none', () => {
  const posts = samplePosts();
  const bare = posts.map((p, i) => (i < 3 ? { ...p, text: '', hasMedia: true, mediaType: 'photo' } : p));
  const m = computeMetrics(bare, 'Europe/Kyiv');
  assert.equal(m.posts, 8);
  assert.equal(m.textPosts, 5);
  assert.ok(m.length.median > 40, `median ${m.length.median}: no zero-length posts in it`);
  assert.match(onboarderUserPrompt({
    channelKey: KEY, title: 'Tips', about: null, subscribers: null, posts: bare, metrics: m, lockedFormat: [], lockedSeries: [],
    current: { brief: null, profile: null },
  }), /Історія охоплює лише \d+ дн\.[\s\S]*3 з 8 постів без тексту/u);
  assert.equal(noTextNote(posts), null);
});

test('041 run: fewer than 5 posts with text is insufficient_data without a model call', async () => {
  const posts = samplePosts().map((p, i) => (i < 4 ? { ...p, text: 'Фото', hasMedia: true, mediaType: 'photo' } : p));
  const tracked = { id: 'tc-1', channelKey: KEY, username: 'tips_ua', tgChatId: null, title: 'Tips', about: null, subsCount: 10, isMine: true, trackingStatus: 'ok' };
  const s = setupService({ turns: [], collect: async () => ({ status: 'ok', channel: tracked, posts, toppedUp: 0 }) });
  await s.svc.analyze({ channelKeys: [KEY] });
  await drain(s.svc);
  assert.equal(s.repo.rows[0].status, 'too_few_posts');
  assert.match(s.repo.rows[0].reason ?? '', /^insufficient_data: 4 of 8 posts have text/);
  assert.equal(s.llm.requests.length, 0);
});

test('041 run: under 7 days of history the proposal is ready without the rate and quiet hours (insufficient_span)', async () => {
  const s = setupService({ turns: [{ calls: [{ name: SUBMIT_SETUP_TOOL, args: validSetup() }] }] });
  await s.svc.analyze({ channelKeys: [KEY] });
  await drain(s.svc);
  const p = s.repo.rows[0];
  assert.equal(p.status, 'ready');
  assert.match(p.reason ?? '', /^insufficient_span: the posts span \d days/);
  assert.equal((p.sections as any).schedule.insufficient_span, true);
  const { w, calls } = writersSpy();
  const out = await applySections(w, { channelKey: KEY, ref: REF, title: 'Tips', input: p.sections as any, posts: samplePosts(), sections: ['schedule'], state: state() });
  assert.equal(out.failed, null);
  assert.ok(out.applied.includes('schedule'));
  assert.ok(!calls.some(([k]) => k === 'upsertCard'), JSON.stringify(calls));
  const written = calls.find(([k]) => k === 'putPlaybook')?.[1] as any;
  assert.deepEqual(written.platforms[0].per_day, { min: 2, max: 5 }, 'the card\'s rate, not the proposal\'s');
  assert.deepEqual(written.platforms[0].best_hours, [...validSetup().schedule.best_hours].sort((x, y) => x - y));
  const pb = mergePlaybook(null, REF, makeCard({ postsPerDayMin: 2, postsPerDayMax: 3, formats: { text: 1 } }), { schedule: { bestHours: [9, 18] } });
  assert.deepEqual(pb.platforms[0].per_day, { min: 2, max: 3 }, 'the rate stays the card\'s');
  assert.deepEqual(pb.platforms[0].best_hours, [9, 18]);
});
