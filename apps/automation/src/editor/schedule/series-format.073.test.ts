/**
 * Spec 073 FR-002 (A20, A21, A22): the series is authoritative for its slots' format. `lockSeriesFormats` rewrites a submitted
 * series slot to the series' format and reports it; both plan validators exempt series slots from the card and section
 * weights (an improvised slot is still governed by them); the playbook validator checks a series format against what the
 * platform implements and a section key only when its weight is above 0; lint honours the schedule's `lockedFormat`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockedFormatsNote, lockSeriesFormats, type PlanScheduleCtx } from './plan-schedule-rules';
import { validatePlan } from '../roles/plan-rules';
import { validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema, validatePlaybook, type Playbook } from '../network/playbook';
import type { NetworkCtx } from '../network/network-context';
import { lintPost } from '../post/lint-post';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { buildRoleTools, type RoleToolDeps } from '../tools/role-tools';
import { buildNetworkTools } from '../network/network-tools';
import { isFail, ScheduleService, type ScheduleScope } from './schedule.service';

const CH = '@pdr';
const TG = `telegram:${CH}`;
const TH = 'threads:th1';
const DATE = '2026-10-07'; // Wednesday
const NOW = new Date('2026-10-07T04:00:00Z'); // 07:00 Kyiv
const QUIZ = { name: 'Білети ПДР', cadence: 'daily@12:00', resource_ref: TG, format: 'quiz', brief: 'Один квиз із білета щодня', locked: true, origin: 'owner' };
const THQ = { name: 'Білети ПДР', cadence: 'daily@12:00', resource_ref: TH, format: 'th_text', brief: 'Той самий випуск у Threads', locked: true, origin: 'owner' };

const playbook = (series: unknown[] = [QUIZ], formats: Record<string, number> = { text: 1, quiz: 0 }): Playbook => PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats, per_day: { min: 1, max: 4 } }],
  series,
});

// ── lockSeriesFormats (A21) ──────────────────────────────────────────────────────────────────

const slot = (time: string, format: string, extra: Record<string, unknown> = {}) =>
  ({ time, format, topic: 'Тема поста про дорожні знаки', source_hints: [] as string[], is_experiment: false, ...extra });

test('lockSeriesFormats: a single plan (no resource_ref) takes the series\' format, by the field or by the hint; the report indexes the submitted array', () => {
  const series = playbook([QUIZ]).series;
  const slots = [slot('10:00', 'text'), slot('12:00', 'text', { series: 'Білети ПДР' }), slot('15:00', 'photo', { source_hints: ['series:Білети ПДР'] }), slot('16:00', 'quiz', { series: 'Білети ПДР' })];
  const r = lockSeriesFormats(slots, series, TG);
  assert.deepEqual(r.slots.map((s) => s.format), ['text', 'quiz', 'quiz', 'quiz']);
  assert.deepEqual(r.changed, [{ i: 1, from: 'text', to: 'quiz' }, { i: 2, from: 'photo', to: 'quiz' }]);
  assert.equal(slots[1].format, 'text', 'the input is not mutated');
  assert.equal(r.slots[0], slots[0], 'an unchanged slot is the same object');
});

test('lockSeriesFormats: a slot that names an unknown series is left unchanged', () => {
  const r = lockSeriesFormats([slot('12:00', 'text', { series: 'Нема такої' })], playbook([QUIZ]).series, TG);
  assert.deepEqual(r.changed, []);
  assert.equal(r.slots[0].format, 'text');
});

test('lockSeriesFormats: a network plan where one name exists on two resources matches by name and resource first, then by name alone', () => {
  const series = playbook([QUIZ, THQ]).series;
  const slots = [
    { ...slot('12:00', 'text', { series: 'Білети ПДР' }), resource_ref: TG },
    { ...slot('12:10', 'text', { series: 'Білети ПДР' }), resource_ref: TH },
    { ...slot('12:20', 'text', { series: 'Білети ПДР' }), resource_ref: 'threads:other' }, // no such resource: the first series of that name
  ];
  const r = lockSeriesFormats(slots, series, TG);
  assert.deepEqual(r.slots.map((s) => s.format), ['quiz', 'th_text', 'quiz']);
  assert.deepEqual(r.changed.map((c) => c.i), [0, 1, 2]);
});

test('lockedFormatsNote names each changed slot; no change, no note', () => {
  const slots = [slot('12:00', 'text', { series: 'Білети ПДР' })];
  assert.equal(lockedFormatsNote(slots, []), null);
  const note = lockedFormatsNote(slots, [{ i: 0, from: 'text', to: 'quiz' }]);
  assert.match(note!, /слот 1 \(12:00, серія «Білети ПДР»\): text → quiz/);
  assert.match(note!, /серія/);
});

// ── the validators (A20) ─────────────────────────────────────────────────────────────────────

const card = makeCard({ channelKey: CH, postsPerDayMin: 1, postsPerDayMax: 4, formats: { text: 1, photo: 1 } }); // the card has no quiz
const ctxOf = (pb: Playbook): PlanScheduleCtx => ({
  planDate: DATE, defaultRef: TG, now: NOW,
  clocks: { [TG]: { tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 }, gapMin: 60 } },
  rules: [], pins: [], series: pb.series, checkSlotSeries: true,
});
const errorsOf = (v: { ok: boolean }) => (v.ok ? '' : (v as any).errors.join('\n'));

test('validatePlan: the @pdr case — card without quiz, quiz series — plans as a quiz; an improvised quiz is still refused', () => {
  const pb = playbook();
  const ok = validatePlan({ rationale: 'Квиз дня з білетів', slots: [slot('12:00', 'quiz', { series: 'Білети ПДР' })] }, card, DATE, NOW, [], ctxOf(pb));
  assert.equal(ok.ok, true, errorsOf(ok));
  if (ok.ok) assert.equal(ok.slots[0].format, 'quiz');
  const improvised = validatePlan({ rationale: 'Квиз дня з білетів', slots: [slot('12:00', 'quiz', { series: 'Білети ПДР' }), slot('15:00', 'quiz')] }, card, DATE, NOW, [], ctxOf(pb));
  assert.equal(improvised.ok, false);
  assert.match(errorsOf(improvised), /слот 2 \(15:00\): формат quiz не дозволений/);
  assert.ok(!/слот 1 \(12:00\): формат/.test(errorsOf(improvised)), 'the series slot is not named');
});

test('validatePlan: a series slot is still refused when the format cannot be produced here (formatOk)', () => {
  const pb = playbook();
  const v = validatePlan({ rationale: 'Квиз дня з білетів', slots: [slot('12:00', 'quiz', { series: 'Білети ПДР' })] }, card, DATE, NOW, [], ctxOf(pb), [], undefined, undefined, (f) => f !== 'quiz');
  assert.equal(v.ok, false);
  assert.match(errorsOf(v), /формат quiz серії «Білети ПДР» зараз неможливий тут/);
});

const net = (pb: Playbook): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: CH, groupId: 'g1', groupName: 'ПДР', mode: 'independent',
  resources: [{ ref: TG, platform: 'telegram' }], playbook: pb, playbookVersion: 1, telegramFormats: ['text', 'photo'],
});
const nslot = (time: string, format: string, extra: Record<string, unknown> = {}) => ({ resource_ref: TG, time, format, topic: 'Тема поста про дорожні знаки', source_hints: [] as string[], ...extra });

test('validateNetworkPlan: a series slot is exempt from the section weights (quiz weight 0); an improvised unique slot is not', () => {
  const pb = playbook();
  const o = { net: net(pb), card, planDate: DATE, weekday: 3, now: NOW, ideas: new Map(), reservedAt: [] as Date[], schedule: { ...ctxOf(pb), checkSlotSeries: false } };
  const ok = validateNetworkPlan({ rationale: 'Квиз дня з білетів', slots: [nslot('12:00', 'quiz', { series: 'Білети ПДР' })] }, o);
  assert.equal(ok.ok, true, errorsOf(ok));
  const bad = validateNetworkPlan({ rationale: 'Квиз дня з білетів', slots: [nslot('12:00', 'quiz', { series: 'Білети ПДР' }), nslot('15:00', 'quiz', { directive_id: undefined, topic: 'Ще один квиз' })] }, o);
  assert.equal(bad.ok, false);
  assert.match(errorsOf(bad), /слот 2 .*формат quiz не дозволений плейбуком/);
  assert.ok(!/слот 1 .*не дозволений/.test(errorsOf(bad)));
});

// ── the playbook validator (A22) ─────────────────────────────────────────────────────────────

const RES = [{ ref: TG, platform: 'telegram' as const }];

test('validatePlaybook: a quiz series with quiz weight 0 and a card without quiz is accepted', () => {
  assert.deepEqual(validatePlaybook(playbook(), RES, ['text', 'photo']), []);
  // A weight-0 key the card lacks governs nothing.
  assert.deepEqual(validatePlaybook(playbook([QUIZ], { text: 1, quiz: 0, bogus_format: 0 }), RES, ['text', 'photo']), []);
});

test('validatePlaybook: a section key with weight above 0 that the card lacks is flagged, and the message names the card', () => {
  const errors = validatePlaybook(playbook([], { text: 1, quiz: 0.5 }), RES, ['text', 'photo']);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /формати quiz недоступні — у картці каналу їх немає/);
});

test('validatePlaybook: a series format the platform does not implement is flagged, one it implements is not', () => {
  const bad = playbook([{ ...QUIZ, format: 'th_text' }]);
  assert.match(validatePlaybook(bad, RES, ['text', 'photo']).join('\n'), /серія «Білети ПДР»: формат th_text недоступний для telegram/);
  assert.deepEqual(validatePlaybook(playbook([{ ...QUIZ, format: 'carousel' }]), RES, ['text', 'photo']), []);
});

// ── lint (A20) ───────────────────────────────────────────────────────────────────────────────

test('lint: lockedFormat keeps format_not_allowed from firing on a series or pin slot\'s own format, and only on that format', () => {
  const quiz = makeSpec({
    format: 'quiz', title: 'Квиз', origin: 'original', media: [], hashtags: [], source: undefined, body: [],
    poll: { question: 'Який знак означає «зупинка заборонена»?', options: ['Червоний круг із хрестом', 'Синій квадрат', 'Жовтий трикутник'], anonymous: true, correct_index: 0 },
  });
  const lintCard = makeCard({ formats: { text: 1, photo: 1 }, hashtags: [], hashtagMin: 0 });
  const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);
  assert.ok(codes(lintPost(quiz, lintCard)).includes('format_not_allowed'));
  assert.ok(!codes(lintPost(quiz, lintCard, { lockedFormat: 'quiz' })).includes('format_not_allowed'));
  assert.ok(codes(lintPost(quiz, lintCard, { lockedFormat: 'text' })).includes('format_not_allowed'), 'another locked format does not excuse this one');
});

// ── the tool results (A21) ───────────────────────────────────────────────────────────────────

function planDeps(pb: Playbook) {
  const created: any[] = [];
  const schedule: any = {
    planContext: async () => ctxOf(pb),
    effectiveCard: (c: unknown) => c,
  };
  const d: RoleToolDeps = {
    pool: { query: async () => ({ rows: [] }) } as any,
    plans: { createPlan: async (...a: any[]) => { created.push(a); return 'plan-1'; }, reservedSlots: async () => [] } as any,
    memory: {} as any, channels: {} as any, publisher: {} as any, recordPublish: () => {}, notifyPreview: async () => {},
    now: () => NOW, schedule,
  };
  const tool = buildRoleTools(d).find((t) => t.name === 'submit_plan')!;
  return { tool, created };
}

test('submit_plan: a series slot submitted in another format is saved in the series format, and the result names it', async () => {
  const pb = playbook();
  const { tool, created } = planDeps(pb);
  const c: any = { runId: 'r', role: 'planner', channelKey: CH, extras: { card, planDate: DATE } };
  const r: any = await tool.execute({ rationale: 'Квиз дня з білетів', slots: [slot('12:00', 'text', { series: 'Білети ПДР' })] } as any, c);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.format_locked, /слот 1 \(12:00, серія «Білети ПДР»\): text → quiz/);
  assert.equal(created[0][4][0].format, 'quiz', 'the stored slot has the series format');
});

test('submit_network_plan: the same lock on the network path', async () => {
  const pb = playbook();
  const created: any[] = [];
  const d: any = {
    repo: { listIdeas: async () => [], decidedElsewhere: async () => new Map() },
    plans: { reservedSlots: async () => [], createNetworkPlan: async (...a: any[]) => { created.push(a); return 'plan-1'; } },
    schedule: { planContext: async () => ({ ...ctxOf(pb), checkSlotSeries: false }), effectiveNet: (n: NetworkCtx) => n },
    pool: { query: async () => ({ rows: [] }) },
    now: () => NOW,
  };
  const tool = buildNetworkTools(d).find((t: any) => t.name === 'submit_network_plan')!;
  const c: any = { runId: 'r', role: 'planner', channelKey: CH, extras: { card, planDate: DATE, network: net(pb) } };
  const r: any = await tool.execute({ rationale: 'Квиз дня з білетів', slots: [nslot('12:00', 'text', { series: 'Білети ПДР' })] } as any, c);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.format_locked, /text → quiz/);
  assert.equal(created[0][4][0].format, 'quiz');
});

// ── the owner's series save (seriesProblems, A22) ────────────────────────────────────────────

test('prepareSeriesChange: a quiz series saves on a card without quiz (the series format only has to be implemented); an unknown format does not', async () => {
  const body = PlaybookSchema.parse({
    platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
    series: [{ name: 'Prompt of the day', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'A prompt with its picture each evening' }],
  });
  const scope = (): ScheduleScope => ({
    agent: { id: 'a-1', handle: 'pdr' } as any, card: { channelKey: CH } as any,
    net: { playbook: body, playbookVersion: 1, resources: [{ ref: TG, platform: 'telegram' }], telegramFormats: ['photo', 'text'] } as any,
  });
  const svc = new ScheduleService({ sourceCatalog: async () => ({ feeds: [], tables: [] }) } as any);
  const ok = await svc.prepareSeriesChange(scope(), 'update', { name: 'Prompt of the day', format: 'quiz' });
  assert.ok(!isFail(ok), JSON.stringify(ok));
  const bad = await svc.prepareSeriesChange(scope(), 'update', { name: 'Prompt of the day', format: 'th_text' });
  assert.ok(isFail(bad));
  assert.match(JSON.stringify(bad.details), /format th_text is not available on telegram:@pdr/);
});
