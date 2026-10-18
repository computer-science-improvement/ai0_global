// Spec 037 FR-010 (T10): the evergreen step of the fallback ladder — cap per channel per day, the post marked
// evergreen by code, the content rules (no news words, no unsourced numbers), the main post's reason kept, counted apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { isToolError } from '../harness/tool';
import { lintPost } from '../post/lint-post';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import { evergreenCheck } from '../post/integrity/checks/evergreen';
import { datesCheck } from '../post/integrity/checks/dates';
import { INTEGRITY_CODES } from '../post/integrity/codes';
import { CODE_EXPLANATIONS } from '../audit/code-catalogue';
import { assembleQuality, QUALITY_FLAGS } from '../manager/quality-digest';
import { sendRendered } from '../publish/publish-spec';
import { evaluateSilentDays, type WatchSlot } from './silent-days';
import type { SlotFallback } from './fallback-ladder';
import { asEvergreenInput, EvergreenProbe, EvergreenStep, evergreenNote, evergreenPerDay, EVERGREEN_INBOX_KIND } from './evergreen';
import { evergreenFilled, evergreenShare } from './evergreen-stats';

const NOW = new Date('2026-10-12T09:00:00Z');
const baseSlot: any = { id: '00000000-0000-4000-8000-000000000001', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'text', topic: 'Тема дня', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };

type Behaviour = (st: any, input: any) => any;
const reject: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject (grounding 2): цифр немає в джерелі', critic: { verdict: 'reject', notes: 'цифр немає в джерелі', cost_usd: 0.002 } });
  return { ok: true, skipped: true, critic_rejected: true };
};
const shadow: Behaviour = (st, input) => {
  Object.assign(st, { status: 'shadowed', error: null, postSpec: input.spec, critic: { verdict: 'pass', notes: 'ok', cost_usd: 0.002 } });
  return { ok: true, shadow: true };
};
const rejectEvergreen: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject (sense 2): банальний гайд', critic: { verdict: 'reject', notes: 'банальний гайд', cost_usd: 0.002 } });
  return { ok: true, skipped: true, critic_rejected: true };
};

