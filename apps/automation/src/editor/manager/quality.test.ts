/** Spec 034 FR-006 (T4): the MANAGER's quality block, the hash skip, the quality_check rule and the prompts (no LLM). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audienceCaps } from '../post/audience-asks';
import { assembleQuality, qualityActive, qualityMetricValue, slotText, SAMPLE_CHARS, type CriticRow, type OwnerRow, type PostRow, type ResourceQuality } from './quality-digest';
import { digestHash, digestView, DIGEST_LIMIT_CHARS, renderDigest, resourceView, type KpiDigest } from './kpi-digest.service';
import { canSkip, ManagerRunner, managerSystemPrompt } from './manager-runner';
import { buildDirectiveTools, checkQualityReview, fileDirective } from './directive-tools';
import { admitDirective, metricValue } from './directive-kinds';
import { buildManagerChatPrompt } from '../agents/agent-prompts';

const T0 = new Date('2026-10-10T12:00:00Z');
const at = (h: number) => new Date(T0.getTime() - h * 3600_000);
const scores = (o: Partial<Record<string, number>> = {}) => ({ ai_likeness: 4, sense: 5, voice: 4, grounding: 5, audience_asks: 5, format_fit: 4, ...o });
const crit = (id: string, h: number, verdict: string, extra: Record<string, unknown> = {}): CriticRow =>
  ({ slotId: id, at: at(h), critic: { verdict, scores: scores(), notes: `нотатка ${id}`, reason: 'r', ...extra } });
const post = (id: string, h: number, format: string, text: string, status = 'published'): PostRow =>
  ({ slotId: id, at: at(h), status, format, text, written: !['planned', 'running'].includes(status) });

const SLOP_POST = 'Друзі, давайте розберемося! А ви коли-небудь задумувались, як змінився світ? Як думаєте, що буде далі? Напишіть у коментарях!';

function quality(): ResourceQuality {
  return assembleQuality({
    critic: [
      crit('s1', 1, 'reject', { scores: scores({ sense: 1 }), notes: 'Безглуздий текст, не про тему джерела' }),
      crit('s2', 2, 'pass', { history: [{ verdict: 'revise', notes: 'Штампи «давайте розберемося»', pass: 1 }] }),
      crit('s3', 3, 'revise', { notes: 'Жарт при вимкненому гуморі' }),
      crit('s4', 4, 'pass'),
      crit('s5', 5, 'error', { scores: null, notes: '', reason: 'timeout' }),
    ],
    posts: [
      post('p1', 1, 'text', SLOP_POST),
      post('p2', 2, 'poll', 'Опитування тижня'),
      post('p3', 3, 'quiz', 'Вікторина'),
      post('p4', 4, 'photo', 'Звичайний пост без питань. '.repeat(40), 'awaiting_approval'),
      post('p5', -10, 'poll', '', 'planned'),
    ],
    owner: [
      { slotId: 'o1', at: at(5), outcome: 'rejected', reason: 'Забагато опитувань', edit: null },
      { slotId: 'o2', at: at(6), outcome: 'edited', reason: null, edit: 'Власник відредагував пост «X»: прибрав: «Друзі, давайте розберемося»' },
      { slotId: 'o3', at: at(7), outcome: 'clean', reason: null, edit: null },
    ] as OwnerRow[],
    caps: audienceCaps(null),
  });
}

test('quality block: critic counts, pass rate, means, notes; polls vs cap; reader questions; owner; samples; flags', () => {
  const q = quality();
  assert.deepEqual([q.critic.pass, q.critic.revise, q.critic.reject, q.critic.failed, q.critic.total], [2, 1, 1, 1, 5]);
  assert.equal(q.critic.pass_rate, 0.5);
  assert.equal(q.critic.revised_then_passed, 1);
  assert.equal(q.critic.mean?.sense, 4, 'mean over the verdicts with scores: (1+5+5+5)/4');
  assert.equal(q.critic.notes.length, 3);
  assert.match(q.critic.notes[0], /^reject: Безглуздий/);
  assert.match(q.critic.notes[1], /^revise→pass: Штампи/);
  assert.deepEqual([q.polls.count, q.polls.slots, q.polls.cap, q.polls.over], [3, 5, 1, true], 'a planned poll counts against the weekly cap');
  assert.equal(q.reader_questions.cap, 1);
  assert.equal(q.reader_questions.over_cap, 1);
  assert.match(q.reader_questions.examples[0], /Як думаєте/);
  assert.deepEqual([q.owner.rejected, q.owner.edited, q.owner.approved], [1, 1, 2]);
  assert.equal(q.owner.rejection_rate, 0.333);
  assert.deepEqual(q.owner.reasons, ['Забагато опитувань']);
  assert.match(q.owner.edits[0], /прибрав/);
  assert.equal(q.posts, 4);
  assert.equal(q.samples.length, 3);
  assert.equal(q.samples[0].text.startsWith('Друзі'), true, 'newest first');
  assert.ok(new Set(q.samples.map((s) => s.status)).has('published'));
  assert.deepEqual(q.flags, ['critic_reject', 'critic_low_pass', 'critic_failed', 'polls_over_cap', 'reader_questions_over_cap', 'owner_rejections', 'owner_edits']);
  assert.deepEqual([q.signature.issue, q.signature.owner], ['s1:reject', 'o1:rejected']);
  assert.equal(qualityActive(q), true);
  assert.equal(qualityMetricValue(q, 'critic_pass_rate'), 50);
  assert.equal(qualityMetricValue(q, 'poll_share'), 60);
  assert.equal(qualityMetricValue(q, 'owner_rejection_rate'), 33.3);
  const long = assembleQuality({ critic: [], owner: [], caps: audienceCaps(null), posts: [post('x', 1, 'text', 'а'.repeat(2000))] });
  assert.ok(long.samples[0].text.length <= SAMPLE_CHARS);
  const quiet = assembleQuality({ critic: [], posts: [], owner: [], caps: audienceCaps(null) });
  assert.equal(qualityActive(quiet), false);
  assert.deepEqual(quiet.flags, []);
  assert.equal(qualityMetricValue(quiet, 'critic_pass_rate'), null);
});

test('slot text: caption, blocks (links and bold stripped), else the rendered preview; forwards are empty', () => {
  assert.equal(slotText({ caption: 'Підпис' }, null), 'Підпис');
  assert.equal(slotText({ body: [{ type: 'lead', text: 'Лід **жирний**' }, { type: 'list', items: ['a', 'b'] }, { type: 'p', text: '[тут](https://x.y)' }] }, null), 'Лід жирний\na\nb\nтут');
  assert.equal(slotText(null, '<b>Привіт</b> &amp; все'), 'Привіт & все');
  assert.equal(slotText(null, '↪️ Forwarded @a/1 → 2'), '');
});

function digest(q: ResourceQuality | null, o: Partial<KpiDigest> = {}): KpiDigest {
  return {
    generatedAt: T0.toISOString(), today: '2026-10-10', agents: [], budget: { spentTodayUsd: 0, capUsd: 3 },
    directives: { open: [], outcomes: [] }, hash: '', raw: new Map(),
    resources: [{ ref: 'telegram:@space', title: 'Space', agent: 'kira', health: 'ok', kpis: { views_per_post: { v: 100 } } as any, anomalies: [], quality: q }],
    ...o,
  };
}

test('hash skip: unchanged digest skips; a new critic reject / owner rejection / cap overflow is never skipped', () => {
  const base = assembleQuality({ critic: [crit('a', 3, 'pass')], posts: [post('p', 3, 'text', 'Текст')], owner: [], caps: audienceCaps(null) });
  const h0 = digestHash(digest(base));
  assert.equal(h0, digestHash(digest(assembleQuality({ critic: [crit('a', 3, 'pass')], posts: [post('p', 3, 'text', 'Текст')], owner: [], caps: audienceCaps(null) }))));
  const d0 = { ...digest(base), hash: h0 };
  assert.equal(canSkip({ digestHash: h0 }, d0), true);
  assert.equal(canSkip(null, d0), false);
  assert.equal(canSkip({ digestHash: h0 }, { ...d0, resources: d0.resources.map((r) => ({ ...r, anomalies: ['views_per_post'] })) }), false, 'anomalies always get a look');

  const variants: Array<[string, ResourceQuality]> = [
    ['critic reject', assembleQuality({ critic: [crit('a', 3, 'pass'), crit('b', 1, 'reject')], posts: [post('p', 3, 'text', 'Текст')], owner: [], caps: audienceCaps(null) })],
    ['critic revise', assembleQuality({ critic: [crit('a', 3, 'pass'), crit('b', 1, 'revise')], posts: [post('p', 3, 'text', 'Текст')], owner: [], caps: audienceCaps(null) })],
    ['owner rejection', assembleQuality({ critic: [crit('a', 3, 'pass')], posts: [post('p', 3, 'text', 'Текст')], owner: [{ slotId: 'o', at: at(1), outcome: 'rejected', reason: 'нудно', edit: null }], caps: audienceCaps(null) })],
    ['owner edit', assembleQuality({ critic: [crit('a', 3, 'pass')], posts: [post('p', 3, 'text', 'Текст')], owner: [{ slotId: 'o', at: at(1), outcome: 'edited', reason: null, edit: 'x' }], caps: audienceCaps(null) })],
    ['poll cap overflow', assembleQuality({ critic: [crit('a', 3, 'pass')], posts: [post('p', 3, 'text', 'Текст'), post('q1', 2, 'poll', ''), post('q2', 1, 'quiz', '')], owner: [], caps: audienceCaps(null) })],
  ];
  for (const [name, q] of variants) {
    const d = digest(q);
    const h = digestHash(d);
    assert.notEqual(h, h0, name);
    assert.equal(canSkip({ digestHash: h0 }, { ...d, hash: h }), false, name);
  }
  // A clean approval or a second pass does not change the signature (no new issue, no new flag).
  const calm = assembleQuality({ critic: [crit('a', 3, 'pass'), crit('c', 1, 'pass')], posts: [post('p', 3, 'text', 'Текст')], owner: [{ slotId: 'o', at: at(1), outcome: 'clean', reason: null, edit: null }], caps: audienceCaps(null) });
  assert.equal(digestHash(digest(calm)), h0);
});

test('manager run: a changed quality signature calls the LLM even without anomalies', async () => {
  const runs: any[] = [];
  const q0 = assembleQuality({ critic: [crit('a', 3, 'pass')], posts: [post('p', 3, 'text', 'Текст')], owner: [], caps: audienceCaps(null) });
  const q1 = assembleQuality({ critic: [crit('a', 3, 'pass'), crit('b', 1, 'reject')], posts: [post('p', 3, 'text', 'Текст')], owner: [], caps: audienceCaps(null) });
  const make = (q: ResourceQuality) => { const d = digest(q); return { ...d, hash: digestHash(d) }; };
  const reviews: any[] = [];
  let current = make(q0);
  const runner = new ManagerRunner({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'submit_review', totals: {} as any } as any; } },
    registry: { forRole: () => [] }, runtime: { forAgent: async () => ({ skills: { get: () => undefined, list: () => [] } }) as any },
    agents: { findTop: async () => null, get: async () => null, list: async () => [] } as any,
    repo: { lastReview: async () => ({ verdict: 'continue', digestHash: make(q0).hash, createdAt: T0 }), addReview: async (r: any) => { reviews.push(r); }, memory: async () => [] } as any,
    digest: { build: async () => current, render: (d) => renderDigest(d), snapshot: async () => 1 }, inbox: { post: async () => 1 }, env: () => undefined,
  });
  const m = { id: 'm', handle: 'manager', name: 'Manager', mode: 'live' } as any;
  assert.deepEqual(await runner.run(m), { skipped: 'digest unchanged, no anomalies' });
  assert.equal(runs.length, 0);
  current = make(q1);
  await runner.run(m);
  assert.equal(runs.length, 1, 'a new critic reject is never skipped');
  assert.match(runs[0].system, /critic_reject/, 'the quality block reaches the prompt');
  assert.match(runs[0].user, /якість контенту/);
});

test('render: bounded; quiet resources lose samples first, flagged ones keep their quality block', () => {
  const flaggedQ = quality();
  const calmQ = assembleQuality({ critic: [crit('a', 1, 'pass')], posts: Array.from({ length: 3 }, (_, i) => post(`c${i}`, i, 'text', 'Спокійний текст. '.repeat(60))), owner: [], caps: audienceCaps(null) });
  const resources = Array.from({ length: 30 }, (_, i) => ({
    ref: `telegram:@r${i}`, title: `R${i}`, agent: 'kira', health: 'ok', kpis: { views_per_post: { v: 1, base: 1, d: 0, z: 0 } } as any, anomalies: [] as string[],
    quality: i === 7 ? flaggedQ : calmQ,
  }));
  const d = digest(null, { resources });
  const full = JSON.stringify({ ...d, raw: undefined, hash: undefined });
  assert.ok(full.length > DIGEST_LIMIT_CHARS, `fixture must overflow (${full.length})`);
  const out = renderDigest(d);
  assert.ok(out.length <= DIGEST_LIMIT_CHARS, `${out.length}`);
  const parsed = JSON.parse(out);
  const f = parsed.resources.find((r: any) => r.ref === 'telegram:@r7');
  assert.deepEqual(f.quality.flags, flaggedQ.flags);
  assert.ok(f.quality.critic.notes.length > 0);
  const calm = parsed.resources.find((r: any) => r.ref === 'telegram:@r0');
  assert.ok(!calm.quality || calm.quality.samples.length === 0, 'a calm resource has no samples when the digest is tight');
  // Small digests stay complete.
  const small = JSON.parse(renderDigest(digest(flaggedQ)));
  assert.equal(small.resources[0].quality.samples.length, 3);
});

// ── quality_check (submit_review) ────────────────────────────────────────────

const ev = 'Критик: 2 pass / 1 revise / 1 reject, pass rate 50%, опитувань 3 при ліміті 1';
const reviewDigest = () => {
  const d = digest(quality());
  d.resources.push({ ref: 'instagram:42', title: null, agent: 'kira', health: 'ok', kpis: {} as any, anomalies: [], quality: assembleQuality({ critic: [], posts: [], owner: [], caps: audienceCaps(null) }) });
  return { ...d, hash: digestHash(d) };
};

test('quality_check: every active resource with evidence; flags cannot be "ok" silently; continue over an issue needs a note', () => {
  const dg = reviewDigest();
  const issue = { resource_ref: 'telegram:@space', status: 'issue' as const, evidence: ev, issues: ['ai_likeness' as const, 'audience_asks' as const] };
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [] }, dg)?.error, 'quality_check_missing', 'an inactive resource (instagram) is not required, the active one is');
  assert.equal(checkQualityReview({ verdict: 'directives', quality_check: [{ ...issue, resource_ref: 'telegram:@ghost' }] }, dg)?.error, 'quality_check_unknown');
  assert.equal(checkQualityReview({ verdict: 'directives', quality_check: [{ ...issue, evidence: 'усе виглядає нормально, тексти хороші' }] }, dg)?.error, 'quality_evidence_required');
  assert.equal(checkQualityReview({ verdict: 'directives', quality_check: [{ ...issue, issues: [] }] }, dg)?.error, 'quality_issues_required');
  const ok = { resource_ref: 'telegram:@space', status: 'ok' as const, evidence: ev, issues: [] };
  const flags = checkQualityReview({ verdict: 'continue', quality_check: [ok] }, dg);
  assert.equal(flags?.error, 'quality_flags_ignored');
  assert.match(flags!.details, /polls_over_cap/);
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [issue] }, dg)?.error, 'quality_issue_unaddressed');
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [{ ...issue, note: 'порада voice_fix уже відкрита з учора' }] }, dg), null);
  assert.equal(checkQualityReview({ verdict: 'directives', quality_check: [issue] }, dg), null);
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [{ ...ok, note: 'опитування — серія власника, ліміт не діє' }] }, dg), null);
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [{ ...ok, evidence: 'Зразок «Друзі, давайте розберемося» — штамп' , status: 'issue', issues: ['ai_likeness'], note: 'порада voice_fix уже відкрита з учора' }] }, dg), null, 'a quote is evidence too');
});

test('submit_review: the tool requires quality_check, refuses a review without the checklist and stores it', async () => {
  const reviews: any[] = [];
  const dg = reviewDigest();
  const tools = buildDirectiveTools({
    repo: { addReview: async (r: any) => { reviews.push(r); } } as any,
    agents: { getByHandle: async () => null, findTop: async () => null } as any,
    digest: { build: async () => dg, render: () => '{}' }, inbox: { post: async () => 1 }, memory: { listActive: async () => [] }, actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => null,
  });
  const submit = tools.find((t) => t.name === 'submit_review')!;
  assert.equal(submit.input.safeParse({ verdict: 'continue', summary: 'Все гаразд' }).success, false, 'quality_check is a required field');
  const ctx = { runId: 'r', role: 'manager' as const, channelKey: null, extras: { digest: dg } } as any;
  const bad: any = await submit.execute(submit.input.parse({ verdict: 'continue', summary: 'Проблем немає', quality_check: [] }), ctx);
  assert.equal(bad.error, 'quality_check_missing');
  assert.equal(reviews.length, 0);
  const good: any = await submit.execute(submit.input.parse({
    verdict: 'directives', summary: 'Подав voice_fix для @space', directive_ids: [],
    quality_check: [{ resource_ref: 'telegram:@space', status: 'issue', evidence: ev, issues: ['ai_likeness', 'owner_feedback'] }],
  }), ctx);
  assert.equal(good.ok, true);
  assert.equal(reviews[0].qualityCheck[0].status, 'issue');
  assert.equal(reviews[0].digestHash, dg.hash);
});

// ── prompts and the skill ────────────────────────────────────────────────────

const SKILLS = join(__dirname, '../../../editor-skills');
const CONTINUE_IS_NORMAL = /нормальн\p{L}* (?:і частий )?(?:результат|відповід)|правильна відповідь для більшості|«продовжуйте» за замовчуванням|continue is the normal/iu;

test('prompts: "continue" is no longer the normal answer; the checklist and "no micromanagement" are there', () => {
  const skills = { get: (n: string) => ({ name: n, body: readFileSync(join(SKILLS, `${n}.md`), 'utf8') }), list: () => [] } as any;
  const sys = managerSystemPrompt({ agent: { name: 'Manager', handle: 'manager' } as any, now: T0, digest: '{}', memory: '', skills: { inline: '', listed: '' } });
  const chat = buildManagerChatPrompt({ now: T0, skills, agent: { name: 'Manager', handle: 'manager' } as any, digest: '{}' });
  const workflow = readFileSync(join(SKILLS, 'manager-workflow.md'), 'utf8');
  const tools = buildDirectiveTools({ repo: {} as any, agents: {} as any, digest: {} as any, inbox: {} as any, memory: {} as any, actions: {} as any, channelKeyOf: async () => null });
  const descr = tools.filter((t) => ['file_directive', 'submit_review'].includes(t.name)).map((t) => t.description).join('\n');
  for (const [name, text] of [['system', sys], ['chat', chat], ['manager-workflow', workflow], ['tools', descr]] as const) {
    assert.doesNotMatch(text, CONTINUE_IS_NORMAL, name);
  }
  assert.match(sys, /quality_check/);
  assert.match(sys, /мікроменедж/);
  assert.match(chat, /якість текстів/);
  for (const item of ['ШІ-подібність', 'Сенс', 'Голос і гумор', 'Опитування й питання', 'Власник', 'Формат', 'voice_fix', 'format_mix', 'quality_check', 'Не мікроменеджь']) {
    assert.ok(workflow.includes(item), item);
  }
  assert.ok(workflow.length <= 6_000);
});

// ── matrix / admission for the quality kinds ─────────────────────────────────

test('quality metrics: metricValue reads the quality block; a voice_fix directive needs escalation (never an anomaly)', () => {
  const dg = digest(quality());
  assert.equal(metricValue(dg, 'kira', 'critic_pass_rate'), 50);
  assert.equal(metricValue(dg, 'kira', 'poll_share', 'telegram:@space'), 60);
  const base = { binding: 'directive' as const, structural: false, ownerApproved: false, targetHandle: 'kira', digest: dg, openBinding: 0 };
  const expected = { metric: 'critic_pass_rate' as const, direction: 'up' as const, min_change_pct: 20 };
  assert.equal((admitDirective({ ...base, expected, declined: null }) as any).error, 'directive_needs_anomaly');
  // Advice of the same kind declined at 60 % pass rate; now 50 % — moved further against expected → escalation.
  const esc = admitDirective({ ...base, expected, declined: { id: 'adv', expected, filedValue: 60 } });
  assert.equal((esc as any).basis, 'escalation');
  assert.equal((admitDirective({ ...base, expected, declined: { id: 'adv', expected, filedValue: 52 } }) as any).error, 'directive_needs_anomaly', 'a 4 % move is not enough');
  assert.equal((admitDirective({ ...base, binding: 'advice', expected, declined: null }) as any).basis, 'advice');
});

test('file_directive: a quality metric without data in the window is refused (stale_metric)', async () => {
  const inserted: any[] = [];
  const deps = {
    repo: {
      openFor: async () => null, appliedFor: async () => null, lastRejected: async () => null, countForRun: async () => 0, countOpenBinding: async () => 0, lastDeclinedAdvice: async () => null,
      insert: async (x: any) => { inserted.push(x); return { id: 'd1', ...x }; }, update: async () => null,
    } as any,
    agents: { getByHandle: async () => ({ id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null }), findTop: async () => null } as any,
    digest: { build: async () => ({}) as any, render: () => '{}' }, inbox: { post: async () => 1 }, memory: { listActive: async () => [] }, actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => '@space',
  };
  const i = {
    to: '@kira', kind: 'voice_fix' as const, binding: 'advice' as const, body: 'Прибрати штампи й жарти з постів @space', params: { resource_ref: 'telegram:@space', rules: ['Без звертань «друзі» і без «давайте розберемося»'] },
    rationale: 'Критик відхилив 1 з 4 постів, власник відхилив пост через штампи', evidence: { critic_pass_rate: 50, owner_rejected: 1 },
    expected: { metric: 'critic_pass_rate' as const, direction: 'up' as const, min_change_pct: 20, resource_ref: 'telegram:@space' }, review_in_days: 7,
  };
  const empty = digest(assembleQuality({ critic: [], posts: [], owner: [], caps: audienceCaps(null) }));
  assert.equal(((await fileDirective(deps, i, { from: null, runId: null, shadow: false, digest: empty })) as any).error, 'stale_metric');
  const ok: any = await fileDirective(deps, i, { from: null, runId: null, shadow: false, digest: digest(quality()) });
  assert.equal(ok.ok, true);
  assert.equal(inserted[0].outcomeDetail.at_filing.value, 50, 'the escalation baseline is the quality value at filing');
});

test('037 T4: the quality block shows the share of sources by tier per resource and the most cited domains', () => {
  const src = (id: string, h: number, url: string | null, status = 'published'): PostRow => ({ ...post(id, h, 'text', 'текст', status), sourceUrl: url });
  const q = assembleQuality({
    critic: [], owner: [], caps: audienceCaps(null),
    posts: [
      src('a', 1, 'https://www.marktechpost.com/2026/10/13/a/'), src('b', 2, 'https://www.marktechpost.com/2026/10/12/b/'),
      src('c', 3, 'https://developers.googleblog.com/en/x/'), src('d', 4, 'https://techcrunch.com/2026/10/06/c/'),
      src('e', 5, 'https://faktypro.com.ua/page/20-cikavih-faktiv'), src('f', 6, null), src('g', 7, 'https://a.example/x', 'planned'),
    ],
  });
  assert.deepEqual(q.sources!.counts, { primary: 1, media: 1, aggregator: 2, low: 1, unknown: 0 });
  assert.equal(q.sources!.total, 5, 'written posts with a URL source only');
  assert.equal(q.sources!.share!.aggregator, 0.4);
  assert.deepEqual(q.sources!.top[0], { host: 'marktechpost.com', n: 2, tier: 'aggregator' });
  assert.equal(assembleQuality({ critic: [], owner: [], caps: audienceCaps(null), posts: [post('x', 1, 'text', 'т')] }).sources, undefined);
});

// ── Spec 046 FR-001/FR-002: the digest is always valid JSON; the gate asks only for what the render shows ─────

const heavyDigest = (n: number, flaggedEvery = 1) => {
  const flaggedQ = quality();
  const resources = Array.from({ length: n }, (_, i) => ({
    ref: `telegram:@r${i}`, title: `R${i}`, agent: `a${i}`, health: 'ok', kpis: { views_per_post: { v: 1, base: 1, d: 0, z: 0 } } as any,
    anomalies: i % 3 === 0 ? ['views_per_post_low'] : [] as string[], quality: i % flaggedEvery === 0 ? flaggedQ : null,
  }));
  const open = Array.from({ length: 20 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, to: `a${i}`, kind: 'voice_fix', status: 'new', body: 'Б'.repeat(200), createdAt: T0.toISOString() }));
  const outcomes = Array.from({ length: 20 }, (_, i) => ({ to: `a${i}`, kind: 'format_mix', outcome: 'improved', body: 'О'.repeat(160), detail: { before: 1, after: 2, note: 'x'.repeat(400) } }));
  const compliance = Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, advice_followed: 1, advice_declined: 2, decline_reasons: [{ kind: 'data', reason: 'r'.repeat(160) }], contested: 0, auto_applied: 0 }));
  return digest(null, { resources, directives: { open, outcomes }, compliance, config_conflicts: [{ agent: 'a1', ref: 'telegram:@r1', code: 'hashtag_while_off', detail: 'd' }] });
};

test('render: always valid JSON under the limit; the head (budget, directives, conflicts) survives; omitted resources are named', () => {
  for (const n of [1, 10, 40, 120]) {
    const d = heavyDigest(n);
    for (const limit of [DIGEST_LIMIT_CHARS, 8_000, 3_000]) {
      const v = digestView(d, limit);
      assert.ok(v.text.length <= limit, `n=${n} limit=${limit}: ${v.text.length}`);
      const o = JSON.parse(v.text);
      assert.deepEqual(o.budget, d.budget, `n=${n} limit=${limit}`);
      if (limit >= 8_000) {
        assert.equal(o.directives.open.length, 20, 'open directives are never dropped while they fit');
        assert.ok(o.config_conflicts?.length === 1);
      }
      const shown = new Set<string>([...(o.resources ?? []).map((r: any) => r.ref), ...(o.quiet ?? []), ...(o.resources_omitted ?? [])]);
      for (const r of d.resources) assert.ok(shown.has(r.ref), `n=${n} limit=${limit}: ${r.ref} is listed somewhere`);
      for (const ref of v.detailed) assert.ok(o.resources.find((r: any) => r.ref === ref)?.quality?.flags, `${ref} is detailed → its flags are in the text`);
    }
  }
  assert.equal(digestView(digest(quality())).level, 0, 'a small digest is complete');
  assert.doesNotMatch(renderDigest(heavyDigest(120), 3_000), /обрізано/);
});

test('get_kpi_digest: no args parses; {resource} returns one block with its open directives', async () => {
  const d = heavyDigest(60);
  const tools = buildDirectiveTools({ digest: { build: async () => d, render: (x: KpiDigest) => renderDigest(x) } } as any);
  const t = tools.find((x) => x.name === 'get_kpi_digest')!;
  const ctx = { extras: {}, role: 'manager' } as any;
  const all = await t.execute({}, ctx) as any;
  assert.ok(all.budget && Array.isArray(all.resources));
  const one = await t.execute({ resource: '@r7' }, ctx) as any;
  assert.equal(one.resource.ref, 'telegram:@r7');
  assert.ok(one.resource.quality.samples.length > 0, 'the single view keeps samples');
  assert.deepEqual(one.open_directives.map((x: any) => x.to), ['a7']);
  assert.equal((await t.execute({ resource: 'telegram:@nope' }, ctx) as any).error, 'unknown_resource');
  assert.equal(resourceView(d, 'telegram:@r3')?.ref, 'telegram:@r3');
});

test('quality_check (046): stubbed / left-out, young and agentless resources are exempt; all problems come back at once', () => {
  // 120 flagged resources do not fit: the render leaves some out — those are not required.
  const big = heavyDigest(120);
  const v = digestView(big);
  assert.ok(v.detailed.size < big.resources.length, 'fixture must leave resources out');
  const entries = [...v.detailed].map((ref) => ({ resource_ref: ref, status: 'issue' as const, evidence: ev, issues: ['voice' as const] }));
  assert.equal(checkQualityReview({ verdict: 'directives', quality_check: entries }, big), null);
  // Young: < 5 posts and no flag.
  const youngQ = assembleQuality({ critic: [crit('a', 1, 'pass')], posts: [post('p', 1, 'text', 'Текст')], owner: [], caps: audienceCaps(null) });
  assert.equal(youngQ.flags.length, 0);
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [] }, digest(youngQ)), null, 'a young quiet resource is not required');
  // Agentless: an "ok" over flags is not held against it.
  const agentless = digest(quality());
  agentless.resources[0].agent = null;
  assert.equal(checkQualityReview({ verdict: 'continue', quality_check: [{ resource_ref: 'telegram:@space', status: 'ok', evidence: ev, issues: [] }] }, agentless), null);
  // Every problem at once.
  const dg = reviewDigest();
  const r = checkQualityReview({ verdict: 'continue', quality_check: [
    { resource_ref: 'telegram:@ghost', status: 'ok', evidence: ev, issues: [] },
    { resource_ref: 'telegram:@space', status: 'issue', evidence: 'усе виглядає нормально', issues: [] },
  ] }, dg);
  assert.deepEqual(r?.problems?.map((p) => p.error), ['quality_check_unknown', 'quality_evidence_required', 'quality_issues_required', 'quality_issue_unaddressed']);
  assert.equal(r?.error, 'quality_check_unknown');
});
