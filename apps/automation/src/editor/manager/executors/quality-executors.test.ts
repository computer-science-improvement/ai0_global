/** Spec 034 FR-006 (T4): voice_fix and format_mix — plan (dry-run), apply (idempotent), verify, directive_lock. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookSchema, MAX_PLAYBOOK_EXAMPLES, type Playbook } from '../../network/playbook';
import { audienceCaps } from '../../post/audience-asks';
import { assembleQuality, type ResourceQuality } from '../quality-digest';
import { checkBinding } from '../directive-kinds';
import {
  DirectiveExecution, formatMixExecutor, MANAGER_EXAMPLE_TAG, voiceFixExecutor, type ExecContext, type FormatMixChange, type VoiceFixChange,
} from '.';
import { holdsVoice, patchVoice, qualityImproved, revertsVoice } from './quality-executors';
import type { ObservedPlan } from './plan-observer';

const TG = 'telegram:@space';
const IG = 'instagram:42';
const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live', scope: 'resource', scopeId: TG } as any;
const CARD = { channelKey: '@space', mode: 'live', postsPerDayMin: 2, postsPerDayMax: 6, formats: { text: 1, photo: 0.6, poll: 0.5, quiz: 0.4 }, quietStartHour: 23, quietEndHour: 8 } as any;
const BODY = (): Playbook => PlaybookSchema.parse({
  platforms: [
    { resource_ref: TG, role: 'core', formats: { text: 1, photo: 0.6, poll: 0.5, quiz: 0.4 }, per_day: { min: 2, max: 5 }, format_reasons: { quiz: 'освітній канал' } },
    { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1, ig_carousel: 0.3 }, per_day: { min: 1, max: 2 } },
  ],
  rules: ['Без реклами казино'],
  examples: [{ format: 'text', text: 'Власницький приклад поста про зорі.', verdict: 'good', resource_ref: TG }],
});
const NOW = new Date('2026-10-20T09:00:00Z');
const DAY = 86_400_000;
const BAD_TEXT = 'Друзі, давайте розберемося, чому ця новина змінить усе! А ви як думаєте?';

const EVIDENCE = [
  { slotId: 'slot-owner', ref: TG, format: 'text', at: new Date(NOW.getTime() - DAY), source: 'owner' as const, note: 'штампи й зайве питання', text: BAD_TEXT },
  { slotId: 'slot-critic', ref: TG, format: 'photo', at: new Date(NOW.getTime() - 2 * DAY), source: 'critic' as const, note: 'жарт при вимкненому гуморі', text: 'Ха-ха, космос знову нас троліть, лол.' },
];

function ctx(o: { playbook?: Playbook | null; audience?: ExecContext['audience'] } = {}): ExecContext {
  const playbook = o.playbook === undefined ? BODY() : o.playbook;
  return {
    orch: ORCH, card: CARD, playbook, mode: 'live', now: NOW, evidence: EVIDENCE, audience: o.audience,
    net: {
      orchestrator: ORCH, anchorKey: '@space', groupId: 'g', groupName: 'Space', mode: 'independent', playbook, playbookVersion: 3,
      resources: [{ ref: TG, platform: 'telegram' }, { ref: IG, platform: 'instagram' }], telegramFormats: ['text', 'photo', 'poll', 'quiz'],
    } as any,
  };
}

function store(initial: Playbook | null = BODY()) {
  const versions: Array<{ id: string; version: number; body: Playbook; createdBy: string; directiveId: string | null }> = initial
    ? [{ id: 'p1', version: 1, body: initial, createdBy: 'owner', directiveId: null }] : [];
  let card = { ...CARD, formats: { ...CARD.formats } };
  let prefs: Record<string, unknown> = {};
  const patches: any[] = [];
  const plans: ObservedPlan[] = [];
  const windows: Array<[Date, Date]> = [];
  let qualityOf: (from: Date) => ResourceQuality = () => assembleQuality({ critic: [], posts: [], owner: [], caps: audienceCaps(null) });
  const network = {
    activePlaybook: async () => { const v = versions.at(-1); return v ? { ...v, agentId: 'o1', status: 'active' } as any : null; },
    applyDirectivePatch: async (_a: string, directiveId: string, patch: (b: Playbook) => Playbook | null) => {
      const v = versions.at(-1);
      if (!v) return { error: 'no_playbook' as const };
      const next = patch(v.body);
      if (!next) return { noop: true, row: v as any };
      const row = { id: `p${versions.length + 1}`, version: v.version + 1, body: PlaybookSchema.parse(next), createdBy: 'directive', directiveId };
      versions.push(row);
      return { noop: false, row: row as any };
    },
  };
  const channels = { get: async () => card, patchPlanning: async (_k: string, p: any) => { card = { ...card, ...(p.formats ? { formats: p.formats } : {}) }; return true; } };
  const profiles = {
    formatOf: async () => ({ prefs, locks: [], updatedAt: null }),
    patchFormat: async (ref: string, patch: Record<string, unknown>, meta: any) => {
      patches.push({ ref, patch, meta });
      if (Object.entries(patch).every(([k, v]) => prefs[k] === v)) return { error: 'no_change' as const };
      prefs = { ...prefs, ...patch };
      return { ok: true as const, version: patches.length, format_prefs: prefs as any, changed: Object.keys(patch) };
    },
  };
  const observer = {
    plans: async (_k: string, o: { after?: Date; before?: Date; limit: number }) =>
      (o.after ? plans.filter((p) => p.createdAt > o.after!) : plans.filter((p) => p.createdAt < o.before!).reverse()).slice(0, o.limit),
  };
  const quality = { window: async (_ref: string, from: Date, to: Date) => { windows.push([from, to]); return qualityOf(from); } };
  return {
    versions, plans, patches, windows, card: () => card, prefs: () => prefs,
    setQuality: (f: (from: Date) => ResourceQuality) => { qualityOf = f; },
    deps: { network, channels, profiles, quality, observer, now: () => clock.now } as any,
  };
}
const clock = { now: NOW };

const dir = (kind: any, params: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ id: '00000000-0000-4000-8000-0000000000bb', toAgentId: 'o1', kind, params, binding: 'advice', body: 'b', status: 'accepted', change: null, ...over }) as any;

// ── voice_fix ────────────────────────────────────────────────────────────────

test('voice_fix plan: rules (prefixed), bad examples from real rejected posts with the note, good examples slop-checked; not structural', () => {
  const ex = voiceFixExecutor(store().deps);
  const c = ex.plan(dir('voice_fix', {
    resource_ref: TG, rules: ['Без звертань «друзі» і без риторичних питань'], bad_slot_ids: ['slot-owner', 'slot-critic'],
    good_examples: [{ text: 'NASA показала нові знімки туманності Карина: телескоп зафіксував зорі, що ще формуються.', note: 'факт без прикрас' }],
  }), ctx()) as VoiceFixChange;
  assert.equal(c.op, 'voice_fix');
  assert.equal(c.structural, false, 'appended rules and examples are not structural');
  assert.deepEqual(c.rules, [`Голос (${TG}): Без звертань «друзі» і без риторичних питань`]);
  assert.equal(c.examples.length, 3);
  const [b1, b2, g] = c.examples;
  assert.deepEqual([b1.verdict, b1.text, b1.format, b1.resource_ref], ['bad', BAD_TEXT, 'text', TG]);
  assert.match(b1.note!, /^\[@manager\] Власник відхилив: штампи/);
  assert.match(b2.note!, /^\[@manager\] Критик: жарт/);
  assert.deepEqual([g.verdict, g.format], ['good', 'text']);
  assert.deepEqual(c.evidence_slots, ['slot-owner', 'slot-critic']);
  assert.match(c.reasons[0], /\+1 voice rule\(s\), \+2 bad \/ \+1 good/);
  // The matrix lets it be advice (non-structural).
  assert.equal(checkBinding('voice_fix', 'advice', c.structural), null);
});

test('voice_fix plan refusals: no playbook, unknown section, a post that was not rejected, slop / questions in a good example, nothing given, already held', () => {
  const ex = voiceFixExecutor(store().deps);
  const err = (p: Record<string, unknown>, c = ctx()) => (ex.plan(dir('voice_fix', p), c) as any);
  assert.match(err({ rules: ['Пиши фактами без прикметників'] }, ctx({ playbook: null })).details, /плейбука ще немає/);
  assert.match(err({ resource_ref: 'facebook:9', rules: ['Пиши фактами без прикметників'] }).details, /не в мережі/);
  const notRejected = err({ bad_slot_ids: ['slot-random'] });
  assert.equal(notRejected.error, 'not_executable');
  assert.match(notRejected.details, /slot-owner/, 'lists the posts it can quote');
  assert.match(err({ good_examples: [{ text: 'Давайте розберемося, чому це важливо для кожного з нас сьогодні.' }] }).details, /AI-штампи/);
  assert.match(err({ good_examples: [{ text: 'Нові знімки туманності. А ви бачили її в телескоп? А вам подобається?' }] }).details, /питань до читачів/);
  assert.match(err({ good_examples: [{ text: 'Нові знімки туманності Карина від телескопа.', format: 'longread' }] }).details, /формату longread немає/);
  assert.match(err({}).details, /вкажи rules/);
  assert.match(err({ rules: ['коротко'] }).details, /10–240/);
  const held = BODY();
  held.rules.push(`Голос (${TG}): Без звертань «друзі» і без риторичних питань`);
  assert.match(err({ rules: ['Без звертань «друзі» і без риторичних питань'] }, ctx({ playbook: held })).details, /вже є в плейбуку/);
});

test('voice_fix apply: a new playbook version by the directive; re-apply is a no-op; verify pending → improved / not followed / violated', async () => {
  const s = store();
  const ex = voiceFixExecutor(s.deps);
  const exec = new DirectiveExecution({
    repo: execRepo(), inbox: { post: async () => 1 }, agents: { get: async () => ORCH }, context: async () => ctx(), executors: [ex], now: () => clock.now,
  });
  const d = dir('voice_fix', { resource_ref: TG, rules: ['Без звертань «друзі» і без риторичних питань'], bad_slot_ids: ['slot-owner'] });
  const done = await exec.execute(d, ORCH);
  assert.equal(done?.status, 'applied');
  assert.equal(s.versions.length, 2);
  assert.equal(s.versions[1].createdBy, 'directive');
  const body = s.versions[1].body;
  assert.ok(body.rules.includes(`Голос (${TG}): Без звертань «друзі» і без риторичних питань`));
  assert.ok(body.rules.includes('Без реклами казино'), 'the owner rules stay');
  assert.equal(body.examples[0].verdict, 'bad', 'new examples first');
  assert.equal(body.examples[1].text, 'Власницький приклад поста про зорі.', 'the owner example stays');
  const change = (done as any).change as VoiceFixChange;
  const again = await ex.apply(change, d);
  assert.equal(again.noop, true);
  assert.equal(s.versions.length, 2, 'idempotent re-apply');

  const applied = { ...d, status: 'applied', change, appliedAt: NOW } as any;
  clock.now = new Date(NOW.getTime() + DAY);
  assert.equal((await ex.verify(applied) as any).pending, true, 'before 3 days');
  const bad = assembleQuality({ critic: [1, 2, 3, 4].map((i) => ({ slotId: `b${i}`, at: NOW, critic: { verdict: i < 3 ? 'revise' : 'pass', scores: null } })), posts: [], owner: [], caps: audienceCaps(null) });
  const good = assembleQuality({ critic: [1, 2, 3, 4].map((i) => ({ slotId: `g${i}`, at: NOW, critic: { verdict: 'pass', scores: null } })), posts: [], owner: [], caps: audienceCaps(null) });
  const none = assembleQuality({ critic: [], posts: [], owner: [], caps: audienceCaps(null) });
  clock.now = new Date(NOW.getTime() + 4 * DAY);
  s.setQuality((from) => (from < NOW ? bad : none));
  assert.equal((await ex.verify(applied) as any).pending, true, 'too few posts yet');
  s.setQuality((from) => (from < NOW ? bad : good));
  const v = await ex.verify(applied) as any;
  assert.deepEqual([v.verified, v.adherence], [true, 'followed']);
  assert.deepEqual([v.detail.before.pass_rate, v.detail.after.pass_rate], [0.5, 1]);
  s.setQuality(() => bad);
  assert.deepEqual([(await ex.verify(applied) as any).verified, (await ex.verify(applied) as any).adherence], [false, 'not_followed']);
  clock.now = new Date(NOW.getTime() + 11 * DAY);
  s.setQuality((from) => (from < NOW ? bad : none));
  assert.equal((await ex.verify(applied) as any).detail.reason, 'too few posts after the change');
  // The orchestrator removed the rule → violated (and directive_lock refuses such a body for a binding directive).
  s.versions.push({ id: 'p9', version: 9, body: { ...body, rules: ['Без реклами казино'] }, createdBy: 'orchestrator', directiveId: null });
  assert.equal((await ex.verify(applied) as any).adherence, 'violated');
  clock.now = NOW;
});

test('voice_fix examples: the directive\'s old examples make room; the owner\'s are never pushed out', () => {
  const owner = Array.from({ length: MAX_PLAYBOOK_EXAMPLES - 2 }, (_, i) => ({ format: 'text', text: `Власницький приклад номер ${i} про космос.`, verdict: 'good' as const }));
  const mine = [0, 1].map((i) => ({ format: 'text', text: `Старий приклад менеджера ${i} про зорі.`, verdict: 'bad' as const, note: `${MANAGER_EXAMPLE_TAG} Критик: штамп` }));
  const body = PlaybookSchema.parse({ ...BODY(), examples: [...mine, ...owner] });
  const fresh = [{ format: 'text', text: 'Новий поганий приклад: давайте розберемося.', verdict: 'bad' as const, note: `${MANAGER_EXAMPLE_TAG} Власник відхилив: штамп` }];
  const next = patchVoice(body, { rules: [], examples: fresh });
  assert.equal(next.examples.length, MAX_PLAYBOOK_EXAMPLES);
  assert.equal(next.examples[0].text, fresh[0].text);
  assert.equal(next.examples.filter((e) => e.note?.startsWith(MANAGER_EXAMPLE_TAG)).length, 2, 'one old manager example made room');
  assert.equal(owner.every((o) => next.examples.some((e) => e.text === o.text)), true);
  const full = PlaybookSchema.parse({ ...BODY(), examples: Array.from({ length: MAX_PLAYBOOK_EXAMPLES }, (_, i) => ({ format: 'text', text: `Власник ${i} пише про зорі.`, verdict: 'good' })) });
  assert.throws(() => patchVoice(full, { rules: [], examples: fresh }), /examples_full/);
  assert.equal(holdsVoice(next, { rules: [], examples: fresh }), true);
  assert.equal(revertsVoice(next, { rules: ['Голос: x'] }), true);
});

test('directive_lock: a binding voice_fix / format_mix change cannot be undone by the orchestrator before review', async () => {
  const vf: VoiceFixChange = { kind: 'voice_fix', op: 'voice_fix', target: 'playbook', channel_key: '@space', resource_ref: TG, rules: ['Голос (x): без штампів'], examples: [], evidence_slots: [], structural: false, reasons: [] };
  const fm: FormatMixChange = { kind: 'format_mix', op: 'format_mix', target: 'playbook', channel_key: '@space', resource_ref: TG, weights: [{ format: 'poll', before: 0.5, after: 0.1 }], drop: [], caps: {}, structural: false, reasons: [] };
  const locks = [{ id: 'l1', kind: 'voice_fix', change: vf, reviewAt: new Date(NOW.getTime() + 5 * DAY) }, { id: 'l2', kind: 'format_mix', change: fm, reviewAt: new Date(NOW.getTime() + 5 * DAY) }];
  const exec = new DirectiveExecution({ repo: { ...execRepo(), playbookLocks: async () => locks } as any, inbox: { post: async () => 1 }, agents: { get: async () => ORCH }, context: async () => ctx(), executors: [], now: () => NOW });
  const keep = PlaybookSchema.parse({ ...BODY(), rules: ['Голос (x): без штампів'], platforms: BODY().platforms.map((p) => (p.resource_ref === TG ? { ...p, formats: { ...p.formats, poll: 0.1 } } : p)) });
  assert.equal(await exec.lockFor('o1', keep), null);
  assert.match((await exec.lockFor('o1', { ...keep, rules: [] }))!.details, /voice/);
  const raised = { ...keep, platforms: keep.platforms.map((p) => (p.resource_ref === TG ? { ...p, formats: { ...p.formats, poll: 0.6 } } : p)) };
  assert.match((await exec.lockFor('o1', raised))!.details, /poll/);
});

test('qualityImproved: +10 points pass rate, fewer owner rejections, or clean after a bad week', () => {
  const q = (pass: number, revise: number, rejected = 0, approved = 0) => assembleQuality({
    critic: [...Array.from({ length: pass }, (_, i) => ({ slotId: `p${i}`, at: NOW, critic: { verdict: 'pass' } })), ...Array.from({ length: revise }, (_, i) => ({ slotId: `r${i}`, at: NOW, critic: { verdict: 'revise' } }))],
    posts: [], caps: audienceCaps(null),
    owner: [...Array.from({ length: rejected }, (_, i) => ({ slotId: `x${i}`, at: NOW, outcome: 'rejected' as const, reason: 'r', edit: null })), ...Array.from({ length: approved }, (_, i) => ({ slotId: `a${i}`, at: NOW, outcome: 'clean' as const, reason: null, edit: null }))],
  });
  assert.equal(qualityImproved(q(2, 2), q(3, 1)), true);
  assert.equal(qualityImproved(q(3, 1), q(3, 1)), false);
  assert.equal(qualityImproved(q(4, 0, 2, 2), q(4, 0, 1, 3)), true);
  assert.equal(qualityImproved(q(0, 0, 1, 0), q(3, 0, 0, 2)), true, 'clean after a rejection');
});

// ── format_mix ───────────────────────────────────────────────────────────────

test('format_mix plan: only lower; poll weight cut is not structural; a drop from a playbook section is structural; on a card it is not', () => {
  const ex = formatMixExecutor(store().deps);
  const plan = (p: Record<string, unknown>, c = ctx()) => ex.plan(dir('format_mix', p), c) as any;
  const cut = plan({ resource_ref: TG, weights: { poll: 0.1 } }) as FormatMixChange;
  assert.deepEqual([cut.target, cut.weights, cut.structural], ['playbook', [{ format: 'poll', before: 0.5, after: 0.1 }], false]);
  const drop = plan({ resource_ref: TG, drop: ['quiz'] }) as FormatMixChange;
  assert.deepEqual([drop.drop, drop.structural], [['quiz'], true]);
  assert.match(drop.reasons[0], /drop quiz/);
  assert.equal(checkBinding('format_mix', 'advice', drop.structural)?.error, 'structural_must_be_directive', 'a structural drop must be a directive (owner)');
  const card = plan({ drop: ['quiz'], weights: { poll: 0.2 } }, ctx({ playbook: null })) as FormatMixChange;
  assert.deepEqual([card.target, card.structural, card.drop], ['card', false, ['quiz']]);
  const caps = plan({ resource_ref: IG, polls_per_week: 0, questions_to_readers_per_day: 0 }) as FormatMixChange;
  assert.deepEqual([caps.target, caps.caps], ['resource', { polls_per_week: { before: 1, after: 0 }, questions_to_readers_per_day: { before: 1, after: 0 } }]);
  assert.match(plan({ weights: { poll: 0.7 } }).details, /лише знижує вагу/);
  assert.match(plan({ polls_per_week: 2 }).details, /підвищити може лише власник/);
  assert.match(plan({ polls_per_week: 1 }).details, /лише знижує ліміт/, 'equal to the current cap is not a cut');
  assert.match(plan({ polls_per_week: 0 }, ctx({ audience: { [TG]: { caps: audienceCaps(null), locks: ['polls_per_week'] } } })).details, /заблокував власник/);
  assert.match(plan({ weights: { longread: 0 } }).details, /формату longread немає/);
  assert.match(plan({ resource_ref: IG, drop: ['ig_photo', 'ig_carousel'] }).details, /хоча б один формат/);
  assert.match(plan({}).details, /лише зниження/);
});

test('format_mix apply: playbook / card / caps; re-apply is a no-op; raising a cap is refused by the profile too', async () => {
  const s = store();
  const ex = formatMixExecutor(s.deps);
  const d = dir('format_mix', {});
  const pb = ex.plan(dir('format_mix', { resource_ref: TG, weights: { poll: 0.1 }, polls_per_week: 0 }), ctx()) as FormatMixChange;
  const a1 = await ex.apply(pb, d);
  assert.equal(a1.noop, false);
  assert.equal(s.versions.at(-1)!.body.platforms[0].formats.poll, 0.1);
  assert.equal(s.prefs().polls_per_week, 0);
  assert.equal(s.patches[0].meta.by, 'agent', 'caps are written as an agent change (owner-only raises are refused by the repository)');
  const a2 = await ex.apply(pb, d);
  assert.equal(a2.noop, true);
  assert.equal(s.versions.length, 2);
  assert.equal(s.patches.length, 1, 'the cap is not written again');

  const drop = ex.plan(dir('format_mix', { resource_ref: TG, drop: ['quiz'] }), ctx()) as FormatMixChange;
  await ex.apply(drop, d);
  const sec = s.versions.at(-1)!.body.platforms[0];
  assert.equal('quiz' in sec.formats, false);
  assert.equal(sec.format_reasons?.quiz, undefined, 'the dropped format\'s reason goes too');

  const c = store(null);
  const cx = formatMixExecutor(c.deps);
  const onCard = cx.plan(dir('format_mix', { drop: ['quiz'], weights: { poll: 0.2 } }), ctx({ playbook: null })) as FormatMixChange;
  assert.equal((await cx.apply(onCard, d)).noop, false);
  assert.deepEqual(c.card().formats, { text: 1, photo: 0.6, poll: 0.2 });
  assert.equal((await cx.apply(onCard, d)).noop, true);
});

test('format_mix verify: a dropped format planned again → violated; polls over the new cap → violated; share fell → followed', async () => {
  const s = store();
  const ex = formatMixExecutor(s.deps);
  const change: FormatMixChange = {
    kind: 'format_mix', op: 'format_mix', target: 'playbook', channel_key: '@space', resource_ref: TG,
    weights: [{ format: 'poll', before: 0.5, after: 0.1 }, { format: 'quiz', before: 0.4, after: 0 }], drop: ['quiz'],
    caps: { polls_per_week: { before: 1, after: 0 } }, structural: true, reasons: [],
  };
  const applied = dir('format_mix', {}, { status: 'applied', change, appliedAt: NOW });
  const plan = (day: number, formats: string[]): ObservedPlan => ({
    planDate: `2026-10-${20 + day}`, createdAt: new Date(NOW.getTime() + day * DAY + (day < 0 ? -1 : 1)),
    slots: formats.map((f) => ({ ref: TG, format: f, series: null, status: 'planned' })),
  });
  s.plans.push(plan(-2, ['poll', 'text']), plan(-1, ['poll', 'text']), plan(1, ['text', 'photo']));
  assert.equal((await ex.verify(applied) as any).pending, true);
  s.plans.push(plan(2, ['text']), plan(3, ['photo']));
  const ok = await ex.verify(applied) as any;
  assert.deepEqual([ok.verified, ok.adherence], [true, 'followed']);
  s.plans.splice(3, 1, plan(2, ['quiz']));
  assert.equal((await ex.verify(applied) as any).adherence, 'violated');
  s.plans.splice(3, 1, plan(2, ['poll']));
  const capped = await ex.verify(applied) as any;
  assert.deepEqual([capped.adherence, capped.detail.polls_per_week], ['violated', 0]);
});

/** A minimal directives repository for DirectiveExecution (execute / lockFor). */
function execRepo() {
  const rows = new Map<string, any>();
  return {
    get: async (id: string) => rows.get(id) ?? null,
    setChange: async (id: string, change: unknown) => { rows.set(id, { ...(rows.get(id) ?? { id }), change }); },
    markApplied: async (id: string, p: any) => { const r = { ...(rows.get(id) ?? { id }), status: 'applied', ...(p.change ? { change: p.change } : {}) }; rows.set(id, r); return r; },
    execFailed: async () => 1, markFailed: async () => null, acceptedForExecution: async () => [], awaitingVerification: async () => [],
    setVerification: async () => {}, dueSeriesResumes: async () => [], mergeChange: async () => {}, playbookLocks: async () => [], update: async () => null,
  } as any;
}