/** The runner with a scripted publish tool and the real EvergreenStep over a fake pool (`used` = evergreen today). */
function setup(script: Behaviour[], o: { used?: number; perDay?: number } = {}) {
  const st: any = { ...baseSlot, status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const inputs: any[] = [];
  const inbox: any[] = [];
  const queries: any[] = [];
  let current: Behaviour = shadow;
  const publish = { name: 'publish_post', kind: 'terminal', description: '', input: {} as any, roles: ['executor'], execute: async (input: any) => { inputs.push(input); return current(st, input); } };
  const plans = {
    reservedSlots: async () => [],
    getSlot: async () => ({ ...st }),
    updateSlot: async (_id: string, p: any) => { Object.assign(st, p); },
  };
  const step = new EvergreenStep({
    pool: { query: async (_sql: string, params: unknown[]) => { queries.push(params); return { rows: [{ n: o.used ?? 0 }] }; } } as any,
    plans, perDay: o.perDay ?? 1, inbox: { postOnce: async (i: any) => { inbox.push(i); return 1; } },
  });
  const runner = new EditorRunnerService({
    loop: {
      run: async (i: any) => {
        runs.push(i);
        current = script[runs.length - 1] ?? shadow;
        const tool = i.tools.find((t: any) => t.name === 'publish_post');
        const format = /Формат: (\w+)/.exec(i.user)?.[1] ?? 'text';
        const r = await tool.execute({ spec: { format, title: `Пост ${runs.length}`, source: { url: `https://src.example/${runs.length}` }, story: { followup_of: 'x', key: 'shcho-take-rag' } } }, {});
        return { runId: `r${runs.length}`, status: isToolError(r) ? 'max_steps' : 'ok', terminalTool: isToolError(r) ? undefined : 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
      },
    },
    registry: { forRole: () => [publish] as any },
    skills: new SkillLibrary(),
    plans,
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    ladder: { maxExtraSteps: 3 },
    fallbackEvergreen: (req) => step.run(req),
  });
  return { runner, st, runs, inputs, inbox, queries, card: makeCard() };
}

const fallbackOf = (st: any): SlotFallback => st.fallback;

test('evergreen: a slot with two critic rejections is filled by an evergreen post, marked by code', async () => {
  const s = setup([reject, reject, shadow]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 3);
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.map((x) => [x.step, x.outcome]), [['initial', 'critic_reject'], ['next_candidate', 'critic_reject'], ['evergreen', 'shadowed']]);
  assert.deepEqual([f.final?.outcome, f.final?.step], ['rescued', 'evergreen']);
  assert.equal(s.st.status, 'shadowed');
  // The writer's post is marked evergreen; the topic key stays, follow-up fields go.
  assert.deepEqual(s.inputs[2].spec.story, { kind: 'evergreen', key: 'shcho-take-rag' });
  assert.equal(s.inputs[0].spec.story.kind, undefined, 'the main post is not touched');
  // The evergreen run sees its own instruction and an evergreen topic (the critic judges against it).
  assert.match(s.runs[2].user, /Запасний крок \(evergreen\)/);
  assert.match(s.runs[2].user, /Тема: Вічнозелений пост у темі каналу \(Канал про космос\)/);
  assert.match(s.runs[2].user, /«щойно», «сьогодні», «новина»/);
  // The Inbox still hears about the main post.
  assert.equal(s.inbox.length, 1);
  assert.equal(s.inbox[0].kind, EVERGREEN_INBOX_KIND);
  assert.equal(s.inbox[0].refId, baseSlot.id);
  assert.match(s.inbox[0].body, /did not go out: critic_rejected: reject \(grounding 2\)/);
  // The cap was read for the slot's local day in the channel zone (Kyiv: 2026-10-12 00:00 = 21:00Z the day before).
  assert.equal(s.queries[0][0], '@chan');
  assert.equal((s.queries[0][1] as Date).toISOString(), '2026-10-11T21:00:00.000Z');
});

test('evergreen: a second evergreen in the same channel the same day is not created', async () => {
  const s = setup([reject, reject, shadow], { used: 1 });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2, 'no third (evergreen) run');
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.at(-1), { ...f.steps.at(-1)!, step: 'evergreen', outcome: 'unavailable', run_id: null });
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^critic_rejected: reject \(grounding 2\)/);
  assert.equal(s.inbox.length, 0);
  // Configurable: EDITOR_EVERGREEN_PER_DAY=2 lets the second one run; 0 switches the step off.
  const two = setup([reject, reject, shadow], { used: 1, perDay: 2 });
  await two.runner.runExecutor(baseSlot, two.card);
  assert.equal(two.st.status, 'shadowed');
  const off = setup([reject, reject, shadow], { perDay: 0 });
  await off.runner.runExecutor(baseSlot, off.card);
  assert.equal(off.runs.length, 2);
  assert.deepEqual([evergreenPerDay(() => undefined), evergreenPerDay(() => '2'), evergreenPerDay(() => '0'), evergreenPerDay(() => 'x')], [1, 2, 0, 1]);
});

test('evergreen: a rejected evergreen skips the slot with the MAIN post reason; its own reason is on its step', async () => {
  const s = setup([reject, reject, rejectEvergreen]);
  await s.runner.runExecutor(baseSlot, s.card);
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.at(-1)?.outcome, 'critic_reject');
  assert.match(f.steps.at(-1)?.reason ?? '', /банальний гайд/);
  assert.deepEqual([f.final?.outcome, f.final?.code, f.final?.step], ['skipped', 'exhausted', 'evergreen']);
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^critic_rejected: reject \(grounding 2\): цифр немає/);
  assert.equal(s.inbox.length, 0);
});

test('evergreen: platform slots are not filled (Telegram only)', async () => {
  const step = new EvergreenStep({ pool: { query: async () => ({ rows: [{ n: 0 }] }) } as any, plans: { getSlot: async () => null }, perDay: 1 });
  let ran = 0;
  const r = await step.run({ slot: { ...baseSlot, resourceRef: 'instagram:1' }, card: makeCard(), failure: { kind: 'critic_reject', code: 'critic_rejected', reason: 'x', notes: null, sourceUrl: null }, steps: [], run: async () => { ran++; return {} as any; } });
  assert.equal(r, null);
  assert.equal(ran, 0);
});

test('evergreen: the probe marks publish / lint inputs and keeps recording errors', async () => {
  assert.deepEqual(asEvergreenInput({ spec: { title: 't', story: { kind: 'followup', followup_of: 'a', new_facts: ['x'], key: 'k-1', event_at: '2026-10-13' } } }),
    { spec: { title: 't', story: { kind: 'evergreen', key: 'k-1' } } });
  assert.deepEqual(asEvergreenInput({ spec: { title: 't' } }), { spec: { title: 't', story: { kind: 'evergreen' } } });
  assert.equal(asEvergreenInput('raw'), 'raw');
  const seen: any[] = [];
  const mk = (name: string) => ({ name, kind: 'terminal', description: '', input: {} as any, roles: ['executor'], execute: async (i: any) => { seen.push([name, i]); return { error: 'story_repeat', details: 'тема вже була' }; } });
  const p = new EvergreenProbe();
  const [pub, lint, other] = p.wrap([mk('publish_post'), mk('lint_post'), mk('fetch_feed')] as any);
  await lint.execute({ spec: { title: 'a' } }, {} as any);
  await other.execute({ spec: { title: 'b' } }, {} as any);
  await pub.execute({ spec: { title: 'c', source: { url: 'https://x.example/a' } } }, {} as any);
  assert.deepEqual(seen.map(([n, i]) => [n, i.spec.story?.kind ?? null]), [['lint_post', 'evergreen'], ['fetch_feed', null], ['publish_post', 'evergreen']]);
  assert.deepEqual(p.last, { code: 'story_repeat', details: 'тема вже була' });
  assert.equal(p.source, 'https://x.example/a');
});

test('evergreen note: the content rules are in the writer prompt', () => {
  const n = evergreenNote({ failure: { kind: 'lint', code: 'lint_failed', reason: 'lint_failed: x', notes: null, sourceUrl: null }, original: { topic: 'Реліз GPT-6', format: 'photo' }, format: 'text' });
  assert.match(n, /основний пост слота \(«Реліз GPT-6»\) не вийшов — пост не пройшов lint/);
  assert.match(n, /Без джерела — жодних конкретних чисел/);
  assert.match(n, /постер з ai_posters, якщо його use_for збігається/);
  assert.match(n, /story: \{ kind: "evergreen"/);
  assert.match(n, /Формат: text/);
});

// ── the content check (lintPost runs it before publishing) ───────────────────

const evergreenSpec = (body: Array<{ type: string; text: string }>, over: Record<string, unknown> = {}) =>
  makeSpec({ format: 'text', media: [], body, story: { kind: 'evergreen', key: 'shcho-take-rag' }, ...over });
const lintOf = (spec: any) => lintPost(spec, makeCard(), { id: 's', channel: '@chan', publishedAt: NOW.toISOString(), timezone: 'Europe/Kyiv' });

test('evergreen check: news words are an error, unsourced numbers a warning, posts without the kind are not checked', () => {
  const dated = lintOf(evergreenSpec([{ type: 'lead', text: 'Що таке RAG і навіщо він потрібен' }, { type: 'p', text: 'Сьогодні розберемо, як модель шукає факти в документах.' }]));
  assert.ok(dated.errors.some((e) => e.code === 'evergreen_dated' && /Сьогодні/.test(e.message)), JSON.stringify(dated.errors));
  const fine = lintOf(evergreenSpec([{ type: 'lead', text: 'Що таке RAG і навіщо він потрібен' }, { type: 'p', text: 'Модель спершу шукає уривки в документах, а тоді відповідає за ними.' }]));
  assert.deepEqual(fine.errors.filter((e) => e.code.startsWith('evergreen')), []);
  assert.deepEqual(fine.warnings.filter((w) => w.code.startsWith('evergreen')), []);
  // Same text as a plain post: not checked («новина» is fine in news).
  const news = lintOf(makeSpec({ format: 'text', media: [], body: [{ type: 'p', text: 'Сьогодні вийшла новина про Вебб.' }] }));
  assert.deepEqual(news.errors.filter((e) => e.code.startsWith('evergreen')), []);

  const card = makeCard();
  const at = { id: 's', channel: '@chan', publishedAt: NOW.toISOString(), timezone: 'Europe/Kyiv', card };
  const numbers = evergreenSpec([{ type: 'p', text: 'RAG знижує кількість вигадок на 40% і заощаджує 2 млн доларів на рік.' }], { source: undefined });
  const f = evergreenCheck.run(auditPostFromSpec(numbers, at), { previous: [] });
  assert.deepEqual(f.map((x) => [x.code, x.level]), [['evergreen_unsourced_number', 'warning']]);
  assert.match(f[0].message, /40%/);
  // With a source line, or a page the run read, the numbers are T4's business.
  assert.deepEqual(evergreenCheck.run(auditPostFromSpec({ ...numbers, source: { url: 'https://docs.example/rag', label: 'Docs' } }, at), { previous: [] }), []);
  assert.deepEqual(evergreenCheck.run(auditPostFromSpec(numbers, at), { previous: [], sources: [{ url: 'https://docs.example/rag' }] }), []);
  // Years and small counts are not «specific numbers».
  const years = evergreenSpec([{ type: 'p', text: 'Ідею описали в 2020 році; ось 3 способи її застосувати.' }], { source: undefined });
  assert.deepEqual(evergreenCheck.run(auditPostFromSpec(years, at), { previous: [] }), []);
  for (const w of ['щойно', 'новина', 'вчора', 'нещодавно', 'прямо зараз', 'на цьому тижні']) {
    const p = auditPostFromSpec(evergreenSpec([{ type: 'p', text: `Пояснюємо просто: ${w} про це писали всі.` }]), at);
    assert.equal(evergreenCheck.run(p, { previous: [] })[0]?.code, 'evergreen_dated', w);
  }
  // An evergreen post is exempt from the news freshness threshold (stale_source), like an evergreen resource.
  const old = auditPostFromSpec(evergreenSpec([{ type: 'p', text: 'Пояснюємо, як працює стандарт Matter.' }], { source: { url: 'https://csa-iot.org/2024/01/05/matter-explained/', label: 'CSA' } }), at);
  const newsCard = { previous: [], card: { style: { content_kind: 'news' } } } as any;
  assert.deepEqual(datesCheck.run(old, newsCard).map((x) => x.code), []);
  assert.deepEqual(datesCheck.run({ ...old, story: {} }, newsCard).map((x) => x.code), ['stale_source']);
  // «новини» (plural, «агрегатор новин») is not an anchor.
  assert.deepEqual(evergreenCheck.run(auditPostFromSpec(evergreenSpec([{ type: 'p', text: 'Агрегатор новин збирає стрічки в одному місці.' }]), at), { previous: [] }), []);
});

test('evergreen codes: catalogued with their task, English owner text', () => {
  for (const c of evergreenCheck.codes) {
    assert.equal(INTEGRITY_CODES[c]?.task, 'T10', c);
    assert.ok(CODE_EXPLANATIONS[c]?.title && !/[а-яіїєґ]/i.test(CODE_EXPLANATIONS[c].explain + CODE_EXPLANATIONS[c].fix), c);
  }
});

// ── counted apart ────────────────────────────────────────────────────────────

test('digest: the evergreen share per resource per week, flagged above 25 %', () => {
  const post = (i: number, evergreen = false) => ({ slotId: `p${i}`, at: new Date(NOW.getTime() - i * 3600_000), status: 'shadowed', format: 'text', text: `Пост ${i}`, written: true, ...(evergreen ? { evergreen: true } : {}) });
  const caps = { pollsPerWeek: null, questionsPerDay: 1 } as any;
  const high = assembleQuality({ critic: [], posts: [post(1, true), post(2), post(3, true), post(4)], owner: [], caps });
  assert.deepEqual(high.evergreen, { posts: 4, evergreen: 2, share: 0.5, over: true });
  assert.ok(high.flags.includes('evergreen_share_high'));
  const ok = assembleQuality({ critic: [], posts: [post(1, true), post(2), post(3), post(4)], owner: [], caps });
  assert.deepEqual(ok.evergreen, { posts: 4, evergreen: 1, share: 0.25, over: false });
  assert.ok(!ok.flags.includes('evergreen_share_high'), 'exactly 25 % is not over');
  assert.equal(assembleQuality({ critic: [], posts: [], owner: [], caps }).evergreen, undefined);
  assert.ok((QUALITY_FLAGS as readonly string[]).includes('evergreen_share_high'));
  assert.deepEqual(evergreenShare(0, 0), { posts: 0, evergreen: 0, share: null, over: false });
});

test('live publish: an evergreen post lands in published_posts as strategy_type evergreen', async () => {
  const rows: any[] = [];
  const d: any = {
    plans: { insertPublication: async (i: any) => { rows.push(i); return 7; } },
    publisher: { send: async () => ({ messageIds: [11] }) }, recordPublish: () => {},
  };
  const r = { rendered: { messages: [], primary: 0, preview: 'p' }, prepared: {} } as any;
  const card = { linkStyle: 'inline', footer: null, crosspost: false } as any;
  await sendRendered(d, { channelKey: '@chan', spec: evergreenSpec([{ type: 'p', text: 'x' }]), card, sourceRef: null, mediaKey: 's', slotId: 's' }, r);
  await sendRendered(d, { channelKey: '@chan', spec: makeSpec(), card, sourceRef: null, mediaKey: 's', slotId: 's' }, r);
  await sendRendered(d, { channelKey: '@chan', spec: evergreenSpec([{ type: 'p', text: 'x' }]), card, sourceRef: null, mediaKey: 's', slotId: null, strategyType: 'chat' }, r);
  assert.deepEqual(rows.map((x) => x.strategyType ?? 'editor'), ['evergreen', 'editor', 'chat']);
});

test('inbox: a series slot an evergreen post filled is still a missed series slot, with the main reason', () => {
  const fallback: SlotFallback = {
    steps: [
      { step: 'initial', at: NOW.toISOString(), format: 'text', outcome: 'critic_reject', reason: 'critic_rejected: reject (sense 2): не про тему', verdict: 'reject', run_id: 'r1', cost_usd: 0.01 },
      { step: 'evergreen', at: NOW.toISOString(), format: 'text', outcome: 'shadowed', reason: null, verdict: 'pass', run_id: 'r2', cost_usd: 0.01 },
    ],
    final: { outcome: 'rescued', code: 'shadowed', step: 'evergreen', reason: null },
  };
  assert.deepEqual(evergreenFilled(fallback), { reason: 'critic_rejected: reject (sense 2): не про тему' });
  assert.equal(evergreenFilled({ ...fallback, final: { ...fallback.final!, step: 'next_candidate' } }), null);
  const slot: WatchSlot = {
    id: 'a', ref: 'telegram:@chan', scheduledAt: NOW, updatedAt: NOW, status: 'shadowed', error: null, format: 'text', topic: 'Серія',
    seriesName: 'Словник ШІ', scheduleRuleId: null, criticVerdict: 'pass', fallback,
  };
  const alerts = evaluateSilentDays({ now: new Date('2026-10-12T10:00:00Z'), resources: [{ ref: 'telegram:@chan', tz: 'Europe/Kyiv', minPerDay: 1 }], slots: [slot] });
  const miss = alerts.find((a) => a.kind === 'series_missed');
  assert.ok(miss, JSON.stringify(alerts));
  assert.match(miss!.body, /series "Словник ШІ" — filled by an evergreen post \(shadowed\); the main post: critic_rejected: reject \(sense 2\)/);
  assert.equal(alerts.some((a) => a.kind === 'dark_day'), false, 'the evergreen post went out');
});
